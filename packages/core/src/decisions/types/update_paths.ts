import { createHash } from 'node:crypto';
import type { Decision, Lesson, TargetSnapshot } from '../../types.ts';
import { canonicalJson, changedError, lessonFingerprint } from '../record.ts';
import { absentSnapshot, lessonSnapshotFields, snapshotOf } from '../snapshot.ts';
import type { DecisionTypeHandler, HandlerContext } from './handler.ts';

/** A lesson as update_paths changes it: its fingerprinted fields and its triggers, which the lesson fingerprint leaves out. */
export const lessonPathsFingerprint = (l: Lesson) => createHash('sha256').update(canonicalJson(['lesson-paths', lessonFingerprint(l), l.triggers ?? null])).digest('hex');
export const lessonPathsSnapshot = (l: Lesson): TargetSnapshot => ({ kind: 'lesson', id: l.id, fields: { ...lessonSnapshotFields(l), triggers: l.triggers ?? null }, fingerprint: lessonPathsFingerprint(l) });

const lessonNow = async (c: HandlerContext, id: string) => (await c.store.knowledge.lessonDetail(id))?.lesson ?? null;

/** Each lesson target moved from `from` to `to`, compared (paths and triggers) just before it is written. */
async function move(c: HandlerContext, d: Decision, from: TargetSnapshot[], to: TargetSnapshot[]): Promise<void> {
  for (const t of d.targets.filter((x) => x.kind === 'lesson')) {
    const was = snapshotOf(from, t);
    const cur = await lessonNow(c, t.id);
    const now = cur ? lessonPathsSnapshot(cur) : absentSnapshot(t);
    if (now.fingerprint !== was.fingerprint) throw changedError(t.id, was.fingerprint, now);
    await c.store.knowledge.writeLessonSnapshots([{ id: t.id, fields: snapshotOf(to, t).fields as never, expect: lessonFingerprint(cur!) }]);
  }
}

/**
 * update_paths: a lesson's paths and trigger paths that name a file git renamed, moved to its new name. Triggers are
 * no part of the lesson fingerprint, so the targets are compared with lessonPathsFingerprint, which covers both, just
 * before each write (an owner's edit since is never overwritten). Rolling back restores the old names.
 */
export const updatePaths: DecisionTypeHandler = {
  snapshot: async (c, d) => Promise.all(d.targets.filter((t) => t.kind === 'lesson').map(async (t) => {
    const l = await lessonNow(c, t.id);
    return l ? lessonPathsSnapshot(l) : absentSnapshot(t);
  })),
  apply: (c, d) => move(c, d, d.before, d.after),
  rollback: (c, d, from) => move(c, d, from, d.before),
};
