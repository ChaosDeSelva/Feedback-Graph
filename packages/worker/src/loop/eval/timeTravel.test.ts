import { expect, test } from 'vitest';
import type { Activity, Candidate, Decision, Lesson, LoopMiss, MissLink } from '@fb/core';
import { LessonHistory, MemoryDecisions, memoryCursors, overlay, ReplayReadOnly, rewindCandidate, statusSet, timeTravel } from './timeTravel.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const BEFORE = '2026-10-20T00:00:00.000Z';
const AFTER = '2026-11-05T00:00:00.000Z';
let n = 0;
const entry = (o: Partial<Activity>): Activity => ({
  id: `act:${++n}`, ts: AFTER, kind: 'lesson_decided', actor: 'you', projectKey: 'p', subject: 'approved lesson "x"', why: '', details: {}, targets: ['lesson:a'], ...o,
});
const lesson = (o: Partial<Lesson> = {}): Lesson => ({
  id: 'lesson:a', projectKey: 'p', title: 'T', rule: 'now', appliesWhen: 'w', scope: 'project', paths: ['a.ts'], status: 'approved', source: 'postmortem',
  cause: null, missId: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: AFTER, decidedBy: 'you', ...o,
});
const decision = (o: Partial<Decision>): Decision => ({
  id: `dec:${++n}`, type: 'reword_lesson', projectKey: 'p', targets: [{ kind: 'lesson', id: 'lesson:a', role: 'primary' }], before: [], after: [], evidence: [], features: {},
  score: 0.5, confidence: { p: 0.5, lower: 0.4, n: 0, band: 2 }, tier: 'A', mode: 'auto', rationale: '', model: null, policyVersion: 1, status: 'applied', dependsOn: [],
  createdAt: BEFORE, appliedAt: null, decidedAt: null, decidedBy: null, supersededBy: null, rollback: null, ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null, ...o,
});
const candidate = (o: Partial<Candidate>): Candidate => ({ id: 'c', createdAt: BEFORE, status: 'confirmed', decidedAt: AFTER, decidedBy: 'you', projectKey: 'p', ...o } as Candidate);

test('statusSet: the status a decision entry set, none for an edit, a note or another kind', () => {
  expect(statusSet(entry({ details: { status: 'approved' } }))).toBe('approved');
  expect(statusSet(entry({ subject: 'edited lesson "x"', details: { status: 'approved' } }))).toBeNull();
  expect(statusSet(entry({ subject: 'duplicate feedback memory: x' }))).toBeNull();
  expect(statusSet(entry({ kind: 'lesson_to_fact' }))).toBe('rejected');
  expect(statusSet(entry({ kind: 'feedback_decided', details: { status: 'confirmed' } }))).toBeNull();
});

