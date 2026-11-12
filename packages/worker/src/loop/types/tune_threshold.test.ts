import { describe, expect, test } from 'vitest';
import { thresholdsSnapshot, type Activity, type Decision, type ProjectThresholds, type SessionFile } from '@fb/core';
import { activity, fakeContext, observedAs } from '../testing/context.ts';
import { score } from '../policy.ts';
import { bestFloor, factLabel, floorGain, precisionAt, REPLAY_FACTS_MIN, REPLAY_SESSIONS_MIN, thresholdCandidate, tuneThreshold, type ReplayFact } from './tune_threshold.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const DAYS_AGO = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const DEFAULT = { similarity: 0.78, factRank: 0.8 };
type F = { id?: string; path: string; score: number; rankingScore: number };
const near = (path: string, score: number, rankingScore = 0.85): F => ({ path, score, rankingScore });

/** A get_task_context entry for `session`, served under `floors`, two days old unless said otherwise. */
const served = (session: string, facts: F[], o: { below?: F[]; floors?: object | null; ts?: string; projectKey?: string; targets?: string[] } = {}) =>
  activity('context_served', {
    ts: o.ts ?? DAYS_AGO(2), projectKey: o.projectKey ?? 'demo', targets: o.targets ?? ['lesson:x', 'miss:y', session],
    details: { facts, ...(o.below && { factsBelow: o.below }), ...(o.floors !== null && { floors: o.floors ?? DEFAULT }) },
  });

/** n sessions, each having edited src/api/edit.ts, with `facts(i)` served. */
const sessions = (n: number, facts: (i: number) => F[], o: Parameters<typeof served>[2] = {}) => Array.from({ length: n }, (_, i) => served(`s${i}`, facts(i), o));
const RELEVANT = 'src/api/fact.ts';
const OFF = 'lib/other/fact.ts';

function ctxWith(history: Activity[], o: { thresholds?: ProjectThresholds; open?: Partial<Decision>[]; edited?: (s: string) => string[]; entries?: Activity[]; inScope?: (k: string | null) => boolean } = {}) {
  return fakeContext({
    now: NOW,
    entries: o.entries ?? [activity('context_served', { projectKey: 'demo' })],
    inScope: o.inScope,
    store: {
      activity: { list: async (q: { projectKey?: string }) => history.filter((e) => e.projectKey === q.projectKey) },
      codegraph: { sessionFiles: async (s: string) => (o.edited?.(s) ?? ['src/api/edit.ts']).map((path) => ({ path, edited: true, read: true }) as SessionFile).concat([{ path: 'README.md', edited: false } as SessionFile]) },
      facts: { projectThresholds: async () => o.thresholds ?? { similarityFloor: null, factRankFloor: null } },
      decisions: { forTarget: async () => (o.open ?? []) as Decision[] },
    },
  });
}

/** 12 sessions: two relevant facts well above the floors, one off-topic fact just above the similarity floor. */
const noisyBand = sessions(12, () => [near(RELEVANT, 0.9, 0.9), near(RELEVANT, 0.88, 0.9), near(OFF, 0.785)]);

describe('the replay maths', () => {
  test('factLabel: a fact in the folder or service of an edited file is relevant; project-wide facts say nothing', () => {
    expect(factLabel('src/api/fact.ts', ['src/api/edit.ts'])).toBe(true);
    expect(factLabel('lib/other/fact.ts', ['src/api/edit.ts'])).toBe(false);
    expect(factLabel('.', ['src/api/edit.ts'])).toBeNull();
    expect(factLabel('package.json', ['src/api/edit.ts'])).toBeNull();
    expect(factLabel('', [])).toBeNull();
  });
  test('floorGain is 0 at the current floor, positive where the band dropped is worse than the rest', () => {
    const facts: ReplayFact[] = [{ score: 0.9, rankingScore: 0.9, relevant: true }, { score: 0.785, rankingScore: 0.85, relevant: false }];
    expect(floorGain(facts, 'score', 0.78, 0.5)).toBe(0);
    expect(floorGain(facts, 'score', 0.79, 0.5)).toBe(0.5);
    expect(precisionAt(facts, 'score', 0.79, { key: 'rankingScore', v: 0.8 })).toBe(1);
    expect(precisionAt(facts, 'score', 0.95, { key: 'rankingScore', v: 0.8 })).toBe(0);
  });
  test('bestFloor: the smallest move with the best gain, only over a band of 5; no gain, no move', () => {
    const facts: ReplayFact[] = [
      ...Array.from({ length: 10 }, () => ({ score: 0.9, rankingScore: 0.9, relevant: true })),
      ...Array.from({ length: 5 }, () => ({ score: 0.785, rankingScore: 0.9, relevant: false })),
    ];
    expect(bestFloor(facts, 'score', 0.78, 0.78)).toEqual({ floor: 0.79, gain: expect.any(Number) });
    expect(bestFloor(facts.slice(0, 14), 'score', 0.78, 0.78).floor).toBe(0.78);
    expect(bestFloor(facts.slice(0, 10), 'score', 0.78, 0.78)).toEqual({ floor: 0.78, gain: 0 });
    // Nothing kept at the current floor: precision 0 there, so any relevant fact a lower floor adds gains.
    const under = Array.from({ length: 5 }, () => ({ score: 0.76, rankingScore: 0.9, relevant: true }));
    expect(bestFloor(under, 'score', 0.78, 0.78).floor).toBe(0.76);
  });
});

