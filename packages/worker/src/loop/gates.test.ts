import { expect, test, vi } from 'vitest';
import {
  LOOP_POLICY_VERSION, LOOP_TYPE_INFO, resetLoopBreaker, seedLoopSettings, suppress, utcDay, writeLoopBudget, writeLoopSettings,
  type DecisionTarget, type DecisionType, type Lesson, type LoopConfig, type LoopSettings, type StoredFact,
} from '@fb/core';
import { runLoopRound, type LoopEngineDeps } from './engine.ts';
import type { LoopExecutor } from './executor.ts';
import type { LoopCandidate, LoopType } from './plugin.ts';
import { memoryStore } from './testing/memoryStore.ts';

/**
 * Every gate between a call the loop found and its applying it on its own, one row each: the mode and its caps
 * (LOOP_DISABLED, pause, tokenless), the tier bars (H, A with τ, tauRaise, minLabels; P), the daily caps, the circuit
 * breaker and its reset, suppression, proposeOnly, and the never-target and owner-touched rules checked again at apply
 * time. Default mode: auto.
 */

const T0 = Date.parse('2026-11-11T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const config = (o: Partial<LoopConfig> = {}): LoopConfig => ({
  mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0.2, types: null, ...o,
});

type Mem = ReturnType<typeof memoryStore>;
type Row = {
  gate: string;
  type: DecisionType;
  call?: Partial<LoopCandidate>;
  target?: DecisionTarget;
  setup?: (m: Mem) => Promise<unknown>;
  deps?: Partial<LoopEngineDeps>;
  /** Pause the loop after the type found its call, before the engine applies it. */
  pauseMidRound?: boolean;
  /** applied / proposed / observed: the decision's status; `skip:<reason>`: no decision; none: no round. */
  expect: 'applied' | 'proposed' | 'observed' | `skip:${string}` | 'none';
  /** Proposed: the reason added to its rationale. */
  why?: string;
};

const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: 't', rule: 'r', appliesWhen: 'a', scope: 'project', paths: [], status: 'proposed', source: 'postmortem',
  cause: null, missId: null, createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null, ...o,
});
const fact = (id: string, o: Partial<StoredFact> = {}) => ({ id, origin: 'model', source: 'ollama:x', relevanceBy: 'model', ...o }) as StoredFact;
const settings = (m: Mem, o: Partial<LoopSettings>) => writeLoopSettings(m.cursors, { ...seedLoopSettings({ mode: null }), ...o });
/** n owner labels in the type's top band, all kept (or all rolled back). */
const earn = (m: Mem, type: DecisionType, n: number, kept = true, labels = n) => m.store.decisions.bumpCalibration({
  type, band: 4, policyVersion: LOOP_POLICY_VERSION, prior: LOOP_TYPE_INFO[type].prior, alpha: kept ? n : 0, beta: kept ? 0 : n, n: labels,
});
const rolledBack = (m: Mem, id: string, type: DecisionType, at: number) => m.decisions.set(id, {
  id, type, status: 'rolled_back', appliedAt: iso(at - DAY), createdAt: iso(at - DAY), decidedAt: iso(at), targets: [], dependsOn: [],
  rollback: { at: iso(at), by: 'you', reason: null, note: null, cascade: [] },
} as never);
const touched = (m: Mem, id: string, at: number) => m.store.decisions.upsertSignals([{ lessonId: id, counts: {} as never, lastServed: null, lastOwnerTouch: iso(at) }]);

