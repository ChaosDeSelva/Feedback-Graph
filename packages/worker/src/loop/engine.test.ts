import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  inHoldout, LESSON_SIGNAL_COUNTS, lessonSnapshot, LOOP_POLICY_VERSION, LOOP_TYPE_INFO, missLinkSnapshot, readLoopBreaker, readLoopRound, readLoopRounds, suppress, writeLoopBreaker, writeLoopSettings,
  seedLoopSettings, type JsonTask, type LessonDetail, type LessonSignals, type LlmProvider, type LoopConfig, type LoopSettings,
} from '@fb/core';
import { LoopBudgetSpent } from './budget.ts';
import { checkBreaker, LOOP_ACTIVITY_CURSOR, LOOP_SWEEP, runLoopRound, type LoopEngineDeps } from './engine.ts';
import type { LoopExecutor } from './executor.ts';
import { decisionsStoreExecutor } from './testing/memoryExecutor.ts';
import { primaryOf, type LoopCandidate, type LoopType } from './plugin.ts';
import { linkMisses } from './types/link_misses.ts';
import { axis, loopMiss } from './testing/context.ts';
import { lesson } from './testing/lessons.ts';
import { retireLesson } from './types/retire_lesson.ts';
import { rewordLesson } from './types/reword_lesson.ts';
import { memoryStore } from './testing/memoryStore.ts';

const T0 = Date.parse('2026-11-11T12:00:00Z');
/** No holdout unless a test asks for one, so which test lessons the hash holds out never decides a gate's test. */
const config = (o: Partial<LoopConfig> = {}): LoopConfig => ({
  mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0, types: null, ...o,
});

let now: number;
let mem: ReturnType<typeof memoryStore>;
beforeEach(() => {
  now = T0 - 60_000;
  mem = memoryStore(() => now);
});

function deps(o: Partial<LoopEngineDeps> = {}): LoopEngineDeps {
  return {
    store: mem.store, cursors: mem.cursors, config: config(), tokenless: false, inScope: (k) => k !== 'elsewhere',
    // link_misses only: the in-memory store models misses, not lessons (each type has its own tests).
    types: [linkMisses], executor: decisionsStoreExecutor(mem.store.decisions), llm: null, now: () => now, log: () => {}, ...o,
  };
}
const setMode = (mode: LoopSettings['mode'], o: Partial<LoopSettings> = {}) => writeLoopSettings(mem.cursors, { ...seedLoopSettings({ mode }), ...o });

/** Two misses of demo that repeat (an older one and a new one a post-mortem just saved). */
async function repeatSeeded(o: { sandbox?: boolean } = {}) {
  mem.misses.set('miss:old', loopMiss('miss:old', { createdAt: '2026-10-01T00:00:00.000Z' }));
  mem.misses.set('miss:new', loopMiss('miss:new', { createdAt: '2026-11-10T00:00:00.000Z' }));
  await mem.record({ kind: 'postmortem_done', actor: 'pm', projectKey: 'demo', subject: 'missed', why: '', targets: ['new', 'miss:new'], ...(o.sandbox && { sandbox: true, run: 'r1' }) });
  now = T0;
}
const loopEntries = () => mem.log.filter((e) => e.actor.startsWith('loop:'));

describe('modes', () => {
  test('off, disabled or paused: no round at all', async () => {
    await repeatSeeded();
    await setMode('off');
    expect(await runLoopRound(deps())).toEqual({ round: null, more: false });
    await setMode('auto', { paused: { at: 't', by: 'you' } });
    expect((await runLoopRound(deps())).round).toBeNull();
    await setMode('auto');
    expect((await runLoopRound(deps({ config: config({ disabled: true }) }))).round).toBeNull();
    expect(mem.decisions.size).toBe(0);
    expect(await readLoopRound(mem.cursors)).toBeNull();
  });

  test('observe: the call is recorded observed, logged, and the round says so; nothing is applied', async () => {
    await repeatSeeded();
    await setMode('observe');
    const { round, more } = await runLoopRound(deps());
    expect(more).toBe(false);
    expect(round).toMatchObject({ phase: 'done', signalsIngested: 1, targetsScored: 1, decisions: { observed: 1, proposed: 0, applied: 0, skipped: 0 }, error: null });
    const [d] = mem.decisions.values();
    expect(d).toMatchObject({
      type: 'link_misses', status: 'observed', mode: 'observe', tier: 'H', policyVersion: LOOP_POLICY_VERSION, model: 'deterministic',
      targets: [{ kind: 'miss', id: 'miss:new', role: 'primary' }, { kind: 'miss', id: 'miss:old', role: 'keeper' }],
      confidence: { n: 0, band: expect.any(Number) },
    });
    expect(d.score).toBeGreaterThan(0.5);
    expect(mem.links).toEqual([]);
    expect(loopEntries()).toEqual([expect.objectContaining({
      kind: 'decision_made', actor: 'loop:1', projectKey: 'demo', targets: [d.id, 'miss:new', 'miss:old'],
      details: expect.objectContaining({ decisionId: d.id, decisionType: 'link_misses', status: 'observed', action: 'observed' }),
    })]);
    expect(loopEntries()[0].subject).toMatch(/^link misses observed: miss "missed miss:new" repeats/);
    const ring = await readLoopRounds(mem.cursors);
    expect(ring.rounds.map((r) => r.round.phase)).toEqual(['done']);
    expect(ring.seq).toBe(4);
  });

  test('idempotence: a second round over the same data makes no new decision, nor does reading the log again from the start', async () => {
    await repeatSeeded();
    await setMode('observe');
    await runLoopRound(deps());
    const entries = mem.log.length;
    const second = await runLoopRound(deps());
    expect(second.round).toMatchObject({ signalsIngested: 0, targetsScored: 0, decisions: { observed: 0, proposed: 0, applied: 0 } });
    mem.raw.delete(LOOP_ACTIVITY_CURSOR);
    const again = await runLoopRound(deps());
    expect(again.round).toMatchObject({ targetsScored: 1, decisions: { observed: 0, proposed: 0, applied: 0, skipped: 1 }, skipped: [{ reason: 'already_decided', count: 1 }] });
    expect(mem.decisions.size).toBe(1);
    expect(mem.log.length).toBe(entries);
  });

  test('propose: a proposal', async () => {
    await repeatSeeded();
    await setMode('propose');
    expect((await runLoopRound(deps())).round?.decisions).toMatchObject({ proposed: 1 });
    expect([...mem.decisions.values()][0]).toMatchObject({ status: 'proposed', mode: 'propose' });
  });

  test('auto: housekeeping applies on its own through the executor, logged as applied, with no sync hold (agents are not affected)', async () => {
    await repeatSeeded();
    await setMode('auto');
    expect((await runLoopRound(deps())).round?.decisions).toMatchObject({ applied: 1 });
    const [d] = mem.decisions.values();
    expect(d).toMatchObject({ status: 'applied', mode: 'auto', syncHoldUntil: null, after: [missLinkSnapshot('miss:new', 'miss:old', true)] });
    expect(mem.links).toEqual([expect.objectContaining({ from: 'miss:new', to: 'miss:old', decisionId: d.id })]);
    expect(loopEntries().map((e) => [e.kind, e.details.action, e.details.status])).toEqual([['decision_applied', 'applied', 'applied']]);
  });

  test('tokenless: auto is capped at observe', async () => {
    await repeatSeeded();
    await setMode('auto');
    await runLoopRound(deps({ tokenless: true }));
    expect([...mem.decisions.values()][0].status).toBe('observed');
  });

  test('LOOP_TYPES leaving the type out, or its own mode off: it does not run', async () => {
    await repeatSeeded();
    await setMode('auto', { types: { link_misses: { mode: 'off', tau: null } } });
    expect((await runLoopRound(deps())).round?.targetsScored).toBe(0);
    await setMode('auto');
    expect((await runLoopRound(deps({ config: config({ types: ['rank_weight'] }) }))).round?.targetsScored).toBe(0);
  });

  test('sandbox and run entries are never read', async () => {
    await repeatSeeded({ sandbox: true });
    await setMode('auto');
    expect((await runLoopRound(deps())).round).toMatchObject({ signalsIngested: 0, targetsScored: 0 });
  });
});

