import type { DecisionTypeHandler } from './handler.ts';
import { writeLessonTargets } from './lessonWrites.ts';

/**
 * retire_lesson: the approved lesson revoked as the loop decided it (status, decidedAt, decidedBy, note from `after`),
 * compared with its snapshot; the rollback restores it approved, with the owner's original decision. The cloud sync
 * hold is the decision's syncHoldUntil, which the executor sets when it marks the decision applied.
 */
export const retireLesson: DecisionTypeHandler = {
  apply: (c, d) => writeLessonTargets(c, d, d.before, d.after),
  rollback: (c, d, from) => writeLessonTargets(c, d, from, d.before),
};