test('LessonHistory rewinds a lesson through the edits and decisions after the cut, newest first', () => {
  const h = new LessonHistory(T0, [
    entry({ ts: BEFORE, details: { status: 'approved' }, actor: 'operator:codex' }),
    entry({ ts: '2026-11-02T00:00:00.000Z', subject: 'edited lesson "x"', details: { changed: { rule: { from: 'then', to: 'mid' }, paths: { from: [], to: ['a.ts'] } } } }),
    entry({ ts: '2026-11-03T00:00:00.000Z', subject: 'revoked lesson "x"', details: { status: 'revoked', changed: { rule: { from: 'mid', to: 'now' }, odd: null } } }),
    entry({ kind: 'context_served', targets: ['lesson:a'] }),
    entry({ targets: [] }),
  ], [
    decision({ appliedAt: '2026-11-04T00:00:00.000Z', before: [{ kind: 'lesson', id: 'lesson:a', fields: { title: 'T before loop' }, fingerprint: 'f' }] }),
    decision({ appliedAt: BEFORE, before: [{ kind: 'lesson', id: 'lesson:a', fields: { title: 'ignored' }, fingerprint: 'f' }] }),
    decision({ appliedAt: AFTER, before: [] }),
    decision({ type: 'link_misses', targets: [{ kind: 'miss', id: 'miss:a', role: 'primary' }] }),
  ]);
  const now = lesson({ status: 'revoked', title: 'T after loop' });
  expect(h.rewind(now)).toMatchObject({ status: 'approved', rule: 'then', paths: [], title: 'T before loop', decidedAt: BEFORE, decidedBy: 'operator:codex' });
  expect(now.paths).toEqual(['a.ts']);
  expect(h.rewind(lesson({ createdAt: AFTER }))).toBeNull();
  expect(h.rewind(lesson({ id: 'lesson:untouched' }))).toMatchObject({ status: 'approved', decidedAt: AFTER });

  // No earlier decision: a revoked lesson was approved, any other decided one was proposed, undecided.
  const fresh = new LessonHistory(T0, [entry({ details: { status: 'revoked' }, targets: ['lesson:r'] }), entry({ kind: 'lesson_to_fact', targets: ['lesson:f', 'fact:1'] })], []);
  expect(fresh.rewind(lesson({ id: 'lesson:r', status: 'revoked' }))).toMatchObject({ status: 'approved', decidedAt: null, decidedBy: null });
  expect(fresh.rewind(lesson({ id: 'lesson:f', status: 'rejected' }))).toMatchObject({ status: 'proposed', decidedAt: null });

  // Applied before the cut and rolled back after it: at the cut it was as the decision left it.
  const rolled = new LessonHistory(T0, [], [decision({
    appliedAt: BEFORE, rollback: { at: AFTER, by: 'you', reason: null, note: null, cascade: [] }, status: 'rolled_back',
    after: [{ kind: 'lesson', id: 'lesson:a', fields: { rule: 'as the loop wrote it' }, fingerprint: 'f' }],
  }), decision({ rollback: { at: AFTER, by: 'you', reason: null, note: null, cascade: [] }, after: [] })]);
  expect(rolled.rewind(lesson())).toMatchObject({ rule: 'as the loop wrote it' });
});

test('rewindCandidate: an item made after the cut is left out; one decided after it is pending again', () => {
  expect(rewindCandidate(candidate({ createdAt: AFTER }), T0)).toBeNull();
  expect(rewindCandidate(candidate({}), T0)).toMatchObject({ status: 'pending', decidedAt: null, decidedBy: null });
  expect(rewindCandidate(candidate({ decidedAt: BEFORE }), T0)).toMatchObject({ status: 'confirmed', decidedAt: BEFORE });
  expect(rewindCandidate(candidate({ status: 'pending', decidedAt: null }), T0)).toMatchObject({ status: 'pending' });
});

test('overlay replaces some members and binds the rest to the target', () => {
  class Repo { x = 2; twice() { return this.x * 2; } thrice() { return this.x * 3; } }
  const o = overlay(new Repo(), { thrice: () => 0 });
  expect([o.twice(), o.thrice(), o.x]).toEqual([4, 0, 2]);
});