describe('thresholdCandidate', () => {
  test('a fact served is replayed once, as served, even when the entry also lists it as one a lower floor would add', async () => {
    const f = (id: string, x: F): F => ({ ...x, id });
    const history = sessions(12, () => [f('a', near(RELEVANT, 0.9, 0.9)), f('b', near(RELEVANT, 0.88, 0.9)), f('c', near(OFF, 0.785))], { below: [f('b', near(RELEVANT, 0.765))] });
    const c = (await thresholdCandidate(ctxWith(history), 'demo', { similarityFloor: null, factRankFloor: null }))!;
    expect(c.features).toMatchObject({ facts: 36 / 200, precisionBefore: 0.667 });
  });
  test('an off-topic band just above the similarity floor: raise it, within the margin, the rank floor kept', async () => {
    const c = (await thresholdCandidate(ctxWith(noisyBand), 'demo', { similarityFloor: null, factRankFloor: null }))!;
    expect(c.targets).toEqual([{ kind: 'project', id: 'demo', role: 'primary' }]);
    expect(c.before).toEqual([thresholdsSnapshot('demo', { similarityFloor: null, factRankFloor: null })]);
    expect(c.after).toEqual([thresholdsSnapshot('demo', { similarityFloor: 0.79, factRankFloor: null })]);
    expect(c.subject).toBe('demo: similarity floor 0.78 -> 0.79');
    expect(c.features).toMatchObject({ precisionBefore: 0.667, precisionAfter: 1, facts: 36 / 200, sessions: 12 / 50 });
    expect(c.rationale).toContain('from 67% to 100%');
    expect(c.evidence).toHaveLength(12);
    expect(c.evidence[0]).toMatchObject({ kind: 'session', role: 'replayed for similarity floor 0.78 -> 0.79' });
  });
  test('relevant facts just under both floors: lower them, never past the margin', async () => {
    const history = sessions(12, () => [near(RELEVANT, 0.9, 0.9), near(OFF, 0.9, 0.9)], { below: [near(RELEVANT, 0.77, 0.9), near(RELEVANT, 0.9, 0.79), { id: 'f', path: RELEVANT, score: 0.7, rankingScore: 0.7 }] });
    const c = (await thresholdCandidate(ctxWith(history), 'demo', { similarityFloor: null, factRankFloor: null }))!;
    expect(c.after[0].fields).toEqual({ similarityFloor: 0.77, factRankFloor: 0.79 });
    expect(c.subject).toBe('demo: similarity floor 0.78 -> 0.77, fact rank floor 0.8 -> 0.79');
    expect(score(tuneThreshold, c.features)).toBeGreaterThan(0);
  });
  test("a project's own floor back at the default is stored as none", async () => {
    const history = sessions(12, () => [near(RELEVANT, 0.9, 0.9), near(RELEVANT, 0.88, 0.9), near(OFF, 0.775, 0.9)], { floors: { similarity: 0.77, factRank: 0.8 } });
    const c = (await thresholdCandidate(ctxWith(history), 'demo', { similarityFloor: 0.77, factRankFloor: null }))!;
    expect(c.before[0].fields).toEqual({ similarityFloor: 0.77, factRankFloor: null });
    expect(c.after[0].fields).toEqual({ similarityFloor: null, factRankFloor: null });
  });
  test('an off-topic band just above the rank floor only: the rank floor moves, the similarity floor stays', async () => {
    const history = sessions(12, () => [near(RELEVANT, 0.9, 0.9), near(RELEVANT, 0.88, 0.9), near(OFF, 0.9, 0.805)]);
    const c = (await thresholdCandidate(ctxWith(history), 'demo', { similarityFloor: null, factRankFloor: null }))!;
    expect(c.after[0].fields).toEqual({ similarityFloor: null, factRankFloor: 0.81 });
    expect(c.subject).toBe('demo: fact rank floor 0.8 -> 0.81');
  });
  test(`too little replay: under ${REPLAY_FACTS_MIN} facts or ${REPLAY_SESSIONS_MIN} sessions, no call`, async () => {
    expect(await thresholdCandidate(ctxWith(noisyBand.slice(0, 9)), 'demo', { similarityFloor: null, factRankFloor: null })).toBeNull();
    const few = sessions(12, () => [near(RELEVANT, 0.9), near(OFF, 0.785)]);
    expect(await thresholdCandidate(ctxWith(few), 'demo', { similarityFloor: null, factRankFloor: null })).toBeNull();
  });
  test('nothing to gain: no call', async () => {
    const clean = sessions(12, () => [near(RELEVANT, 0.9, 0.9), near(RELEVANT, 0.85, 0.9), near(RELEVANT, 0.785)]);
    expect(await thresholdCandidate(ctxWith(clean), 'demo', { similarityFloor: null, factRankFloor: null })).toBeNull();
  });
  test('left out of the replay: too young, too old, another floor, older entries without floors, no session, no edits, unscored and project-wide facts', async () => {
    const skipped = [
      served('young', [near(OFF, 0.785)], { ts: DAYS_AGO(0.5) }),
      served('old', [near(OFF, 0.785)], { ts: DAYS_AGO(40) }),
      served('other-floor', [near(OFF, 0.785)], { floors: { similarity: 0.8, factRank: 0.8 } }),
      served('no-floors', [near(OFF, 0.785)], { floors: null }),
      served('none', [near(OFF, 0.785)], { targets: ['lesson:x'] }),
      served('no-edits', [near(OFF, 0.785)]),
      served('unscored', [{ path: OFF } as F, { path: '.', score: 0.785, rankingScore: 0.85 }, { score: 0.785, rankingScore: 0.85 } as F]),
      served('elsewhere', [near(OFF, 0.785)], { projectKey: 'other' }),
      activity('context_served', { ts: DAYS_AGO(2), projectKey: 'demo', targets: ['s-empty'], details: { floors: DEFAULT } }),
    ];
    const ctx = ctxWith([...noisyBand, ...skipped], { edited: (s) => (s === 'no-edits' ? [] : ['src/api/edit.ts']) });
    const c = (await thresholdCandidate(ctx, 'demo', { similarityFloor: null, factRankFloor: null }))!;
    expect(c.features.facts).toBe(36 / 200);
    expect(c.rationale).toContain('from 12 get_task_context calls in 12 sessions');
  });
});

