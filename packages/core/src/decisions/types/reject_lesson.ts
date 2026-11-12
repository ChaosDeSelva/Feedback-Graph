import type { DecisionTypeHandler } from './handler.ts';
import { writeLessonTargets } from './lessonWrites.ts';

/**
 * reject_lesson: the proposed lesson rejected as the loop decided it, compared with its snapshot; the rollback returns
 * it to proposed and undecided.
 */
export const rejectLesson: DecisionTypeHandler = {
  apply: (c, d) => writeLessonTargets(c, d, d.before, d.after),
  rollback: (c, d, from) => writeLessonTargets(c, d, from, d.before),
};
