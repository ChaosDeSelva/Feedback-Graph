import { expect, test } from 'vitest';
import { DECISION_TYPES } from '../types.ts';
import {
  bandOf, effectiveLoopMode, effectiveTypeMode, isSuppressed, LOOP_ACTOR, LOOP_POLICY_VERSION, LOOP_ROUNDS_KEPT, LOOP_TYPE_INFO, parseLoopBreaker,
  parseLoopBudget, parseLoopRounds, parseLoopSettings, parseSuppression, readLoopBreaker, readLoopBudget, readLoopRound, readLoopRounds,
  readLoopSettings, resetLoopBreaker, seedLoopSettings, suppress, suppressionKey, typeTau, writeLoopBreaker, writeLoopBudget, writeLoopRound, writeLoopSettings,
  type LoopRound, type LoopSettings,
} from './state.ts';
import { betaSummary } from './beta.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => { m.set(k, v); } };
};
const settings = (o: Partial<LoopSettings> = {}): LoopSettings => ({ ...seedLoopSettings({ mode: null }), ...o });
const on = { disabled: false };

test('every decision type has a tier, and the cold-start priors give housekeeping auto and agent-facing none', () => {
  expect(Object.keys(LOOP_TYPE_INFO).sort()).toEqual([...DECISION_TYPES].sort());
  for (const info of Object.values(LOOP_TYPE_INFO)) {
    const cold = betaSummary(info.prior.alpha, info.prior.beta).lower;
    expect(cold >= info.tauDefault).toBe(info.tier === 'H');
  }
  expect(LOOP_ACTOR).toBe(`loop:${LOOP_POLICY_VERSION}`);
});

test('bandOf splits [0,1] into five bands', () => {
  expect([0, 0.19, 0.2, 0.5, 0.79, 0.8, 1].map(bandOf)).toEqual([0, 0, 1, 2, 3, 4, 4]);
});

test('settings are seeded once from LOOP_MODE, else auto, and read back', async () => {
  const c = memory();
  expect(await readLoopSettings(c, { mode: 'observe' })).toEqual({ mode: 'observe', types: {}, paused: null, seededFrom: 'LOOP_MODE' });
  // Seeded already: a changed LOOP_MODE does not reset what the owner set.
  expect((await readLoopSettings(c, { mode: 'propose' })).mode).toBe('observe');
  expect(seedLoopSettings({ mode: null })).toMatchObject({ mode: 'auto', seededFrom: 'default' });
  await writeLoopSettings(c, settings({ mode: 'propose', paused: { at: 't', by: 'you' }, types: { link_misses: { mode: 'off', tau: null } } }));
  expect(await readLoopSettings(c, { mode: null })).toEqual({ mode: 'propose', paused: { at: 't', by: 'you' }, types: { link_misses: { mode: 'off', tau: null } }, seededFrom: 'default' });
});

test('parseLoopSettings drops what it cannot read', () => {
  expect(parseLoopSettings(null)).toBeNull();
  expect(parseLoopSettings('{')).toBeNull();
  expect(parseLoopSettings('{"mode":"wild"}')).toBeNull();
  const s = parseLoopSettings(JSON.stringify({
    mode: 'auto', paused: { at: 1 }, seededFrom: 'LOOP_MODE',
    types: { future_type: { mode: 'auto' }, approve_lesson: { mode: 'x', tau: 0.5 }, reword_lesson: { mode: 'propose', tau: 0.95 }, link_misses: 3 },
  }))!;
  expect(s).toEqual({ mode: 'auto', paused: null, seededFrom: 'LOOP_MODE', types: { approve_lesson: { mode: null, tau: null }, reword_lesson: { mode: 'propose', tau: 0.95 } } });
  expect(typeTau('reword_lesson', s)).toBe(0.95);
  expect(typeTau('approve_lesson', s)).toBe(0.9);
});

test('effectiveLoopMode: disabled, then paused, then the tokenless cap', () => {
  expect(effectiveLoopMode(settings(), { disabled: true }, { tokenless: false })).toEqual({ mode: 'off', capped: 'disabled' });
  expect(effectiveLoopMode(settings({ paused: { at: 't', by: 'you' } }), on, { tokenless: true })).toEqual({ mode: 'off', capped: 'paused' });
  expect(effectiveLoopMode(settings(), on, { tokenless: true })).toEqual({ mode: 'observe', capped: 'tokenless' });
  expect(effectiveLoopMode(settings({ mode: 'observe' }), on, { tokenless: true })).toEqual({ mode: 'observe', capped: null });
  expect(effectiveLoopMode(settings(), on, { tokenless: false })).toEqual({ mode: 'auto', capped: null });
});

