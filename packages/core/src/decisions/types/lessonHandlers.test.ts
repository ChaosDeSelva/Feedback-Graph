import { describe, expect, test } from 'vitest';
import type { Decision, Lesson, TargetSnapshot } from '../../types.ts';
import { lessonFingerprint, TargetChangedError } from '../record.ts';
import { mergeDuplicates } from './merge_duplicates.ts';
import { rejectLesson } from './reject_lesson.ts';
import { retireLesson } from './retire_lesson.ts';
import type { LessonSnapshotFields, LessonSnapshotWrite, SupersedeLink } from '../record.ts';
import type { HandlerContext } from './handler.ts';

/** writeLessonSnapshots as both stores define it: every lesson compared first, then all written, with the merge edges. */
function fakeStore(lessons: Lesson[]) {
  const byId = new Map(lessons.map((l) => [l.id, { ...l }]));
  const edges = new Set<string>();
  const calls: { writes: LessonSnapshotWrite[]; o: { supersede?: SupersedeLink[]; unsupersede?: SupersedeLink[] } }[] = [];
  const writeLessonSnapshots = async (writes: LessonSnapshotWrite[], o: { supersede?: SupersedeLink[]; unsupersede?: SupersedeLink[] } = {}) => {
    calls.push({ writes, o });
    for (const w of writes) {
      const cur = byId.get(w.id);
      const actual = cur ? lessonFingerprint(cur) : null;
      if (actual !== w.expect) throw new TargetChangedError(w.id, w.expect, actual);
    }
    for (const w of writes) byId.set(w.id, { ...byId.get(w.id)!, ...w.fields, servingWeight: w.fields.servingWeight ?? undefined });
    for (const s of o.supersede ?? []) edges.add(`${s.keeper}>${s.merged}`);
    for (const s of o.unsupersede ?? []) edges.delete(`${s.keeper}>${s.merged}`);
  };
  const c = { store: { knowledge: { writeLessonSnapshots } }, deps: {}, by: 'loop:1' } as unknown as HandlerContext;
  return { c, byId, edges, calls };
}

const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `t ${id}`, rule: `r ${id}`, appliesWhen: 'a', scope: 'project', paths: ['src/a.ts'], status: 'proposed',
  source: 'postmortem', cause: null, missId: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: null, decidedBy: null, decisionNote: null, ...o,
});
const fields = (l: Lesson): LessonSnapshotFields => ({
  projectKey: l.projectKey, title: l.title, rule: l.rule, appliesWhen: l.appliesWhen, scope: l.scope, paths: l.paths,
  status: l.status, decidedAt: l.decidedAt, decidedBy: l.decidedBy ?? null, decisionNote: l.decisionNote ?? null, servingWeight: l.servingWeight ?? null,
});
const snap = (l: Lesson): TargetSnapshot => ({ kind: 'lesson', id: l.id, fields: fields(l), fingerprint: lessonFingerprint(l) });
const decision = (type: Decision['type'], targets: Decision['targets'], before: Lesson[], after: Lesson[]) =>
  ({ id: 'dec:1', type, targets, before: before.map(snap), after: after.map(snap) }) as Decision;
const loopDecided = (status: Lesson['status'], note: string) => ({ status, decidedAt: '2026-11-11T00:00:00.000Z', decidedBy: 'loop:1', decisionNote: note });

describe('merge_duplicates handler', () => {
  const keeper = lesson('lesson:k', { status: 'approved', decidedAt: '2026-09-01T00:00:00.000Z', decidedBy: 'you' });
  const dup = lesson('lesson:d');
  const targets: Decision['targets'] = [{ kind: 'lesson', id: 'lesson:k', role: 'keeper' }, { kind: 'lesson', id: 'lesson:d', role: 'merged' }];
  const d = decision('merge_duplicates', targets, [keeper, dup], [keeper, { ...dup, ...loopDecided('superseded', 'merged into lesson:k') }]);

  test('apply writes both lessons (the unchanged keeper too) and the SUPERSEDES edge; rollback restores both and removes it', async () => {
    const s = fakeStore([keeper, dup]);
    await mergeDuplicates.apply(s.c, d);
    expect(s.calls[0].writes.map((w) => w.id)).toEqual(['lesson:k', 'lesson:d']);
    expect(s.byId.get('lesson:d')).toMatchObject({ status: 'superseded', decidedBy: 'loop:1' });
    expect([...s.edges]).toEqual(['lesson:k>lesson:d']);
    await mergeDuplicates.rollback(s.c, d, d.after);
    expect(lessonFingerprint(s.byId.get('lesson:d')!)).toBe(d.before[1].fingerprint);
    expect(lessonFingerprint(s.byId.get('lesson:k')!)).toBe(d.before[0].fingerprint);
    expect([...s.edges]).toEqual([]);
  });
  test('a lesson changed since: TargetChangedError and nothing written', async () => {
    const s = fakeStore([keeper, { ...dup, title: 'owner edit' }]);
    await expect(mergeDuplicates.apply(s.c, d)).rejects.toBeInstanceOf(TargetChangedError);
    expect(s.byId.get('lesson:k')).toEqual(keeper);
    expect(s.edges.size).toBe(0);
  });
  test('rollback from the targets as they are now (restore anyway) writes before over them', async () => {
    const edited = { ...keeper, paths: ['src/a.ts', 'src/z.ts'] };
    const gone = { ...dup, ...loopDecided('superseded', 'merged into lesson:k') };
    const s = fakeStore([edited, gone]);
    await mergeDuplicates.rollback(s.c, d, [snap(edited), snap(gone)]);
    expect(s.byId.get('lesson:k')!.paths).toEqual(['src/a.ts']);
  });
});

describe.each([
  ['retire_lesson', retireLesson, lesson('lesson:a', { status: 'approved', decidedAt: '2026-08-01T00:00:00.000Z', decidedBy: 'you' }), 'revoked'],
  ['reject_lesson', rejectLesson, lesson('lesson:a'), 'rejected'],
] as const)('%s handler', (type, handler, l, status) => {
  const d = decision(type, [{ kind: 'lesson', id: 'lesson:a', role: 'primary' }], [l], [{ ...l, ...loopDecided(status, 'by the loop') }]);
  test(`apply sets ${status} as the loop decided it; rollback restores the lesson to the letter`, async () => {
    const s = fakeStore([l]);
    await handler.apply(s.c, d);
    expect(s.byId.get('lesson:a')).toMatchObject({ status, decidedBy: 'loop:1', decisionNote: 'by the loop' });
    expect(s.calls[0].o).toEqual({});
    await handler.rollback(s.c, d, d.after);
    expect(s.byId.get('lesson:a')).toEqual(l);
  });
  test('the owner changed it since: TargetChangedError on apply and on rollback', async () => {
    const s = fakeStore([{ ...l, rule: 'owner' }]);
    await expect(handler.apply(s.c, d)).rejects.toBeInstanceOf(TargetChangedError);
    await expect(handler.rollback(s.c, d, d.after)).rejects.toBeInstanceOf(TargetChangedError);
  });
});