const ROWS: Row[] = [
  // Mode and its caps.
  { gate: 'LOOP_DISABLED=1: no round', type: 'link_misses', deps: { config: config({ disabled: true }) }, expect: 'none' },
  { gate: 'paused: no round', type: 'link_misses', setup: (m) => settings(m, { paused: { at: 't', by: 'you' } }), expect: 'none' },
  { gate: 'paused after the call was found: checked again before the apply', type: 'link_misses', pauseMidRound: true, expect: 'proposed' },
  { gate: 'tokenless: auto capped at observe', type: 'link_misses', deps: { tokenless: true }, expect: 'observed' },
  { gate: 'global mode observe', type: 'link_misses', setup: (m) => settings(m, { mode: 'observe' }), expect: 'observed' },
  { gate: 'global mode propose', type: 'link_misses', setup: (m) => settings(m, { mode: 'propose' }), expect: 'proposed' },
  { gate: 'the type held at propose under global auto', type: 'link_misses', setup: (m) => settings(m, { types: { link_misses: { mode: 'propose', tau: null } } }), expect: 'proposed' },
  { gate: 'LOOP_TYPES leaves the type out', type: 'link_misses', deps: { config: config({ types: ['rank_weight'] }) }, expect: 'skip:none' },

  // Tier H: applies on its own from its prior; loses that with rollbacks.
  { gate: 'tier H, cold start: auto', type: 'link_misses', expect: 'applied' },
  { gate: 'tier H, its band rolled back: lower bound under τ', type: 'link_misses', setup: (m) => earn(m, 'link_misses', 20, false), expect: 'proposed' },

  // Tier A: only once earned from 20 of your own reviews, over τ.
  { gate: 'tier A, cold start (Beta(1,4))', type: 'approve_lesson', expect: 'proposed' },
  { gate: 'tier A, earned', type: 'approve_lesson', setup: (m) => earn(m, 'approve_lesson', 150), expect: 'applied' },
  { gate: 'tier A, lower bound high but under 20 labels', type: 'approve_lesson', setup: (m) => earn(m, 'approve_lesson', 150, true, 19), expect: 'proposed' },
  { gate: 'tier A, earned, but the call raises τ over it', type: 'reword_lesson', call: { tauRaise: 0.11 }, setup: (m) => earn(m, 'reword_lesson', 150), expect: 'proposed' },
  { gate: 'tier A, earned, the owner raised τ', type: 'approve_lesson', setup: async (m) => { await earn(m, 'approve_lesson', 150); await settings(m, { types: { approve_lesson: { mode: null, tau: 0.995 } } }); }, expect: 'proposed' },
  { gate: 'tier A, earned, today\'s global cap used', type: 'approve_lesson', setup: async (m) => { await earn(m, 'approve_lesson', 150); await writeLoopBudget(m.cursors, { day: utcDay(T0), llmCalls: 0, auto: 5, autoByProject: {} }); }, expect: 'proposed', why: 'cap' },
  { gate: 'tier A, earned, today\'s cap for the project used', type: 'approve_lesson', setup: async (m) => { await earn(m, 'approve_lesson', 150); await writeLoopBudget(m.cursors, { day: utcDay(T0), llmCalls: 0, auto: 2, autoByProject: { demo: 2 } }); }, expect: 'proposed', why: 'cap' },
  { gate: 'tier A, earned, yesterday\'s caps do not count', type: 'approve_lesson', setup: async (m) => { await earn(m, 'approve_lesson', 150); await writeLoopBudget(m.cursors, { day: utcDay(T0 - DAY), llmCalls: 0, auto: 5, autoByProject: { demo: 2 } }); }, expect: 'applied' },
  // Tier P.
  { gate: 'tier P never applies on its own', type: 'tune_threshold', setup: (m) => earn(m, 'tune_threshold', 150), expect: 'proposed' },

  // The breaker.
  { gate: 'breaker: two rollbacks in 7 days', type: 'link_misses', setup: async (m) => { rolledBack(m, 'dec:r1', 'link_misses', T0 - 3 * DAY); rolledBack(m, 'dec:r2', 'link_misses', T0 - DAY); }, expect: 'proposed' },
  { gate: 'breaker: three of three applied rolled back, weeks apart', type: 'link_misses', setup: async (m) => { for (const d of [10, 20, 30]) rolledBack(m, `dec:r${d}`, 'link_misses', T0 - d * DAY); }, expect: 'proposed' },
  { gate: 'breaker: one other type\'s rollbacks do not count', type: 'link_misses', setup: async (m) => { rolledBack(m, 'dec:r1', 'merge_duplicates', T0 - 3 * DAY); rolledBack(m, 'dec:r2', 'merge_duplicates', T0 - DAY); }, expect: 'applied' },
  {
    gate: 'breaker: reset by the owner, the rollbacks before it do not trip it again', type: 'link_misses',
    setup: async (m) => { rolledBack(m, 'dec:r1', 'link_misses', T0 - 3 * DAY); rolledBack(m, 'dec:r2', 'link_misses', T0 - DAY); await resetLoopBreaker(m.cursors, 'link_misses', T0 - 3_600_000); },
    expect: 'applied',
  },

  // Suppression and the type's own proposeOnly.
  { gate: 'suppressed after a rollback', type: 'link_misses', setup: (m) => suppress(m.cursors, 'link_misses', [{ id: 'lesson:t' }], 1, T0 - DAY), expect: 'skip:suppressed' },
  { gate: 'suppression lifted: the evidence grew by half', type: 'link_misses', call: { evidence: [1, 2].map((i) => ({ kind: 'lesson' as const, id: `lesson:e${i}`, role: 'r', weight: 1, observedAt: 't' })) }, setup: (m) => suppress(m.cursors, 'link_misses', [{ id: 'lesson:t' }], 1, T0 - DAY), expect: 'applied' },
  { gate: 'the type proposes only', type: 'link_misses', call: { proposeOnly: 'both lessons are approved' }, expect: 'proposed' },

  // Never targets and the owner's recent changes, checked again on the targets as they are at apply time.
  { gate: 'apply time: the lesson is one you wrote', type: 'link_misses', setup: async (m) => m.lessons.set('lesson:t', lesson('lesson:t', { source: 'manual' })), expect: 'proposed', why: 'written by you' },
  { gate: 'apply time: the lesson may hold a secret', type: 'link_misses', setup: async (m) => m.lessons.set('lesson:t', lesson('lesson:t', { checks: [{ name: 'may-hold-secret', why: 'w' }] })), expect: 'proposed', why: 'may hold a secret' },
  { gate: 'apply time: the lesson is a run\'s', type: 'link_misses', setup: async (m) => m.lessons.set('lesson:t', lesson('lesson:t', { run: 'r1' })), expect: 'proposed', why: 'made in a run' },
  { gate: 'apply time: the lesson is the demo\'s', type: 'link_misses', setup: async (m) => m.lessons.set('lesson:t', lesson('lesson:t', { source: 'demo' })), expect: 'proposed', why: 'demo' },
  { gate: 'apply time: you decided the lesson 2 days ago (not folded yet)', type: 'link_misses', setup: async (m) => m.lessons.set('lesson:t', lesson('lesson:t', { decidedBy: 'you', decidedAt: iso(T0 - 2 * DAY) })), expect: 'proposed', why: 'in the last 14 days' },
  { gate: 'apply time: an operator decided it 2 days ago', type: 'link_misses', setup: async (m) => m.lessons.set('lesson:t', lesson('lesson:t', { decidedBy: 'operator:ci', decidedAt: iso(T0 - 2 * DAY) })), expect: 'proposed', why: 'in the last 14 days' },
  { gate: 'apply time: you edited it 3 days ago (signals)', type: 'link_misses', setup: async (m) => { m.lessons.set('lesson:t', lesson('lesson:t')); await touched(m, 'lesson:t', T0 - 3 * DAY); }, expect: 'proposed', why: 'in the last 14 days' },
  { gate: 'apply time: you decided it 20 days ago, the loop 2 days ago', type: 'link_misses', setup: async (m) => { m.lessons.set('lesson:t', lesson('lesson:t', { decidedBy: 'loop:1', decidedAt: iso(T0 - 2 * DAY) })); await touched(m, 'lesson:t', T0 - 20 * DAY); }, expect: 'applied' },
  { gate: 'apply time: a fact you wrote', type: 'record_fact', target: { kind: 'fact', id: 'fact:t', role: 'primary' }, setup: async (m) => { await earn(m, 'record_fact', 150); m.facts.set('fact:t', fact('fact:t', { origin: 'you' })); }, expect: 'proposed', why: 'written by you' },
  { gate: 'apply time: a fact whose relevance you set', type: 'rank_weight', target: { kind: 'fact', id: 'fact:t', role: 'primary' }, setup: async (m) => m.facts.set('fact:t', fact('fact:t', { relevanceBy: 'you' })), expect: 'proposed', why: 'relevance' },
  { gate: 'apply time: a fact whose relevance an operator set', type: 'rank_weight', target: { kind: 'fact', id: 'fact:t', role: 'primary' }, setup: async (m) => m.facts.set('fact:t', fact('fact:t', { relevanceBy: 'operator:ci' })), expect: 'proposed', why: 'relevance' },
  { gate: 'apply time: the demo\'s fact', type: 'rank_weight', target: { kind: 'fact', id: 'fact:t', role: 'primary' }, setup: async (m) => m.facts.set('fact:t', fact('fact:t', { source: 'demo' })), expect: 'proposed', why: 'demo' },
  { gate: 'apply time: a fact the model scored', type: 'rank_weight', target: { kind: 'fact', id: 'fact:t', role: 'primary' }, setup: async (m) => m.facts.set('fact:t', fact('fact:t')), expect: 'applied' },
  { gate: 'apply time: a fact the decision creates (none yet)', type: 'record_fact', target: { kind: 'fact', id: 'fact:new', role: 'created' }, setup: (m) => earn(m, 'record_fact', 150), expect: 'applied' },
  { gate: 'apply time: the demo\'s miss', type: 'link_misses', target: { kind: 'miss', id: 'miss:demo:demo:x', role: 'primary' }, expect: 'proposed', why: 'demo' },
];

