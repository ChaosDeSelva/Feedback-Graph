import { beforeAll, expect, test } from 'vitest';
import type { LessonInput } from '../../graph/knowledge.ts';
import type { Store } from '../../store.ts';
import { describeStores } from '../../testing/index.ts';
import type { Decision, DecisionInput, DecisionTarget, Lesson } from '../../types.ts';
import { decisionExecutor, type DecisionExecutor } from '../executor.ts';
import { TargetChangedError } from '../record.ts';
import { lessonSnapshot, snapshotTargets } from '../snapshot.ts';
import { handlerFor } from './index.ts';
import { mergeDuplicates } from './merge_duplicates.ts';
import { rejectLesson } from './reject_lesson.ts';
import { retireLesson } from './retire_lesson.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const T0 = '2026-11-01T00:00:00.000Z';
const byLoop = (status: Lesson['status'], note: string) => ({ status, decidedAt: T0, decidedBy: 'loop:1', decisionNote: note });

describeStores('merge_duplicates, retire_lesson and reject_lesson handlers', (h) => {
  let s: Store;
  let x: DecisionExecutor;
  beforeAll(() => {
    s = h.store;
    x = decisionExecutor(s);
  });
  const lesson = async (id: string, over: Partial<LessonInput> = {}) => {
    await s.knowledge.upsertLesson({
      id, projectKey: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing the API', scope: 'project',
      paths: ['src/api.ts'], status: 'proposed', source: 'memory', embedding: vec(1), ...over,
    });
    return (await s.knowledge.lessonDetail(id))!.lesson;
  };
  let seq = 0;
  const propose = async (type: Decision['type'], targets: DecisionTarget[], before: Lesson[], after: Lesson[]) => (await s.decisions.propose({
    type, projectKey: 'demo', targets, before: before.map(lessonSnapshot), after: after.map(lessonSnapshot),
    evidence: [{ kind: 'lesson', id: `ev:${++seq}`, role: 'because', weight: 1, observedAt: T0 }],
    features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 }, tier: 'H', mode: 'auto',
    rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
  } satisfies DecisionInput)).decision;

  test('each type is served by its own handler', () => {
    expect(handlerFor('merge_duplicates')).toBe(mergeDuplicates);
    expect(handlerFor('retire_lesson')).toBe(retireLesson);
    expect(handlerFor('reject_lesson')).toBe(rejectLesson);
  });

  test('retire: an approved lesson is revoked as the loop decided it; rollback restores the owner\'s approval to the letter', async () => {
    const l = await lesson('lesson:retire', { status: 'approved' });
    await s.knowledge.updateLesson(l.id, { status: 'approved' }, { by: 'you', note: 'good one' });
    const approved = (await s.knowledge.lessonDetail(l.id))!.lesson;
    const t: DecisionTarget[] = [{ kind: 'lesson', id: l.id, role: 'primary' }];
    const d = await propose('retire_lesson', t, [approved], [{ ...approved, ...byLoop('revoked', 'retired') }]);
    const applied = await x.apply(d, { by: 'loop:1', syncHoldUntil: '2026-11-20T00:00:00.000Z' });
    expect(applied).toMatchObject({ status: 'applied', syncHoldUntil: '2026-11-20T00:00:00.000Z' });
    expect((await s.knowledge.lessonDetail(l.id))!.lesson).toMatchObject({ status: 'revoked', decidedBy: 'loop:1', decisionNote: 'retired' });
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect(await snapshotTargets(s, t)).toEqual(d.before);
    expect((await s.knowledge.lessonDetail(l.id))!.lesson).toMatchObject({ status: 'approved', decidedBy: 'you', decisionNote: 'good one' });
  });

  test('reject: a proposed lesson is rejected; rollback makes it proposed and undecided again', async () => {
    const l = await lesson('lesson:reject');
    const t: DecisionTarget[] = [{ kind: 'lesson', id: l.id, role: 'primary' }];
    const d = await propose('reject_lesson', t, [l], [{ ...l, ...byLoop('rejected', 'platitude') }]);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect((await s.knowledge.lessonDetail(l.id))!.lesson).toMatchObject({ status: 'rejected', decidedBy: 'loop:1' });
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect((await s.knowledge.lessonDetail(l.id))!.lesson).toMatchObject({ status: 'proposed', decidedAt: null, decidedBy: null, decisionNote: null });
  });

  test('merge: the owner edited the keeper after it was applied, so the rollback is refused and nothing moves', async () => {
    const keeper = await lesson('lesson:mk', { status: 'approved', paths: ['src/a.ts'] });
    const dup = await lesson('lesson:md', { paths: ['src/b.ts'] });
    const t: DecisionTarget[] = [{ kind: 'lesson', id: keeper.id, role: 'keeper' }, { kind: 'lesson', id: dup.id, role: 'merged' }];
    const d = await propose('merge_duplicates', t, [keeper, dup], [{ ...keeper, paths: ['src/a.ts', 'src/b.ts'] }, { ...dup, ...byLoop('superseded', 'merged') }]);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect((await s.knowledge.lessonDetail(keeper.id))!.supersedes).toEqual([dup.id]);
    await s.knowledge.updateLesson(keeper.id, { rule: 'the owner\'s words' }, { by: 'you' });
    await expect(x.rollback(applied, { by: 'you', cascade: 'apply' })).rejects.toBeInstanceOf(TargetChangedError);
    expect((await s.knowledge.lessonDetail(keeper.id))!.supersedes).toEqual([dup.id]);
    expect((await s.knowledge.lessonDetail(dup.id))!.lesson.status).toBe('superseded');
  });

  test('merge: a duplicate the owner decided before it was applied is not merged, and the keeper is left alone', async () => {
    const keeper = await lesson('lesson:nk', { status: 'approved', paths: ['src/a.ts'] });
    const dup = await lesson('lesson:nd', { paths: ['src/b.ts'] });
    const t: DecisionTarget[] = [{ kind: 'lesson', id: keeper.id, role: 'keeper' }, { kind: 'lesson', id: dup.id, role: 'merged' }];
    const d = await propose('merge_duplicates', t, [keeper, dup], [{ ...keeper, paths: ['src/a.ts', 'src/b.ts'] }, { ...dup, ...byLoop('superseded', 'merged') }]);
    await s.knowledge.updateLesson(dup.id, { status: 'approved' }, { by: 'you' });
    await expect(x.apply(d, { by: 'loop:1' })).rejects.toBeInstanceOf(TargetChangedError);
    expect((await s.knowledge.lessonDetail(keeper.id))!.lesson.paths).toEqual(['src/a.ts']);
    expect((await s.knowledge.lessonDetail(keeper.id))!.supersedes).toEqual([]);
  });
});