test('MemoryDecisions keeps the loop\'s records in memory, reads misses and links as of the cut, and never writes the store', async () => {
  const links: MissLink[] = [{ from: 'miss:b', to: 'miss:a', decisionId: 'dec:x', createdAt: BEFORE }, { from: 'miss:b', to: 'miss:c', decisionId: 'dec:y', createdAt: AFTER }];
  const misses = [{ id: 'miss:a', createdAt: BEFORE }, { id: 'miss:late', createdAt: AFTER }] as LoopMiss[];
  const m = new MemoryDecisions({ missLinks: async () => links, loopMisses: async () => misses, distinctPairs: async () => [] }, T0);
  const input = {
    type: 'link_misses' as const, projectKey: 'p', targets: [{ kind: 'miss' as const, id: 'miss:b', role: 'primary' as const }], before: [], after: [],
    evidence: [], features: {}, score: 0.5, confidence: { p: 0.5, lower: 0.4, n: 0, band: 2 }, tier: 'H' as const, mode: 'observe' as const,
    rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'observed' as const, dependsOn: ['dec:0', 'dec:0'],
  };
  const { decision: d, created } = await m.propose(input);
  expect(created).toBe(true);
  expect(d).toMatchObject({ status: 'observed', createdAt: '2026-11-01T00:00:00.000Z', dependsOn: ['dec:0'] });
  expect((await m.propose(input)).created).toBe(false);
  const { decision: e } = await m.propose({ ...input, projectKey: null, targets: [{ kind: 'lesson', id: 'lesson:a', role: 'primary' }], type: 'retire_lesson', mode: 'propose', status: 'proposed', dependsOn: undefined, confidence: { ...input.confidence, band: 4 } });
  expect(e.dependsOn).toEqual([]);
  expect(await m.get(d.id)).toEqual(d);
  expect(await m.get('dec:none')).toBeNull();
  expect((await m.list()).map((x) => x.id)).toEqual([d.id, e.id].sort().reverse());
  expect((await m.list({ status: ['proposed'] })).map((x) => x.id)).toEqual([e.id]);
  expect(await m.list({ type: 'link_misses', projectKey: 'p', mode: 'observe', band: 2, target: 'miss:b', since: BEFORE })).toEqual([d]);
  expect(await m.list({ since: AFTER })).toEqual([]);
  expect(await m.list({ offset: 1, limit: 1 })).toHaveLength(1);
  expect(await m.forTarget('lesson:a')).toEqual([e]);
  expect(await m.dependents('dec:0')).toEqual([d]);

  expect(await m.markApplied(d.id, [])).toBe(false);
  expect(await m.markApplying(d.id)).toBe(true);
  expect(await m.inFlight()).toEqual([expect.objectContaining({ id: d.id })]);
  expect(await m.markApplied(d.id, [], { syncHoldUntil: AFTER })).toBe(true);
  expect(await m.markApplied(e.id, [])).toBe(false);
  expect(await m.ratify(d.id, 'you')).toBe(true);
  expect(await m.get(d.id)).toMatchObject({ status: 'applied', appliedAt: '2026-11-01T00:00:00.000Z', syncHoldUntil: AFTER, ratifiedBy: 'you' });
  expect(await m.markStatus(d.id, { status: 'rolled_back', from: ['applied'], by: 'you', rollback: { at: AFTER, by: 'you', reason: null, note: null, cascade: [] }, supersededBy: 'dec:z' })).toBe(true);
  expect(await m.get(d.id)).toMatchObject({ status: 'rolled_back', decidedBy: 'you', supersededBy: 'dec:z', rollback: { at: AFTER } });
  expect(await m.markStatus(e.id, { status: 'rejected', from: ['proposed'] })).toBe(true);
  expect(await m.get(e.id)).toMatchObject({ status: 'rejected', decidedBy: null });
  await m.markApplied(d.id, []);
  expect(await m.markStatus('dec:none', { status: 'rejected', from: ['proposed'] })).toBe(false);

  expect(await m.addNote('dec:none', { by: 'you', text: 'x' })).toBeNull();
  const note = await m.addNote(d.id, { by: 'you', text: 'fine', verdict: 'agree' });
  await m.addNote(e.id, { by: 'you', text: 'no' });
  expect(await m.notes(d.id)).toEqual([note]);
  expect(note).toMatchObject({ verdict: 'agree', reason: null });

  expect(await m.signals('lesson:a')).toBeNull();
  expect(await m.upsertSignals([{ lessonId: 'lesson:a', counts: { served: 1 } as never, lastServed: null, lastOwnerTouch: null }])).toBe(1);
  expect(await m.signals('lesson:a')).toMatchObject({ counts: { served: 1 } });
  await expect(m.listSignals()).rejects.toThrow(ReplayReadOnly);

  const bump = { type: 'link_misses' as const, policyVersion: 1, prior: { alpha: 4, beta: 1 }, alpha: 1, beta: 0, n: 1 };
  await m.bumpCalibration({ ...bump, band: 3 });
  expect(await m.bumpCalibration({ ...bump, band: 1 })).toMatchObject({ alpha: 5, beta: 1, n: 1 });
  expect(await m.bumpCalibration({ ...bump, band: 1 })).toMatchObject({ alpha: 6, n: 2 });
  expect((await m.calibration('link_misses', 1)).map((b) => b.band)).toEqual([1, 3]);
  expect(await m.calibration('link_misses', 2)).toEqual([]);

  await expect(m.linkMisses()).rejects.toThrow(/never writes/);
  await expect(m.unlinkMisses()).rejects.toThrow(ReplayReadOnly);
  await expect(m.redactStoredDecisions()).rejects.toThrow(ReplayReadOnly);
  expect(await m.missLinks('miss:b')).toEqual([links[0]]);
  expect(await m.loopMisses(['miss:a', 'miss:late'])).toEqual([misses[0]]);

  const c = memoryCursors();
  expect(await c.getCursor('k')).toBeNull();
  await c.setCursor('k', 'v');
  expect(await c.getCursor('k')).toBe('v');
});

