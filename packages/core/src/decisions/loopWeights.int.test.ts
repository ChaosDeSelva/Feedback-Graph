import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { Decision, DecisionInput, DecisionTarget, Lesson, TargetSnapshot } from '../types.ts';
import { thresholdsSnapshot } from '../loop/snapshots.ts';
import { decisionExecutor, type DecisionExecutor } from './executor.ts';
import { lessonFingerprint, TargetChangedError } from './record.ts';
import { lessonSnapshot, snapshotTarget } from './snapshot.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const T0 = '2026-11-01T00:00:00.000Z';

/** The learning loop's ranking writes on both stores: Lesson.servingWeight (rank_weight) and a project's own floors (tune_threshold). */
describeStores('loop serving weights and project floors', (h) => {
  let s: Store;
  let x: DecisionExecutor;
  beforeAll(() => {
    s = h.store;
    x = decisionExecutor(s);
  });
  const lesson = async (id: string) => {
    await s.knowledge.upsertLesson({
      id, projectKey: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing the API', scope: 'project',
      paths: ['src/api.ts'], status: 'approved', source: 'memory', embedding: vec(1),
    });
    return (await s.knowledge.lessonDetail(id))!.lesson;
  };
  const getLesson = async (id: string) => (await s.knowledge.lessonDetail(id))!.lesson;
  let seq = 0;
  const propose = async (type: Decision['type'], targets: DecisionTarget[], before: TargetSnapshot[], after: TargetSnapshot[]) => {
    const input: DecisionInput = {
      type, projectKey: 'demo', targets, before, after, evidence: [{ kind: 'lesson', id: `ev:${++seq}`, role: 'because', weight: 1, observedAt: T0 }],
      features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 }, tier: 'H', mode: 'auto', rationale: 'r', model: 'deterministic',
      policyVersion: 1, status: 'proposed',
    };
    return (await s.decisions.propose(input)).decision;
  };
  const weigh = async (l: Lesson, w: number) => propose('rank_weight', [{ kind: 'lesson', id: l.id, role: 'primary' }], [lessonSnapshot(l)], [lessonSnapshot({ ...l, servingWeight: w })]);

  test('a lesson has no serving weight until one is written; the weight is part of its fingerprint and snapshot', async () => {
    const l = await lesson('lesson:w0');
    expect(l.servingWeight).toBeUndefined();
    expect(lessonSnapshot(l).fields.servingWeight).toBeNull();
    expect(lessonFingerprint({ ...l, servingWeight: 1.1 })).not.toBe(lessonFingerprint(l));
  });

  test('rank_weight applies the weight exactly, every read serves it, and rollback restores none at all', async () => {
    const l = await lesson('lesson:w1');
    const d = await weigh(l, 1.1);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect(applied.status).toBe('applied');
    const now = await getLesson('lesson:w1');
    expect(now.servingWeight).toBe(1.1);
    // Nothing else about the lesson moved, its decision included.
    expect({ ...now, servingWeight: undefined }).toEqual({ ...l, servingWeight: undefined });
    // The serving path's reads carry it: the search, the list (the code map's lessons for named files).
    expect((await s.knowledge.searchLessons({ embedding: vec(1), projectKey: 'demo', k: 10 })).find((x) => x.lesson.id === 'lesson:w1')?.lesson.servingWeight).toBe(1.1);
    expect((await s.knowledge.listLessons({ status: 'approved', projectKey: 'demo' })).find((x) => x.id === 'lesson:w1')?.servingWeight).toBe(1.1);
    expect((await snapshotTarget(s, { kind: 'lesson', id: 'lesson:w1' })).fingerprint).toBe(d.after[0].fingerprint);

    await x.rollback(applied, { by: 'you', reason: 'other', cascade: 'apply' });
    expect((await getLesson('lesson:w1')).servingWeight).toBeUndefined();
    expect((await snapshotTarget(s, { kind: 'lesson', id: 'lesson:w1' })).fingerprint).toBe(d.before[0].fingerprint);
  });

  test("a second step starts where the first left the lesson; rolling it back restores the first one's weight exactly", async () => {
    const l = await lesson('lesson:w2');
    const first = await x.apply(await weigh(l, 1.1), { by: 'loop:1' });
    const mid = await getLesson('lesson:w2');
    const second = await propose('rank_weight', [{ kind: 'lesson', id: l.id, role: 'primary' }], [lessonSnapshot(mid)], [lessonSnapshot({ ...mid, servingWeight: 1.2 })]);
    expect(second.before[0].fingerprint).toBe(first.after[0].fingerprint);
    const appliedSecond = await x.apply(second, { by: 'loop:1' });
    expect((await getLesson('lesson:w2')).servingWeight).toBe(1.2);
    await x.rollback(appliedSecond, { by: 'you', reason: 'other', cascade: 'apply' });
    expect((await getLesson('lesson:w2')).servingWeight).toBe(1.1);
  });

  test('a weight written over a lesson changed since its snapshot is refused, nothing written', async () => {
    const l = await lesson('lesson:w3');
    const stale = lessonSnapshot(l);
    await s.knowledge.updateLesson('lesson:w3', { rule: 'the owner rewrote it' }, {});
    const err = await s.knowledge.writeLessonSnapshots([{ id: l.id, fields: { ...stale.fields, servingWeight: 1.3 } as never, expect: stale.fingerprint }]).catch((e) => e);
    expect(err).toBeInstanceOf(TargetChangedError);
    expect((await getLesson('lesson:w3')).servingWeight).toBeUndefined();
  });

  test('a project has no floors of its own until written, and an unknown project reads as none', async () => {
    await s.facts.setPinned({ key: 'floors-a', name: 'floors-a', repoPath: '/x/floors-a' }, false);
    expect(await s.facts.projectThresholds('floors-a')).toEqual({ similarityFloor: null, factRankFloor: null });
    expect(await s.facts.projectThresholds('floors-unknown')).toEqual({ similarityFloor: null, factRankFloor: null });
  });

  test('setProjectThresholds writes only while the floors are as expected; an unknown project is refused', async () => {
    await s.facts.setPinned({ key: 'floors-b', name: 'floors-b', repoPath: '/x/floors-b' }, false);
    const none = thresholdsSnapshot('floors-b', { similarityFloor: null, factRankFloor: null });
    await s.facts.setProjectThresholds('floors-b', { similarityFloor: 0.8, factRankFloor: 0.77 }, { expect: none.fingerprint });
    expect(await s.facts.projectThresholds('floors-b')).toEqual({ similarityFloor: 0.8, factRankFloor: 0.77 });
    const err = await s.facts.setProjectThresholds('floors-b', { similarityFloor: 0.75, factRankFloor: null }, { expect: none.fingerprint }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetChangedError);
    expect(err).toMatchObject({ targetId: 'floors-b', actual: thresholdsSnapshot('floors-b', { similarityFloor: 0.8, factRankFloor: 0.77 }).fingerprint });
    expect(await s.facts.projectThresholds('floors-b')).toEqual({ similarityFloor: 0.8, factRankFloor: 0.77 });
    await expect(s.facts.setProjectThresholds('floors-gone', { similarityFloor: 0.8, factRankFloor: null }, { expect: none.fingerprint })).rejects.toMatchObject({ name: 'TargetChangedError', actual: null });
  });

  test('tune_threshold applies the floors through its handler, its target snapshots as the floors, and rollback restores the defaults', async () => {
    await s.facts.setPinned({ key: 'floors-c', name: 'floors-c', repoPath: '/x/floors-c' }, false);
    const before = thresholdsSnapshot('floors-c', { similarityFloor: null, factRankFloor: null });
    const after = thresholdsSnapshot('floors-c', { similarityFloor: 0.79, factRankFloor: null });
    const d = await propose('tune_threshold', [{ kind: 'project', id: 'floors-c', role: 'primary' }], [before], [after]);
    const applied = await x.apply(d, { by: 'you' });
    expect(applied.status).toBe('applied');
    expect(await s.facts.projectThresholds('floors-c')).toEqual({ similarityFloor: 0.79, factRankFloor: null });
    expect(await x.snapshot('project', 'floors-c')).toEqual(after);
    await x.rollback(applied, { by: 'you', reason: 'other', cascade: 'apply' });
    expect(await s.facts.projectThresholds('floors-c')).toEqual({ similarityFloor: null, factRankFloor: null });
  });

  test('tune_threshold over floors changed since: rollback refused; restore anyway writes the defaults back', async () => {
    await s.facts.setPinned({ key: 'floors-d', name: 'floors-d', repoPath: '/x/floors-d' }, false);
    const before = thresholdsSnapshot('floors-d', { similarityFloor: null, factRankFloor: null });
    const after = thresholdsSnapshot('floors-d', { similarityFloor: null, factRankFloor: 0.83 });
    const applied = await x.apply(await propose('tune_threshold', [{ kind: 'project', id: 'floors-d', role: 'primary' }], [before], [after]), { by: 'you' });
    await s.facts.setProjectThresholds('floors-d', { similarityFloor: 0.8, factRankFloor: 0.83 }, { expect: after.fingerprint });
    await expect(x.rollback(applied, { by: 'you', reason: 'other', cascade: 'apply' })).rejects.toBeInstanceOf(TargetChangedError);
    expect(await s.facts.projectThresholds('floors-d')).toEqual({ similarityFloor: 0.8, factRankFloor: 0.83 });
    await x.rollback((await s.decisions.get(applied.id))!, { by: 'you', reason: 'other', cascade: 'apply', restoreAnyway: true });
    expect(await s.facts.projectThresholds('floors-d')).toEqual({ similarityFloor: null, factRankFloor: null });
  });
});
