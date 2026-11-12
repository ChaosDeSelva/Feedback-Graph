import type { Decision, TargetSnapshot } from '../../types.ts';
import type { LessonSnapshotFields, LessonSnapshotWrite, SupersedeLink } from '../record.ts';
import type { HandlerContext } from './handler.ts';

const snapshotOf = (list: TargetSnapshot[], id: string) => list.find((x) => x.kind === 'lesson' && x.id === id)!;

/**
 * Every lesson target of `d` set from its snapshot in `from` to the one in `to`, in one transaction
 * (writeLessonSnapshots): each must still have its `from` fingerprint, or TargetChangedError with nothing written. All
 * of them are written, even one whose two snapshots match, so a merge's keeper is compared (and its SUPERSEDES edge
 * made) whether or not its paths change. link: the merge edges to add or remove in the same transaction.
 */
export async function writeLessonTargets(c: HandlerContext, d: Decision, from: TargetSnapshot[], to: TargetSnapshot[], link: { supersede?: SupersedeLink[]; unsupersede?: SupersedeLink[] } = {}): Promise<void> {
  const writes: LessonSnapshotWrite[] = d.targets.map((t) => ({
    id: t.id, expect: snapshotOf(from, t.id).fingerprint, fields: snapshotOf(to, t.id).fields as LessonSnapshotFields,
  }));
  await c.store.knowledge.writeLessonSnapshots(writes, link);
}
