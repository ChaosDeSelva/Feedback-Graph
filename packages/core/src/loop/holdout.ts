import { createHash } from 'node:crypto';
import type { DecisionsStore, LessonSignalsRow } from '../store.ts';

/**
 * The learning loop's control group (is it helping?): LOOP_HOLDOUT of the eligible lessons, chosen by a fixed hash of
 * their id, are never changed by the loop, so how often the misses of the lessons it may change repeat, and how often
 * they help, can be compared with lessons it left alone. The arms are intention-to-treat: every eligible lesson outside
 * the holdout is "treated", whether or not a decision touched it, so the loop retiring its worst lessons cannot make
 * the treated arm look better. The sample is small: report the intervals, never claim the point estimates.
 */

/** z of the 95% Wilson interval. */
export const WILSON_Z = 1.96;

/** The Wilson score interval of k successes in n trials; [0, 1] when there are none. */
export function wilson(k: number, n: number, z = WILSON_Z): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = k / n;
  const z2 = z * z;
  const mid = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, mid - half), upper: Math.min(1, mid + half) };
}

/** k of n, its rate (0 when n is 0) and 95% Wilson interval. */
export type Proportion = { k: number; n: number; rate: number; ciLow: number; ciHigh: number };
export function proportion(k: number, n: number): Proportion {
  const { lower, upper } = wilson(k, n);
  return { k, n, rate: n > 0 ? k / n : 0, ciLow: lower, ciHigh: upper };
}

/** Whether the loop leaves this lesson alone: a fixed hash of its id falls below `share`. A larger share only adds lessons. */
export function inHoldout(lessonId: string, share: number): boolean {
  if (share <= 0) return false;
  return createHash('sha256').update(`fg-holdout|${lessonId}`).digest().readUInt32BE(0) / 2 ** 32 < share;
}

/** A lesson the loop could change at all: not one you wrote, not the demo's, not a run's (guards.ts lessonNeverTarget). */
export const holdoutEligible = (r: { source: LessonSignalsRow['source']; run?: string | null; sandbox?: boolean }) =>
  r.source !== 'manual' && r.source !== 'demo' && !r.run && !r.sandbox;

/** Whether a lesson is in the control group (GET /api/loop/lessons/:id/track's `holdout`): eligible, and held out by the hash. */
export const lessonHeldOut = (l: { id: string; source: LessonSignalsRow['source']; run?: string | null; sandbox?: boolean }, share: number) =>
  holdoutEligible(l) && inHoldout(l.id, share);

/**
 * One arm, over its eligible lessons served at least once. repeat: lessons whose miss happened again (served in that
 * session or not). helpful: decisive verdicts that the lesson applied (addressed, or a gap it caught) of addressed, not
 * addressed and not applicable (rank_weight's helpfulness; cannot_tell is no evidence). gapsFixed: gaps fixed later in
 * the session per time served. notApplicable: not_applicable and cannot_tell of every verdict.
 */
export type HoldoutArmStats = { lessons: number; served: number; repeat: Proportion; helpful: Proportion; gapsFixed: Proportion; notApplicable: Proportion };
export type HoldoutStats = { share: number; treated: HoldoutArmStats; control: HoldoutArmStats };

function arm(rows: LessonSignalsRow[]): HoldoutArmStats {
  let served = 0, repeated = 0, helpful = 0, decisive = 0, fixed = 0, noise = 0, verdicts = 0;
  for (const { counts: c } of rows) {
    served += c.served;
    if (c.repeatServed + c.repeatUnserved > 0) repeated++;
    helpful += c.addressed + c.notAddressed;
    decisive += c.addressed + c.notAddressed + c.notApplicable;
    fixed += c.gapsFixed;
    noise += c.notApplicable + c.cannotTell;
    verdicts += c.addressed + c.notAddressed + c.notApplicable + c.cannotTell;
  }
  return {
    lessons: rows.length, served, repeat: proportion(repeated, rows.length), helpful: proportion(helpful, decisive),
    gapsFixed: proportion(Math.min(fixed, served), served), notApplicable: proportion(noise, verdicts),
  };
}

/** Treated against control; null when there is no holdout, or an arm has no lesson served yet. */
export function holdoutReport(rows: LessonSignalsRow[], share: number): HoldoutStats | null {
  if (share <= 0) return null;
  const served = rows.filter((r) => holdoutEligible(r) && r.counts.served > 0);
  const control = served.filter((r) => inHoldout(r.lessonId, share));
  const treated = served.filter((r) => !inHoldout(r.lessonId, share));
  if (!control.length || !treated.length) return null;
  return { share, treated: arm(treated), control: arm(control) };
}

/** The holdout as GET /api/loop answers it (docs/learning-loop-api.md): the interval is the helpful rate's. */
export type HoldoutArm = { lessons: number; repeatRate: number; helpfulRate: number; ciLow: number; ciHigh: number };
export type HoldoutWire = { share: number; treated: HoldoutArm; control: HoldoutArm };
const armWire = (a: HoldoutArmStats): HoldoutArm =>
  ({ lessons: a.lessons, repeatRate: a.repeat.rate, helpfulRate: a.helpful.rate, ciLow: a.helpful.ciLow, ciHigh: a.helpful.ciHigh });
export const holdoutWire = (s: HoldoutStats | null): HoldoutWire | null => s && { share: s.share, treated: armWire(s.treated), control: armWire(s.control) };

/**
 * Which lessons a viewer may see: projectKeys (only these projects, and global lessons), or shows, a per-project check
 * such as the API's (global lessons always shown).
 */
export type HoldoutScope = { projectKeys?: string[]; shows?: (projectKey: string) => Promise<boolean> };

/** The comparison over the stored signals. */
export async function readHoldout(d: Pick<DecisionsStore, 'listSignals'>, share: number, o: HoldoutScope = {}): Promise<HoldoutStats | null> {
  if (share <= 0) return null;
  let rows = await d.listSignals(o.projectKeys ? { projectKeys: o.projectKeys } : {});
  if (o.shows) {
    const keys = [...new Set(rows.map((r) => r.projectKey).filter((k): k is string => k !== null))];
    const shown = new Set((await Promise.all(keys.map(async (k) => ((await o.shows!(k)) ? k : null)))).filter((k) => k !== null));
    rows = rows.filter((r) => r.projectKey === null || shown.has(r.projectKey));
  }
  return holdoutReport(rows, share);
}

/** GET /api/loop's `holdout`: `holdout: await loopHoldout(store.decisions, config.loop.holdout, { shows: ctx.shows })`. */
export const loopHoldout = async (d: Pick<DecisionsStore, 'listSignals'>, share: number, o: HoldoutScope = {}) =>
  holdoutWire(await readHoldout(d, share, o));
