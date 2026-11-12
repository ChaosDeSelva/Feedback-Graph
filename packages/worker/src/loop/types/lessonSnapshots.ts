import { lessonSnapshot, type Lesson, type TargetSnapshot } from '@fb/core';

/** The lesson as a decision leaves it: `patch` over it. */
export const lessonAfter = (l: Lesson, patch: Partial<Lesson>): TargetSnapshot => lessonSnapshot({ ...l, ...patch });

/** A decision by the loop at `now`: status, when, who and why, as updateLesson records a decision. */
export const loopDecided = (status: Lesson['status'], now: number, by: string, note: string): Partial<Lesson> =>
  ({ status, decidedAt: new Date(now).toISOString(), decidedBy: by, decisionNote: note });

export const DAY_MS = 86_400_000;
/** Whole days from an ISO time to `now`; null when there is none. */
export const daysSince = (iso: string | null | undefined, now: number) => (iso ? (now - Date.parse(iso)) / DAY_MS : null);
export const round3 = (x: number) => Math.round(x * 1000) / 1000;