test('effectiveTypeMode: the override under the same caps, the breaker and tier P at propose', () => {
  const r = { tokenless: false };
  expect(effectiveTypeMode('link_misses', settings(), on, r)).toBe('auto');
  expect(effectiveTypeMode('link_misses', settings({ mode: 'observe', types: { link_misses: { mode: 'auto', tau: null } } }), on, r)).toBe('auto');
  expect(effectiveTypeMode('link_misses', settings({ types: { link_misses: { mode: 'auto', tau: null } } }), on, { tokenless: true })).toBe('observe');
  expect(effectiveTypeMode('link_misses', settings(), { disabled: true }, r)).toBe('off');
  expect(effectiveTypeMode('link_misses', settings({ paused: { at: 't', by: 'you' } }), on, r)).toBe('off');
  expect(effectiveTypeMode('link_misses', settings(), on, { ...r, breaker: { tripped: true, at: 't', reason: 'x' } })).toBe('propose');
  expect(effectiveTypeMode('link_misses', settings({ mode: 'observe' }), on, { ...r, breaker: { tripped: true, at: 't', reason: 'x' } })).toBe('observe');
  expect(effectiveTypeMode('tune_threshold', settings(), on, r)).toBe('propose');
  expect(effectiveTypeMode('link_misses', settings(), { disabled: false, types: ['rank_weight'] }, r)).toBe('off');
  expect(effectiveTypeMode('link_misses', settings(), { disabled: false, types: ['link_misses'] }, r)).toBe('auto');
});

test('the budget resets each UTC day', async () => {
  const c = memory();
  const now = Date.parse('2026-11-11T23:00:00Z');
  expect(await readLoopBudget(c, now)).toEqual({ day: '2026-11-11', llmCalls: 0, auto: 0, autoByProject: {} });
  await writeLoopBudget(c, { day: '2026-11-11', llmCalls: 3, auto: 1, autoByProject: { a: 1 } });
  expect(await readLoopBudget(c, now)).toEqual({ day: '2026-11-11', llmCalls: 3, auto: 1, autoByProject: { a: 1 } });
  expect((await readLoopBudget(c, now + 2 * 3600_000)).llmCalls).toBe(0);
  expect(parseLoopBudget('{"day":"2026-11-11","llmCalls":-1,"auto":"x","autoByProject":{"a":null}}', now)).toEqual({ day: '2026-11-11', llmCalls: 0, auto: 0, autoByProject: { a: 0 } });
});

test('a breaker is stored per type', async () => {
  const c = memory();
  expect(await readLoopBreaker(c, 'link_misses')).toEqual({ tripped: false, at: null, reason: null });
  await writeLoopBreaker(c, 'link_misses', { tripped: true, at: 't', reason: '2 rollbacks in 7 days' });
  expect(c.m.has('loop-breaker:link_misses')).toBe(true);
  expect(await readLoopBreaker(c, 'link_misses')).toEqual({ tripped: true, at: 't', reason: '2 rollbacks in 7 days' });
  await resetLoopBreaker(c, 'link_misses', Date.parse('2026-11-11T00:00:00Z'));
  expect(await readLoopBreaker(c, 'link_misses')).toEqual({ tripped: false, at: '2026-11-11T00:00:00.000Z', reason: null });
  expect(parseLoopBreaker('{"tripped":true,"at":3}')).toEqual({ tripped: true, at: null, reason: null });
});

const round = (id: string, phase: LoopRound['phase'] = 'reading'): LoopRound => ({
  id, startedAt: 't', finishedAt: null, phase, signalsIngested: 0, targetsScored: 0, targetsTotal: null,
  decisions: { observed: 0, proposed: 0, applied: 0, skipped: 0 }, skipped: [], llmCalls: 0, error: null,
});

test('rounds: each write takes the next seq, a round moves to the end as it progresses, the ring keeps the last 50', async () => {
  const c = memory();
  expect(await readLoopRound(c)).toBeNull();
  expect(await writeLoopRound(c, round('r1'))).toBe(1);
  expect(await writeLoopRound(c, round('r2'))).toBe(2);
  expect(await writeLoopRound(c, round('r1', 'done'))).toBe(3);
  expect((await readLoopRounds(c)).rounds.map((r) => [r.seq, r.round.id, r.round.phase])).toEqual([[2, 'r2', 'reading'], [3, 'r1', 'done']]);
  expect((await readLoopRound(c))?.id).toBe('r1');
  for (let i = 0; i < 60; i++) await writeLoopRound(c, round(`x${i}`));
  const ring = await readLoopRounds(c);
  expect(ring.rounds).toHaveLength(LOOP_ROUNDS_KEPT);
  expect(ring.seq).toBe(63);
  expect(parseLoopRounds('{"seq":2}')).toEqual({ seq: 0, rounds: [] });
});

test('suppression: 30 days unless the evidence grows by half', async () => {
  const c = memory();
  const now = Date.parse('2026-11-11T00:00:00Z');
  const targets = [{ id: 'miss:b' }, { id: 'miss:a' }];
  expect(suppressionKey('link_misses', targets)).toBe('loop-suppress:link_misses|miss:a|miss:b');
  await suppress(c, 'link_misses', targets, 4, now);
  const s = parseSuppression(c.m.get(suppressionKey('link_misses', [...targets].reverse()))!);
  expect(s).toEqual({ until: '2026-12-11T00:00:00.000Z', evidence: 4 });
  expect(isSuppressed(s, 4, now)).toBe(true);
  expect(isSuppressed(s, 5, now)).toBe(true);
  expect(isSuppressed(s, 6, now)).toBe(false);
  expect(isSuppressed(s, 4, now + 31 * 86_400_000)).toBe(false);
  expect(isSuppressed(null, 1, now)).toBe(false);
  expect(parseSuppression('[]')).toBeNull();
});