describe('an observed call when the type moves on', () => {
  test('to auto: applied; to propose: proposed by the loop', async () => {
    await repeatSeeded();
    await setMode('observe');
    await runLoopRound(deps());
    await setMode('propose');
    mem.raw.delete(LOOP_ACTIVITY_CURSOR);
    expect((await runLoopRound(deps())).round?.decisions).toMatchObject({ proposed: 1 });
    expect([...mem.decisions.values()][0]).toMatchObject({ status: 'proposed', mode: 'propose', decidedBy: 'loop:1' });

    mem = memoryStore(() => now);
    now = T0 - 60_000;
    await repeatSeeded();
    await setMode('observe');
    await runLoopRound(deps());
    await setMode('auto');
    mem.raw.delete(LOOP_ACTIVITY_CURSOR);
    expect((await runLoopRound(deps())).round?.decisions).toMatchObject({ applied: 1 });
    expect(mem.links).toHaveLength(1);
    // Applied by the loop on its own: it reads auto, scored this round, never "observed only".
    expect([...mem.decisions.values()][0]).toMatchObject({ status: 'applied', mode: 'auto' });
  });

  test('an auto call the owner pauses before it applies waits as a proposal, and reads propose', async () => {
    await repeatSeeded();
    await setMode('auto');
    const pausing: LoopType = { ...linkMisses, candidates: async (ctx) => {
      const found = await linkMisses.candidates(ctx);
      await setMode('auto', { paused: { at: 't', by: 'you' } });
      return found;
    } };
    expect((await runLoopRound(deps({ types: [pausing] }))).round?.decisions).toMatchObject({ proposed: 1, applied: 0 });
    expect([...mem.decisions.values()][0]).toMatchObject({ status: 'proposed', mode: 'propose' });
    expect(mem.links).toHaveLength(0);
  });
});

/** A type that returns these candidates (for the gates). */
const fixed = (type: LoopType['type'], candidates: LoopCandidate[], o: Partial<LoopType> = {}): LoopType =>
  ({ type, weights: { bias: 3 }, candidates: async () => ({ candidates, scanned: candidates.length, skipped: { below_floor: 2 } }), ...o });
const lessonCall = (id: string, o: Partial<LoopCandidate> = {}): LoopCandidate => ({
  projectKey: 'demo', targets: [{ kind: 'lesson', id, role: 'primary' }], before: [], after: [],
  evidence: [{ kind: 'lesson', id, role: 'subject', weight: 1, observedAt: 't' }], features: {}, subject: `call on ${id}`, rationale: 'because', ...o,
});
const executor = (): LoopExecutor & { apply: ReturnType<typeof vi.fn> } => ({
  apply: vi.fn(async (d) => {
    await mem.store.decisions.markApplying(d.id);
    await mem.store.decisions.markApplied(d.id, d.after);
    return { status: 'applied' as const, decision: (await mem.store.decisions.get(d.id))! };
  }),
  changed: async () => null,
});
/** Calibration for approve_lesson's top band: earned (n labels of the owner, all kept). */
const earn = (n: number) => mem.store.decisions.bumpCalibration({ type: 'approve_lesson', band: 4, policyVersion: LOOP_POLICY_VERSION, prior: { alpha: 1, beta: 4 }, alpha: n, beta: 0, n });