test('timeTravel answers the types\' reads as of the cut, and keeps the loop\'s Activity in memory', async () => {
  const lessons = [lesson({ id: 'lesson:a' }), lesson({ id: 'lesson:late', createdAt: AFTER }), lesson({ id: 'lesson:p', status: 'proposed', decidedAt: null })];
  const history = new LessonHistory(T0, [entry({ details: { status: 'approved' }, targets: ['lesson:a'] })], []);
  const seen: Record<string, unknown> = {};
  const fake = {
    knowledge: {
      listLessons: async (f: unknown) => { seen.listLessons = f; return lessons; },
      lessonDetail: async (id: string) => { const l = lessons.find((x) => x.id === id); return l ? { lesson: l, miss: null } : null; },
      similarLessons: async () => [{ id: 'lesson:a', cosine: 0.95, status: 'approved', createdAt: BEFORE }, { id: 'lesson:late', cosine: 0.93, status: 'approved', createdAt: AFTER }],
      searchLessons: async (q: unknown) => { seen.searchLessons = q; return lessons.map((l) => ({ lesson: l, score: 0.9 })); },
      relatedMisses: async () => [{ missId: 'miss:a', ts: BEFORE }, { missId: 'miss:late', ts: AFTER }],
      decidedLessons: async (q: unknown) => { seen.decidedLessons = q; return [{ lesson: lessons[0], score: null }, { lesson: lesson({ id: 'lesson:old', decidedAt: BEFORE }), score: null }, { lesson: lesson({ id: 'lesson:odd', status: 'revoked', decidedAt: BEFORE }), score: null }]; },
      other: () => 'passed through',
    },
    graph: {
      listCandidates: async (f: unknown) => { seen.listCandidates = f; return [candidate({ id: 'c1' }), candidate({ id: 'c2', createdAt: AFTER }), candidate({ id: 'c3', decidedAt: BEFORE }), candidate({ id: 'c4' })]; },
      candidateDetail: async (id: string) => (id === 'none' ? null : { candidate: candidate({ id, ...(id === 'late' && { createdAt: AFTER }) }) }),
    },
    facts: { listFacts: async () => [{ id: 'f1', createdAt: BEFORE }, { id: 'f2', createdAt: AFTER }, { id: 'f3', createdAt: BEFORE }] },
    activity: {
      since: async (q: unknown) => { seen.since = q; return { entries: [], next: null }; },
      list: async (q: unknown) => { seen.list = q; return []; },
      record: async () => { throw new Error('never'); },
    },
    decisions: { missLinks: async () => [], loopMisses: async () => [] },
    codegraph: {}, insights: {},
  };
  const tt = timeTravel(fake as never, T0, history);
  const k = tt.store.knowledge;
  expect((await k.listLessons({ status: 'proposed', limit: 5 })).map((l) => l.id)).toEqual(['lesson:a', 'lesson:p']);
  expect(seen.listLessons).toEqual({ status: undefined, limit: 100_000 });
  expect((await k.listLessons({})).map((l) => l.id)).toEqual(['lesson:a', 'lesson:p']);
  expect((await k.lessonDetail('lesson:a'))?.lesson.status).toBe('proposed');
  expect(await k.lessonDetail('lesson:late')).toBeNull();
  expect(await k.lessonDetail('lesson:none')).toBeNull();
  expect(await k.similarLessons!('lesson:p', 3)).toEqual([{ id: 'lesson:a', cosine: 0.95, status: 'proposed', createdAt: BEFORE }]);
  expect((await k.searchLessons({ embedding: [], projectKey: 'p', k: 1, status: 'approved' })).map((h) => h.lesson.id)).toEqual([]);
  expect(seen.searchLessons).toMatchObject({ status: undefined, k: 4 });
  expect((await k.searchLessons({ embedding: [], projectKey: 'p', k: 5 })).map((h) => h.lesson.id)).toEqual(['lesson:a', 'lesson:p']);
  expect((await k.relatedMisses({ embedding: [], projectKey: 'p', k: 5 })).map((m) => m.missId)).toEqual(['miss:a']);
  expect((await k.decidedLessons!({ projectKeys: null, since: BEFORE, limit: 5 })).map((r) => r.lesson.id)).toEqual(['lesson:old']);
  expect((k as unknown as { other: () => string }).other()).toBe('passed through');

  expect((await tt.store.graph.listCandidates({ status: 'pending', limit: 1, offset: 1 })).map((c) => c.id)).toEqual(['c4']);
  expect((await tt.store.graph.listCandidates()).map((c) => c.id)).toEqual(['c1', 'c3', 'c4']);
  expect(seen.listCandidates).toEqual({ status: undefined, limit: 100_000, offset: 0 });
  expect((await tt.store.graph.candidateDetail('c9'))?.candidate.status).toBe('pending');
  expect(await tt.store.graph.candidateDetail('late')).toBeNull();
  expect(await tt.store.graph.candidateDetail('none')).toBeNull();
  expect((await tt.store.facts.listFacts({ projectKey: 'p', offset: 1, limit: 1 })).map((f) => f.id)).toEqual(['f3']);
  expect((await tt.store.facts.listFacts({ projectKey: 'p' })).map((f) => f.id)).toEqual(['f1', 'f3']);

  await tt.store.activity.since({ limit: 5 });
  expect(seen.since).toEqual({ limit: 5, until: '2026-11-01T00:00:00.000Z' });
  await tt.store.activity.since({ limit: 5, until: BEFORE });
  expect(seen.since).toEqual({ limit: 5, until: BEFORE });
  await tt.store.activity.list({ before: AFTER });
  expect(seen.list).toEqual({ before: '2026-11-01T00:00:00.000Z' });
  await tt.store.activity.record({ kind: 'decision_made', actor: 'loop:1', projectKey: null, subject: 's', why: 'w' });
  expect(tt.recorded).toEqual([expect.objectContaining({ kind: 'decision_made' })]);

  // A store without similarLessons or decidedLessons: none are offered.
  const bare = timeTravel({ ...fake, knowledge: { ...fake.knowledge, similarLessons: undefined, decidedLessons: undefined } } as never, T0, history);
  expect(await bare.store.knowledge.similarLessons!('lesson:a', 3)).toEqual([]);
  expect(bare.store.knowledge.decidedLessons).toBeUndefined();
});
