import { redactSecrets } from '../../redact.ts';
import type { Decision, DecisionTarget, TargetSnapshot } from '../../types.ts';
import { ABSENT, lessonFingerprint, TargetChangedError, type LessonSnapshotFields } from '../record.ts';
import { snapshotOf } from '../snapshot.ts';
import { genericHandler } from './generic.ts';
import type { DecisionTypeHandler, HandlerContext } from './handler.ts';

const isMade = (t: DecisionTarget) => t.kind === 'lesson' && t.role === 'created';
const named = (list: TargetSnapshot[], ts: DecisionTarget[]) => list.filter((x) => ts.some((t) => t.kind === x.kind && t.id === x.id));

/** The decision without the lessons it creates: what the generic lesson write moves (the reworded lesson). */
function reworded(d: Decision): Decision {
  const kept = d.targets.filter((t) => !isMade(t));
  return { ...d, targets: kept, before: named(d.before, kept), after: named(d.after, kept) };
}

async function create(c: HandlerContext, d: Decision, t: DecisionTarget): Promise<void> {
  const fields = snapshotOf(d.after, t).fields as LessonSnapshotFields;
  const from = d.targets.find((x) => x.role === 'primary')!.id;
  const embedding = c.deps.embed ? (await c.deps.embed([redactSecrets(`${fields.title}\n${fields.rule}\nApplies when: ${fields.appliesWhen}`)]))[0] : null;
  if (!(await c.store.knowledge.addLoopLesson({ id: t.id, from, fields, embedding }))) {
    // There is one by that id already, or the lesson it splits is gone.
    const now = await c.store.knowledge.lessonDetail(t.id);
    throw new TargetChangedError(t.id, ABSENT, now ? lessonFingerprint(now.lesson) : null);
  }
}

/** Remove a lesson the split made, as it is now (a compensation: it was written a moment ago). */
async function unmake(c: HandlerContext, id: string): Promise<void> {
  const now = await c.store.knowledge.lessonDetail(id);
  if (now) await c.store.knowledge.removeLoopLesson(id, lessonFingerprint(now.lesson));
}

/**
 * reword_lesson: the lesson's new words are the generic lesson write (compare-and-set, re-embedded). A split also
 * creates the lesson it splits off (role created, ABSENT before) with addLoopLesson, after the reworded one is written;
 * when that fails the reworded one is moved back. Rolling back removes the created lesson first (removeLoopLesson,
 * expecting it as `from` has it) and then restores the original; when the restore fails the removed lesson is made again.
 */
export const rewordLesson: DecisionTypeHandler = {
  async apply(c, d) {
    const rest = reworded(d);
    await genericHandler.apply(c, rest);
    const made: DecisionTarget[] = [];
    try {
      for (const t of d.targets.filter(isMade)) {
        await create(c, d, t);
        made.push(t);
      }
    } catch (error) {
      for (const t of made) await unmake(c, t.id);
      await genericHandler.rollback(c, rest, rest.after);
      throw error;
    }
  },
  async rollback(c, d, from) {
    const removed: DecisionTarget[] = [];
    for (const t of d.targets.filter(isMade)) {
      const was = snapshotOf(from, t).fingerprint;
      if (was === ABSENT) continue;
      await c.store.knowledge.removeLoopLesson(t.id, was);
      removed.push(t);
    }
    const rest = reworded(d);
    try {
      await genericHandler.rollback(c, rest, named(from, rest.targets));
    } catch (error) {
      for (const t of removed) await create(c, { ...d, after: from }, t);
      throw error;
    }
  },
};