describe('the tier A gate', () => {
  beforeEach(() => setMode('auto'));

  test('cold start: below τ, so proposed', async () => {
    const ex = executor();
    const { round } = await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:a')])], executor: ex }));
    expect(round).toMatchObject({ decisions: { proposed: 1, applied: 0, skipped: 2 }, skipped: [{ reason: 'below_floor', count: 2 }] });
    expect(ex.apply).not.toHaveBeenCalled();
  });

  test('earned (lower ≥ τ, n ≥ 20): applies, within the daily and per-project caps, with a sync hold', async () => {
    await earn(150);
    const ex = executor();
    const calls = ['a', 'b', 'c'].map((x) => lessonCall(`lesson:${x}`));
    const { round } = await runLoopRound(deps({ types: [fixed('approve_lesson', calls)], executor: ex }));
    expect(round?.decisions).toMatchObject({ applied: 2, proposed: 1 });
    expect(ex.apply.mock.calls[0][1]).toEqual({ by: 'loop:1', syncHoldUntil: new Date(T0 - 60_000 + 7 * 86_400_000).toISOString() });
  });

  test('the day\'s caps count only applies that happen: a call already decided, or one whose apply finds its target changed, takes no slot', async () => {
    await earn(150);
    const ex = executor();
    await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:a')])], executor: ex }));
    const [d] = mem.decisions.values();
    mem.decisions.set(d.id, { ...d, status: 'rejected', decidedBy: 'you' });
    // Found again round after round, rejected by you: already decided, never a slot.
    for (let i = 0; i < 4; i++) { now += 60_000; await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:a')])], executor: ex })); }
    const changed: LoopExecutor = { apply: async () => ({ status: 'changed', reason: 'you edited it' }), changed: async () => null };
    now += 60_000;
    await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:b')])], executor: changed }));
    expect(JSON.parse(mem.raw.get('loop-budget')!)).toMatchObject({ auto: 1, autoByProject: { demo: 1 } });
    now += 60_000;
    const { round } = await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:c')])], executor: ex }));
    expect(round?.decisions.applied).toBe(1);
  });

  test('too few labels, proposeOnly, or a raised τ: proposed', async () => {
    await earn(10);
    const ex = executor();
    await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:a')])], executor: ex }));
    await earn(140);
    await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:b', { proposeOnly: 'you edited it 3 days ago' }), lessonCall('lesson:c', { tauRaise: 0.09 })])], executor: ex }));
    expect(ex.apply).not.toHaveBeenCalled();
    expect([...mem.decisions.values()].find((d) => d.targets[0].id === 'lesson:b')?.rationale).toBe('because Proposed rather than applied: you edited it 3 days ago.');
    await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:d', { tauRaise: 0.01 })])], executor: ex }));
    expect(ex.apply).toHaveBeenCalledTimes(1);
  });

  test('the owner raised τ: proposed, and a call\'s tauRaise never lowers it', async () => {
    await earn(150);
    await setMode('auto', { types: { approve_lesson: { mode: null, tau: 0.99 } } });
    const ex = executor();
    await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:a'), lessonCall('lesson:b', { tauRaise: -0.5 })])], executor: ex }));
    expect(ex.apply).not.toHaveBeenCalled();
  });

  test('tier P never applies on its own', async () => {
    const ex = executor();
    await runLoopRound(deps({ types: [fixed('tune_threshold', [lessonCall('lesson:a')])], executor: ex }));
    expect([...mem.decisions.values()][0].status).toBe('proposed');
  });

  test('paused while the round ran: proposed, not applied', async () => {
    await earn(150);
    const ex = executor();
    const pausing = fixed('link_misses', [lessonCall('lesson:a')], {
      candidates: async () => {
        await setMode('auto', { paused: { at: 't', by: 'you' } });
        return { candidates: [lessonCall('lesson:a')], scanned: 1, skipped: {} };
      },
    });
    expect((await runLoopRound(deps({ types: [pausing], executor: ex }))).round?.decisions).toMatchObject({ proposed: 1, applied: 0 });
    expect(ex.apply).not.toHaveBeenCalled();
    expect(loopEntries().map((e) => e.details.action)).toEqual(['proposed']);
  });
});

describe('what stops a call', () => {
  beforeEach(() => setMode('auto'));

  test('a rolled-back call is suppressed for 30 days unless its evidence grows by half', async () => {
    await suppress(mem.cursors, 'link_misses', [{ id: 'lesson:a' }], 2, now);
    const { round } = await runLoopRound(deps({ types: [fixed('link_misses', [lessonCall('lesson:a')])] }));
    expect(round?.skipped).toContainEqual({ reason: 'suppressed', count: 1 });
    const grown = lessonCall('lesson:a', { evidence: [1, 2, 3].map((i) => ({ kind: 'lesson' as const, id: `lesson:e${i}`, role: 'r', weight: 1, observedAt: 't' })) });
    expect((await runLoopRound(deps({ types: [fixed('link_misses', [grown])], executor: executor() }))).round?.decisions.applied).toBe(1);
  });

  test('the executor finds the target changed: logged overridden; someone decided first: skipped', async () => {
    const changed: LoopExecutor = { apply: async () => ({ status: 'changed', reason: 'you edited it' }), changed: async () => null };
    expect((await runLoopRound(deps({ types: [fixed('link_misses', [lessonCall('lesson:a')])], executor: changed }))).round?.skipped).toContainEqual({ reason: 'target_changed', count: 1 });
    expect(loopEntries().at(-1)).toMatchObject({ kind: 'decision_made', details: { action: 'overridden', status: 'overridden' } });
    expect(loopEntries().at(-1)!.subject).toContain('(not applied: you edited it)');
    const lost: LoopExecutor = { apply: async () => ({ status: 'lost' }), changed: async () => null };
    expect((await runLoopRound(deps({ types: [fixed('link_misses', [lessonCall('lesson:b')])], executor: lost }))).round?.skipped).toContainEqual({ reason: 'already_decided', count: 1 });
  });

  test('the day\'s model budget spent: the type is skipped, the round goes on', async () => {
    const spent: LoopType = { type: 'reword_lesson', weights: { bias: 0 }, candidates: async () => { throw new LoopBudgetSpent(40); } };
    const { round } = await runLoopRound(deps({ types: [spent, fixed('link_misses', [lessonCall('lesson:a')])], executor: executor() }));
    expect(round).toMatchObject({ phase: 'done', decisions: { applied: 1 } });
    expect(round?.skipped).toContainEqual({ reason: 'budget', count: 1 });
  });

  test('a metered model call counts in the round', async () => {
    const llm = { id: 'ollama:x', agentic: false, json: vi.fn(async () => ({})) };
    const asking: LoopType = { type: 'reword_lesson', weights: { bias: 0 }, candidates: async (ctx) => { await ctx.llm!.json({ system: '', user: '', schema: {} }); return { candidates: [], scanned: 0, skipped: {} }; } };
    expect((await runLoopRound(deps({ types: [asking], llm }))).round?.llmCalls).toBe(1);
  });
});

describe('failures and paging', () => {
  test('a store error aborts the round, recorded; the next round reads the same entries without counting them twice', async () => {
    await setMode('observe');
    await mem.record({ kind: 'context_served', actor: 'agent', projectKey: 'demo', subject: 's', why: '', details: { lessons: [{ id: 'lesson:a' }] }, targets: ['lesson:a'] });
    now = T0;
    const failing = fixed('link_misses', [], { candidates: async () => { throw new Error(`store down ghp_${'A1b2'.repeat(9)}`); } });
    await expect(runLoopRound(deps({ types: [failing] }))).rejects.toThrow('store down');
    const aborted = await readLoopRound(mem.cursors);
    expect(aborted).toMatchObject({ phase: 'aborted', finishedAt: expect.any(String) });
    expect(aborted?.error).not.toContain('A1b2A1b2');
    expect(mem.signals.get('lesson:a')?.counts.served).toBe(1);
    const next = await runLoopRound(deps({ types: [] }));
    expect(next.round).toMatchObject({ phase: 'done', signalsIngested: 0 });
    expect(mem.signals.get('lesson:a')?.counts.served).toBe(1);
    expect((await runLoopRound(deps({ types: [] }))).round?.signalsIngested).toBe(0);
  });

  test.each(['loop-sessions', 'loop-activity', 'a label marker'])('a store error at %s once the labels and signals are folded: the retried round counts the owner\'s rollback and the serving once', async (failing) => {
    await setMode('observe');
    const { decision } = await mem.store.decisions.propose({
      type: 'link_misses', projectKey: 'demo', targets: [{ kind: 'miss', id: 'miss:a', role: 'primary' }], before: [], after: [],
      evidence: [], features: {}, score: 0.9, confidence: { p: 0.8, lower: 0.56, n: 0, band: 4 }, tier: 'H', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
    });
    await mem.record({ kind: 'decision_rolled_back', actor: 'you', projectKey: 'demo', subject: 'rolled back', why: 'w', targets: [decision.id], details: { decisionId: decision.id, status: 'rolled_back', action: 'rollback', reason: 'wrong_evidence' } });
    await mem.record({ kind: 'context_served', actor: 'agent', projectKey: 'demo', subject: 's', why: '', details: { lessons: [{ id: 'lesson:x' }] }, targets: ['sess-1', 'lesson:x'] });
    await mem.record({ kind: 'decision_rolled_back', actor: 'you', projectKey: 'demo', subject: 'rolled back', why: 'w', targets: [decision.id], details: { decisionId: decision.id, status: 'rolled_back', action: 'rollback' } });
    now = T0;
    let fail = true;
    const cursors = { ...mem.cursors, setCursor: async (k: string, v: string) => {
      const hit = failing === 'a label marker' ? k.startsWith('loop-label:') && k.endsWith(':3') : k === failing;
      if (hit && fail) { fail = false; throw new Error('store timeout'); }
      return mem.cursors.setCursor(k, v);
    } };
    await expect(runLoopRound(deps({ types: [], cursors }))).rejects.toThrow('store timeout');
    await runLoopRound(deps({ types: [], cursors }));
    await runLoopRound(deps({ types: [], cursors }));
    expect([...mem.buckets.values()]).toEqual([expect.objectContaining({ n: 2, beta: LOOP_TYPE_INFO.link_misses.prior.beta + 2 })]);
    expect(JSON.parse(mem.raw.get('loop-penalty:link_misses')!)).toEqual({ evidence: 1, scope: 0 });
    expect(mem.signals.get('lesson:x')?.counts.served).toBe(1);
  });

  test('a full page: more waits; entries younger than 5 seconds wait for the next round', async () => {
    await setMode('observe');
    for (let i = 0; i < 3; i++) await mem.record({ kind: 'context_served', actor: 'agent', projectKey: 'demo', subject: 's', why: '', details: { lessons: [] }, targets: [] });
    now = T0;
    expect(await runLoopRound(deps({ types: [], pageSize: 2 }))).toMatchObject({ more: true, round: { signalsIngested: 2 } });
    expect(await runLoopRound(deps({ types: [], pageSize: 2 }))).toMatchObject({ more: false, round: { signalsIngested: 1 } });
    now = T0 + 1000;
    await mem.record({ kind: 'context_served', actor: 'agent', projectKey: 'demo', subject: 's', why: '', details: { lessons: [] }, targets: [] });
    expect((await runLoopRound(deps({ types: [] }))).round?.signalsIngested).toBe(0);
    now = T0 + 10_000;
    expect((await runLoopRound(deps({ types: [] }))).round?.signalsIngested).toBe(1);
  });

  test('an unreadable cursor: the log is read from the start', async () => {
    await setMode('observe');
    await mem.record({ kind: 'context_served', actor: 'agent', projectKey: 'demo', subject: 's', why: '', details: { lessons: [] }, targets: [] });
    now = T0;
    mem.raw.set(LOOP_ACTIVITY_CURSOR, '{');
    expect((await runLoopRound(deps({ types: [] }))).round?.signalsIngested).toBe(1);
  });

  test('a project out of scope: its entries are not folded', async () => {
    await setMode('observe');
    await mem.record({ kind: 'context_served', actor: 'agent', projectKey: 'elsewhere', subject: 's', why: '', details: { lessons: [{ id: 'lesson:z' }] }, targets: ['lesson:z'] });
    now = T0;
    expect((await runLoopRound(deps({ types: [] }))).round?.signalsIngested).toBe(0);
  });
});

describe('labels and the breaker', () => {
  test('the owner approving a decision is a positive label in its bucket', async () => {
    await setMode('propose');
    await runLoopRound(deps({ types: [fixed('approve_lesson', [lessonCall('lesson:a')])] }));
    const [d] = mem.decisions.values();
    await mem.record({ kind: 'decision_applied', actor: 'you', projectKey: 'demo', subject: 'approved', why: '', details: { decisionId: d.id, status: 'applied', action: 'approve' }, targets: [d.id] });
    now += 10_000;
    await runLoopRound(deps({ types: [] }));
    expect([...mem.buckets.values()]).toEqual([expect.objectContaining({ type: 'approve_lesson', band: d.confidence.band, alpha: 2, beta: 4, n: 1 })]);
  });

  const rolledBack = (id: string, at: string, appliedAt = at) => mem.decisions.set(id, {
    id, type: 'link_misses', status: 'rolled_back', appliedAt, decidedAt: at, rollback: { at, by: 'you', reason: null, note: null, cascade: [] }, createdAt: at, targets: [], dependsOn: [],
  } as never);
  const applied = (id: string, appliedAt: string) => mem.decisions.set(id, { id, type: 'link_misses', status: 'applied', appliedAt, createdAt: appliedAt, targets: [] } as never);

  test('two rollbacks within 7 days trip it: the type is held at propose and the change is logged', async () => {
    await setMode('auto');
    rolledBack('dec:1', '2026-11-08T00:00:00.000Z');
    rolledBack('dec:2', '2026-11-10T00:00:00.000Z');
    await runLoopRound(deps({ types: [fixed('link_misses', [lessonCall('lesson:a')])], executor: executor() }));
    expect(await readLoopBreaker(mem.cursors, 'link_misses')).toEqual({ tripped: true, at: new Date(T0 - 60_000).toISOString(), reason: '2 rollbacks in 7 days' });
    expect(mem.log.find((e) => e.kind === 'loop_settings_changed')).toMatchObject({ actor: 'loop:breaker', details: { decisionType: 'link_misses', mode: 'propose' } });
    expect([...mem.decisions.values()].find((d) => d.targets?.[0]?.id === 'lesson:a')?.status).toBe('proposed');
  });

  test('more than 20% of the last 10 applied rolled back trips it; fewer than 5 applied never does on rate alone', async () => {
    const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;
    rolledBack('dec:r', at(1));
    for (let i = 2; i < 5; i++) applied(`dec:${i}`, at(i));
    expect((await checkBreaker(deps(), 'link_misses', T0)).tripped).toBe(false);
    rolledBack('dec:s', at(5));
    applied('dec:6', at(6));
    expect(await checkBreaker(deps(), 'link_misses', T0)).toMatchObject({ tripped: true, reason: '2 of its last 6 applied decisions rolled back' });
    // Tripped stays tripped (the owner resets it), without a second entry.
    expect((await checkBreaker(deps(), 'link_misses', T0)).tripped).toBe(true);
    expect(mem.log.filter((e) => e.kind === 'loop_settings_changed')).toHaveLength(1);
  });

  test('a breaker the owner reset lets the type apply again', async () => {
    await setMode('auto');
    await writeLoopBreaker(mem.cursors, 'link_misses', { tripped: false, at: null, reason: null });
    expect((await runLoopRound(deps({ types: [fixed('link_misses', [lessonCall('lesson:a')])], executor: executor() }))).round?.decisions.applied).toBe(1);
  });
});

test('the real link_misses type through the engine, with neighbours that do not repeat', async () => {
  await setMode('auto');
  mem.misses.set('miss:far', loopMiss('miss:far', { embedding: axis(5), createdAt: '2026-09-01T00:00:00.000Z' }));
  await repeatSeeded();
  const { round } = await runLoopRound(deps({ types: [linkMisses] }));
  expect(round).toMatchObject({ decisions: { applied: 1 }, skipped: [{ reason: 'not_a_repeat', count: 1 }] });
});

test('a link only observed is found again once the type applies, with no new miss: applied, not left observed', async () => {
  await repeatSeeded();
  await setMode('observe');
  await runLoopRound(deps());
  expect([...mem.decisions.values()][0].status).toBe('observed');
  // Another observe round, its post-mortem read already: nothing is looked at again.
  expect((await runLoopRound(deps())).round).toMatchObject({ targetsScored: 0, decisions: { skipped: 0 } });
  await setMode('auto');
  expect((await runLoopRound(deps())).round).toMatchObject({ signalsIngested: 0, decisions: { applied: 1 } });
  expect([...mem.decisions.values()][0]).toMatchObject({ status: 'applied', mode: 'auto' });
  expect(mem.links).toHaveLength(1);
  // Applied: not observed any more, so the next round has nothing to look at again.
  expect((await runLoopRound(deps())).round).toMatchObject({ targetsScored: 0, decisions: { skipped: 0 } });
});

describe('observed calls rechecked outside observe', () => {
  const snap = (id: string, fingerprint: string) => [{ kind: 'lesson' as const, id, fields: {}, fingerprint }];
  const call = (id: string, o: Partial<LoopCandidate> = {}) => lessonCall(id, { before: snap(id, 'was'), after: snap(id, 'will'), ...o });
  /** A type whose candidates are `found` (a round's entries) and whose recheck answers `again` per primary target. */
  function entriesOnly(found: { now: LoopCandidate[] }, again: Record<string, LoopCandidate | string>, o: Partial<LoopType> = {}) {
    const asked: string[][] = [];
    const type = fixed('rank_weight', [], {
      candidates: async () => ({ candidates: found.now, scanned: found.now.length, skipped: {} }),
      recheck: async (_ctx, observed) => { asked.push(observed.map(primaryOf)); return observed.map((d) => again[primaryOf(d)]); },
      ...o,
    });
    return { type, asked };
  }
  const byTarget = (id: string) => [...mem.decisions.values()].filter((d) => d.targets[0].id === id);

  test('one that still holds moves on; one that does not is expired with its reason, and not measured again; never in observe', async () => {
    const found = { now: [call('lesson:a'), call('lesson:b')] };
    const { type, asked } = entriesOnly(found, { 'lesson:a': call('lesson:a'), 'lesson:b': 'no_longer_holds' });
    await setMode('observe');
    expect((await runLoopRound(deps({ types: [type] }))).round?.decisions).toMatchObject({ observed: 2 });
    found.now = [];
    await runLoopRound(deps({ types: [type] }));
    expect(asked).toEqual([]);
    await setMode('propose');
    const { round } = await runLoopRound(deps({ types: [type] }));
    expect(round).toMatchObject({ decisions: { proposed: 1, skipped: 1 }, skipped: [{ reason: 'no_longer_holds', count: 1 }] });
    expect(byTarget('lesson:a')).toMatchObject([{ status: 'proposed', mode: 'propose' }]);
    expect(byTarget('lesson:b')).toMatchObject([{ status: 'expired', decidedBy: 'loop:1' }]);
    // Nothing observed is left, so the next round asks about nothing.
    const last = (await runLoopRound(deps({ types: [type] }))).round;
    expect(last?.skipped).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  test('a call found again by the round is not rechecked; at most recheckLimit are', async () => {
    const found = { now: ['lesson:a', 'lesson:b', 'lesson:c'].map((id) => call(id)) };
    const { type, asked } = entriesOnly(found, { 'lesson:a': 'no_longer_holds', 'lesson:b': 'no_longer_holds', 'lesson:c': 'no_longer_holds' }, { recheckLimit: 1 });
    await setMode('observe');
    await runLoopRound(deps({ types: [type] }));
    await setMode('propose');
    found.now = [call('lesson:a')];
    const { round } = await runLoopRound(deps({ types: [type] }));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(1);
    expect(asked[0][0]).not.toBe('lesson:a');
    expect(round).toMatchObject({ decisions: { proposed: 1 }, skipped: [{ reason: 'no_longer_holds', count: 1 }] });
  });

  test('a target changed since, or another change to it: the observed call is expired and the call found now made in its place', async () => {
    const found = { now: [call('lesson:a'), call('lesson:b')] };
    const moved = (id: string) => ({ evidence: [{ kind: 'lesson' as const, id, role: 'another step', weight: 1, observedAt: 't' }] });
    const { type } = entriesOnly(found, {
      'lesson:a': call('lesson:a', { ...moved('lesson:a'), before: snap('lesson:a', 'edited') }),
      'lesson:b': call('lesson:b', { ...moved('lesson:b'), after: snap('lesson:b', 'elsewhere') }),
    });
    await setMode('observe');
    await runLoopRound(deps({ types: [type] }));
    await setMode('propose');
    found.now = [];
    const { round } = await runLoopRound(deps({ types: [type] }));
    expect(round).toMatchObject({ decisions: { proposed: 2 }, skipped: [{ reason: 'no_longer_holds', count: 1 }, { reason: 'target_changed', count: 1 }] });
    for (const id of ['lesson:a', 'lesson:b']) expect(byTarget(id).map((d) => d.status).sort()).toEqual(['expired', 'proposed']);
  });

  test('an expired call that holds again, on its targets as they were, is observed again and moves on; on changed targets it is a new call', async () => {
    const found = { now: [call('lesson:a'), call('lesson:b'), call('lesson:c')] };
    const { type } = entriesOnly(found, { 'lesson:a': 'no_longer_holds', 'lesson:b': 'no_longer_holds', 'lesson:c': 'no_longer_holds' });
    await setMode('observe');
    await runLoopRound(deps({ types: [type] }));
    await setMode('propose');
    found.now = [];
    await runLoopRound(deps({ types: [type] }));
    expect([...mem.decisions.values()].map((d) => d.status)).toEqual(['expired', 'expired', 'expired']);
    found.now = [call('lesson:a'), call('lesson:b', { before: snap('lesson:b', 'edited') })];
    const { round } = await runLoopRound(deps({ types: [type] }));
    expect(round).toMatchObject({ decisions: { proposed: 2 } });
    expect(byTarget('lesson:a')).toMatchObject([{ status: 'proposed', mode: 'propose' }]);
    expect(byTarget('lesson:b').map((d) => [d.status, d.before[0].fingerprint])).toEqual([['expired', 'was'], ['proposed', 'edited']]);
    await setMode('observe');
    found.now = [call('lesson:c')];
    expect((await runLoopRound(deps({ types: [type] }))).round?.decisions).toMatchObject({ observed: 1 });
    expect(byTarget('lesson:c')).toMatchObject([{ status: 'observed', mode: 'observe' }]);
  });

  test('an observed call found again on targets changed since: the stale one is expired and the call made now in its place', async () => {
    const found = { now: [call('lesson:a')] };
    const { type } = entriesOnly(found, {});
    await setMode('observe');
    await runLoopRound(deps({ types: [type] }));
    await setMode('propose');
    found.now = [call('lesson:a', { before: snap('lesson:a', 'edited') })];
    expect((await runLoopRound(deps({ types: [type] }))).round?.decisions).toMatchObject({ proposed: 1 });
    expect(byTarget('lesson:a').map((d) => [d.status, d.before[0].fingerprint])).toEqual([['expired', 'was'], ['proposed', 'edited']]);
  });

  test('an applied step does not block the next one from where it left the target; the same step again does', async () => {
    const found = { now: [call('lesson:a', { after: snap('lesson:a', 'step1') })] };
    const { type } = entriesOnly(found, {});
    const executor: LoopExecutor = { apply: async (dd) => { await mem.store.decisions.markApplying(dd.id); await mem.store.decisions.markApplied(dd.id, dd.after); return { status: 'applied', decision: (await mem.store.decisions.get(dd.id))! }; }, changed: async () => null };
    await setMode('auto');
    expect((await runLoopRound(deps({ types: [type], executor }))).round?.decisions).toMatchObject({ applied: 1 });
    expect((await runLoopRound(deps({ types: [type], executor }))).round?.skipped).toEqual([{ reason: 'already_decided', count: 1 }]);
    const [first] = byTarget('lesson:a');
    found.now = [call('lesson:a', { before: snap('lesson:a', 'step1'), after: snap('lesson:a', 'step2'), evidence: [{ kind: 'lesson', id: 'lesson:a', role: 'step 2', weight: 1, observedAt: 't' }] })];
    expect((await runLoopRound(deps({ types: [type], executor }))).round?.decisions).toMatchObject({ applied: 1 });
    expect(byTarget('lesson:a').map((d) => [d.status, d.dependsOn])).toEqual([['applied', []], ['applied', [first.id]]]);
  });
});

describe('the holdout', () => {
  test('a call on a held-out lesson is never made, not even observed; the others are, and the round counts the skip', async () => {
    await setMode('observe');
    // At LOOP_HOLDOUT 0.2, lesson:z and lesson:c are held out by the hash; lesson:x and lesson:y are not.
    const calls = ['x', 'z', 'y', 'c'].map((x) => lessonCall(`lesson:${x}`));
    const merge = lessonCall('lesson:x', { targets: [{ kind: 'lesson', id: 'lesson:x', role: 'keeper' }, { kind: 'lesson', id: 'lesson:z', role: 'merged' }] });
    const { round } = await runLoopRound(deps({ config: config({ holdout: 0.2 }), types: [fixed('retire_lesson', [...calls, merge], { candidates: async () => ({ candidates: [...calls, merge], scanned: 5, skipped: {} }) })] }));
    expect(round).toMatchObject({ targetsScored: 2, decisions: { observed: 2, skipped: 3 }, skipped: [{ reason: 'holdout', count: 3 }] });
    expect([...mem.decisions.values()].map((d) => d.targets[0].id).sort()).toEqual(['lesson:x', 'lesson:y']);
  });

  test('misses are never held out, and LOOP_HOLDOUT=0 holds out nothing', async () => {
    await setMode('observe');
    const miss = lessonCall('miss:z', { targets: [{ kind: 'miss', id: 'lesson:z', role: 'primary' }] });
    const { round } = await runLoopRound(deps({ config: config({ holdout: 0.2 }), types: [fixed('link_misses', [miss], { candidates: async () => ({ candidates: [miss], scanned: 1, skipped: {} }) })] }));
    expect(round?.decisions.observed).toBe(1);
    const none = await runLoopRound(deps({ types: [fixed('retire_lesson', [lessonCall('lesson:z')], { candidates: async () => ({ candidates: [lessonCall('lesson:z')], scanned: 1, skipped: {} }) })] }));
    expect(none.round?.decisions.observed).toBe(1);
  });
});

describe('reword_lesson spends model calls only on calls the engine can make', () => {
  const good = { title: 'Reuse createPool', rule: 'Use createPool() from src/db/pool.ts instead of new pg.Pool()', appliesWhen: 'adding a query in src/db', paths: ['src/db/pool.ts'] };
  /** Flagged lessons in memory, the model's answers scripted; the judge answers `equivalent`. */
  function rewordWorld(ids: string[], equivalent: boolean) {
    for (const id of ids) {
      const l = lesson(id, { title: 'Check patterns', rule: 'Check for existing patterns', appliesWhen: 'editing database access in src/db', paths: ['src/db/pool.ts'], checks: [{ name: 'generic', why: 'names nothing' }] });
      mem.lessons.set(id, l);
      mem.misses.set(l.missId!, loopMiss(l.missId!, { editedFiles: ['src/db/pool.ts', 'src/db/query.ts'] }));
    }
    const knowledge = {
      ...mem.store.knowledge,
      lessonDetail: async (id: string) => {
        const l = mem.lessons.get(id);
        return l ? ({ lesson: l, miss: { id: l.missId, missed: 'opened a second pg.Pool instead of reusing createPool', cause: 'context_missing', causeExplanation: '' },
          feedback: { id: 'f', text: 'use the pool helper', status: 'addressed', sessionId: 's', ts: '2026-10-01T00:00:00.000Z' }, contextItems: [], fixCommits: [], supersedes: [] } as unknown as LessonDetail) : null;
      },
    };
    const asked: string[] = [];
    const llm: LlmProvider = {
      id: 'ollama:test', agentic: false,
      json: async (t: JsonTask) => {
        const judging = t.user.includes('THE REWRITE');
        asked.push(judging ? 'judge' : 'rewrite');
        return (judging ? { equivalent, why: 'same' } : { lessons: [good] }) as never;
      },
    };
    return { store: { ...mem.store, knowledge } as unknown as LoopEngineDeps['store'], llm, asked };
  }
  const rounds = async (d: LoopEngineDeps, n: number) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      now += 6 * 60_000;
      out.push((await runLoopRound(d)).round!);
    }
    return out;
  };

  test('held-out lessons sorted first take no model call and no slot of the round cap: the lesson after them is reworded', async () => {
    await setMode('observe');
    const holdout = 0.5;
    const ids = Array.from({ length: 40 }, (_, i) => `lesson:a${String(i).padStart(3, '0')}`);
    const held = ids.filter((id) => inHoldout(id, holdout)).slice(0, 3);
    const free = ids.find((id) => !inHoldout(id, holdout) && id > held[2])!;
    const w = rewordWorld([...held, free], true);
    const [first, ...later] = await rounds(deps({ store: w.store, llm: w.llm, types: [rewordLesson], config: config({ holdout, llmCallsPerDay: 1000 }) }), 3);
    expect(first).toMatchObject({ llmCalls: 2, decisions: { observed: 1 }, skipped: [{ reason: 'holdout', count: 3 }] });
    expect([...mem.decisions.values()].map((x) => x.targets[0].id)).toEqual([free]);
    // Later rounds: the held-out ones are skipped again without a call, and the reworded one is decided.
    for (const r of later) expect(r.llmCalls).toBe(0);
    expect(w.asked).toEqual(['rewrite', 'judge']);
  });

  test('a rewrite the judge refused is not asked again of the same text; asked again once the text changes', async () => {
    await setMode('observe');
    const w = rewordWorld(['lesson:a'], false);
    const d = deps({ store: w.store, llm: w.llm, types: [rewordLesson], config: config({ llmCallsPerDay: 1000 }) });
    const [first, ...later] = await rounds(d, 3);
    expect(first).toMatchObject({ llmCalls: 2, skipped: [{ reason: 'not_equivalent', count: 1 }] });
    for (const r of later) expect(r).toMatchObject({ llmCalls: 0, skipped: [{ reason: 'refused_before', count: 1 }] });
    mem.lessons.set('lesson:a', { ...mem.lessons.get('lesson:a')!, rule: 'Check for existing pool patterns' });
    expect((await rounds(d, 1))[0]).toMatchObject({ llmCalls: 2, skipped: [{ reason: 'not_equivalent', count: 1 }] });
  });
});

describe('a round costs what changed', () => {
  /** A type that only reports the round's lessons, as retire_lesson reads them. */
  const seen: string[][] = [];
  const watcher: LoopType = { type: 'retire_lesson', weights: { bias: 0 }, candidates: async (ctx) => { seen.push((await ctx.lessons()).map((l) => l.id)); return { candidates: [], scanned: 0, skipped: {} }; } };
  const id = (i: number) => `lesson:${String(i).padStart(4, '0')}`;
  beforeEach(() => { seen.length = 0; });

  test('the lessons a type judges are those the round\'s entries name and the sweep\'s next page, not all of them; the sweep comes round again', async () => {
    for (let i = 0; i < LOOP_SWEEP * 2 + 100; i++) mem.lessons.set(id(i), lesson(id(i), { status: 'approved' }));
    await setMode('observe');
    now = T0;
    const listed = vi.spyOn(mem.store.knowledge, 'listLessons');
    await runLoopRound(deps({ types: [watcher] }));
    expect(seen[0]).toEqual(Array.from({ length: LOOP_SWEEP }, (_, i) => id(i)));
    // An entry names a lesson past the sweep's page: it is judged this round too.
    await mem.record({ kind: 'lesson_decided', actor: 'you', projectKey: 'demo', subject: 'edited', why: '', details: {}, targets: [id(1050)] });
    now = T0 + 60_000;
    await runLoopRound(deps({ types: [watcher] }));
    expect(seen[1]).toEqual([...Array.from({ length: LOOP_SWEEP }, (_, i) => id(LOOP_SWEEP + i)), id(1050)]);
    now += 60_000;
    await runLoopRound(deps({ types: [watcher] }));
    expect(seen[2]).toEqual(Array.from({ length: 100 }, (_, i) => id(LOOP_SWEEP * 2 + i)));
    now += 60_000;
    await runLoopRound(deps({ types: [watcher] }));
    expect(seen[3][0]).toBe(id(0));
    // One page (and the named lesson) a round, read once however many types ask.
    expect(listed.mock.calls.map(([f]) => f)).toEqual([
      { afterId: '', limit: LOOP_SWEEP }, { afterId: id(LOOP_SWEEP - 1), limit: LOOP_SWEEP }, { ids: [id(1050)], limit: 1 },
      { afterId: id(LOOP_SWEEP * 2 - 1), limit: LOOP_SWEEP }, { afterId: '', limit: LOOP_SWEEP },
    ]);
  });

  test('a lesson that crosses a floor with no entry (its age) is found by the sweep: retire_lesson calls it', async () => {
    const old = lesson(id(7), { status: 'approved', decidedAt: '2026-08-01T00:00:00.000Z' });
    mem.lessons.set(old.id, old);
    const counts = { ...Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, 0])), served: 20, notApplicable: 10 } as LessonSignals['counts'];
    mem.signals.set(old.id, { lessonId: old.id, counts, lastServed: null, lastOwnerTouch: null, updatedAt: 't' });
    await setMode('propose');
    now = T0;
    const signals = vi.spyOn(mem.store.decisions, 'signals');
    const { round } = await runLoopRound(deps({ types: [retireLesson] }));
    expect(round?.decisions.proposed).toBe(1);
    // Its signals came with the round's lessons, in one read.
    expect(signals).not.toHaveBeenCalled();
  });

  test('a call already open is known from one read of the round\'s open decisions, not a read per call', async () => {
    const ls = Array.from({ length: 30 }, (_, i) => lesson(id(i)));
    const call = (l: (typeof ls)[number]): LoopCandidate => ({
      projectKey: 'demo', targets: [{ kind: 'lesson', id: l.id, role: 'primary' }], before: [lessonSnapshot(l)], after: [lessonSnapshot({ ...l, status: 'rejected' })],
      evidence: [], features: {}, subject: `reject ${l.id}`, rationale: 'r',
    });
    const fixed: LoopType = { type: 'reject_lesson', weights: { bias: 0 }, candidates: async () => ({ candidates: ls.map(call), scanned: ls.length, skipped: {} }) };
    await setMode('propose');
    now = T0;
    expect((await runLoopRound(deps({ types: [fixed] }))).round?.decisions.proposed).toBe(30);
    const forTarget = vi.spyOn(mem.store.decisions, 'forTarget');
    const list = vi.spyOn(mem.store.decisions, 'list');
    now += 60_000;
    const { round } = await runLoopRound(deps({ types: [fixed] }));
    expect(round?.skipped).toEqual([{ reason: 'already_decided', count: 30 }]);
    expect(forTarget).not.toHaveBeenCalled();
    expect(list.mock.calls.filter(([f]) => f?.targets)).toHaveLength(1);
  });
});