test.each(ROWS)('$gate: $expect', async (row) => {
  let now = T0;
  const m = memoryStore(() => now);
  await row.setup?.(m);
  const target = row.target ?? { kind: 'lesson', id: 'lesson:t', role: 'primary' };
  const call: LoopCandidate = {
    projectKey: 'demo', targets: [target], before: [], after: [],
    evidence: [{ kind: 'lesson', id: 'lesson:e0', role: 'r', weight: 1, observedAt: 't' }], features: {}, subject: 'the call', rationale: 'because', ...row.call,
  };
  const type: LoopType = {
    type: row.type, weights: { bias: 4 },
    candidates: async () => {
      if (row.pauseMidRound) await settings(m, { paused: { at: 't', by: 'you' } });
      return { candidates: [call], scanned: 1, skipped: {} };
    },
  };
  const executor: LoopExecutor & { apply: ReturnType<typeof vi.fn> } = {
    apply: vi.fn(async (d, o) => {
      await m.store.decisions.markApplying(d.id);
      await m.store.decisions.markApplied(d.id, d.after, { syncHoldUntil: o.syncHoldUntil });
      await m.store.decisions.markStatus(d.id, { status: 'applied', from: ['applied'], by: o.by });
      return { status: 'applied' as const, decision: (await m.store.decisions.get(d.id))! };
    }),
    changed: async () => null,
  };
  const result = await runLoopRound({
    store: m.store, cursors: m.cursors, config: config(), tokenless: false, inScope: () => true, executor, llm: null, now: () => now, log: () => {},
    types: [type], ...row.deps,
  });
  now += 1;
  const made = [...m.decisions.values()].filter((d) => d.targets.some((t) => t.id === target.id));

  if (row.expect === 'none') {
    expect(result.round).toBeNull();
    expect(made).toEqual([]);
    return;
  }
  if (row.expect.startsWith('skip:')) {
    expect(made).toEqual([]);
    const reason = row.expect.slice(5);
    if (reason !== 'none') expect(result.round?.skipped).toContainEqual({ reason, count: 1 });
    expect(executor.apply).not.toHaveBeenCalled();
    return;
  }
  expect(made.map((d) => d.status)).toEqual([row.expect]);
  expect(executor.apply).toHaveBeenCalledTimes(row.expect === 'applied' ? 1 : 0);
  if (row.why) expect(made[0].rationale).toContain(row.why);
  if (row.expect === 'applied') {
    // Applied on its own: by the loop; one that changes what agents are told is held back from cloud sync.
    expect(made[0]).toMatchObject({ mode: 'auto', decidedBy: 'loop:1' });
    expect(executor.apply.mock.calls[0][1]).toEqual({ by: 'loop:1', syncHoldUntil: target.kind === 'miss' ? null : iso(T0 + 7 * DAY) });
  } else if (!row.pauseMidRound) {
    // Recorded as what it is (a decision made for auto and stopped by a pause keeps mode auto, decided by no one).
    expect(made[0].mode).not.toBe('auto');
  }
});

test('a tripped breaker is logged once, by loop:breaker, as a settings change holding the type at propose', async () => {
  const m = memoryStore(() => T0);
  rolledBack(m, 'dec:r1', 'link_misses', T0 - 3 * DAY);
  rolledBack(m, 'dec:r2', 'link_misses', T0 - DAY);
  const type: LoopType = { type: 'link_misses', weights: { bias: 4 }, candidates: async () => ({ candidates: [], scanned: 0, skipped: {} }) };
  const d = { store: m.store, cursors: m.cursors, config: config(), tokenless: false, inScope: () => true, executor: { apply: vi.fn(), changed: vi.fn() }, llm: null, now: () => T0, log: () => {}, types: [type] };
  await runLoopRound(d);
  await runLoopRound(d);
  expect(m.log.filter((e) => e.kind === 'loop_settings_changed')).toEqual([
    expect.objectContaining({ actor: 'loop:breaker', details: expect.objectContaining({ decisionType: 'link_misses', mode: 'propose' }) }),
  ]);
});