describe('tuneThreshold.candidates', () => {
  test('the projects the round served context in, once each; out of scope, and one with a call open, left alone', async () => {
    const entries = [activity('context_served', { projectKey: 'demo' }), activity('context_served', { projectKey: 'demo' }), activity('context_served', { projectKey: 'other' }), activity('predone_check', { projectKey: 'third' }), activity('context_served', { projectKey: null })];
    const r = await tuneThreshold.candidates(ctxWith(noisyBand, { entries, inScope: (k) => k === 'demo' }));
    expect(r.candidates.map((c) => c.projectKey)).toEqual(['demo']);
    expect(r).toMatchObject({ scanned: 2, skipped: { out_of_scope: 1 } });
    const open = await tuneThreshold.candidates(ctxWith(noisyBand, { open: [{ type: 'rank_weight', status: 'proposed' }, { type: 'tune_threshold', status: 'proposed' }] }));
    expect(open).toMatchObject({ candidates: [], skipped: { already_decided: 1 } });
    const settled = await tuneThreshold.candidates(ctxWith(noisyBand, { open: [{ type: 'tune_threshold', status: 'rolled_back' }] }));
    expect(settled.candidates).toHaveLength(1);
  });
  test('too little replay: below the floor', async () => {
    expect(await tuneThreshold.candidates(ctxWith([]))).toEqual({ candidates: [], scanned: 1, skipped: { below_floor: 1 } });
  });
  test('recheck: an observed move, with no context served this round, is replayed again; too little replay or out of scope no longer holds', async () => {
    const c = (await thresholdCandidate(ctxWith(noisyBand), 'demo', { similarityFloor: null, factRankFloor: null }))!;
    const observed = [observedAs('tune_threshold', c)];
    const again = await tuneThreshold.recheck!(ctxWith(noisyBand, { entries: [], open: observed }), observed);
    expect(again[0]).toMatchObject({ targets: c.targets, before: c.before, after: c.after });
    expect(await tuneThreshold.recheck!(ctxWith([], { entries: [] }), observed)).toEqual(['no_longer_holds']);
    expect(await tuneThreshold.recheck!(ctxWith(noisyBand, { entries: [], inScope: () => false }), observed)).toEqual(['out_of_scope']);
  });
  test('nothing new: nothing read', async () => {
    expect(await tuneThreshold.candidates(fakeContext())).toEqual({ candidates: [], scanned: 0, skipped: {} });
  });
});
