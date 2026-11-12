import { isoWeek, type PatternReport } from '../graph/insights.ts';
import type { DecisionCount } from '../decisions/record.ts';
import type { DecisionsStore, InsightsStore, LessonSignalsRow } from '../store.ts';
import { DECISION_TYPES, type DecisionType } from '../types.ts';
import { holdoutEligible, proportion, type Proportion } from './holdout.ts';

/**
 * The learning loop's value, as the Dashboard shows it: is the owner repeating himself less, do the
 * done-checks catch gaps, do the lessons served get gaps fixed or come back as noise, how much of the owner's time the
 * loop asks for (proposals per week), and how often each type had to be undone. Every rate comes with its n and 95%
 * Wilson interval: the counts are small, so the intervals say more than the rates.
 */
export type LoopMetrics = {
  /** The window the weekly series and the decisions cover: its first ISO week, and how many weeks. */
  since: string; weeks: number;
  /** Feedback in the window that repeats an earlier miss (cosine ≥ REPEAT_SIMILARITY), and per week. */
  repeatRate: Proportion & { weekly: { week: string; feedback: number; repeats: number }[] };
  /** Done-checks (all time) that found at least one gap. */
  checksCaughtGap: Proportion;
  /** Gaps fixed later in the same session, per time an eligible lesson was served. */
  gapsFixedPerServed: Proportion;
  /** Done-check verdicts on eligible lessons that were not_applicable or cannot_tell. */
  notApplicableShare: Proportion;
  /** Decisions that waited for you (mode propose), by the ISO week they were made; weeks with none included. */
  proposalsPerWeek: { week: string; proposals: number }[];
  /** Per type, the decisions applied in the window and how many of them were rolled back since. */
  rollbackRate: { type: DecisionType; rolledBack: number; of: number; rate: Proportion }[];
};

const DAY = 86_400_000;

/**
 * proposals: decisions made in mode propose, counted by the week they were made (DecisionsStore.count by createdWeek);
 * applied: those applied from the window's first week on, counted by type and status.
 */
export type LoopMetricsInput = { patterns: PatternReport; signals: LessonSignalsRow[]; proposals: DecisionCount[]; applied: DecisionCount[]; now: number; weeks: number };

/** The ISO weeks of the window, oldest first: the one `now` is in and the weeks - 1 before it. */
const windowWeeks = (now: number, weeks: number) => Array.from({ length: weeks }, (_, n) => isoWeek(new Date(now - (weeks - 1 - n) * 7 * DAY).toISOString()));

/** The Monday (00:00 UTC) the window's first ISO week starts on. */
function windowStart(now: number, weeks: number): string {
  const d = new Date(now - (weeks - 1) * 7 * DAY);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString();
}

export function loopMetrics(i: LoopMetricsInput): LoopMetrics {
  const weeks = windowWeeks(i.now, i.weeks);
  const since = weeks[0];
  const weekly = i.patterns.weekly.filter((w) => w.week >= since);
  const feedback = weekly.reduce((s, w) => s + w.feedback, 0);
  const repeats = weekly.reduce((s, w) => s + w.repeats, 0);
  let served = 0, fixed = 0, noise = 0, verdicts = 0;
  for (const { counts: c } of i.signals.filter(holdoutEligible)) {
    served += c.served;
    fixed += c.gapsFixed;
    noise += c.notApplicable + c.cannotTell;
    verdicts += c.addressed + c.notAddressed + c.notApplicable + c.cannotTell;
  }
  const proposals = new Map(weeks.map((w) => [w, 0]));
  for (const c of i.proposals) if (c.createdWeek && proposals.has(c.createdWeek)) proposals.set(c.createdWeek, proposals.get(c.createdWeek)! + c.n);
  return {
    since, weeks: i.weeks,
    repeatRate: { ...proportion(Math.min(repeats, feedback), feedback), weekly },
    checksCaughtGap: proportion(i.patterns.preDone.withGaps, i.patterns.preDone.checks),
    gapsFixedPerServed: proportion(Math.min(fixed, served), served),
    notApplicableShare: proportion(noise, verdicts),
    proposalsPerWeek: [...proposals].map(([week, n]) => ({ week, proposals: n })),
    rollbackRate: DECISION_TYPES.map((type) => {
      const of = i.applied.filter((c) => c.type === type);
      const n = of.reduce((s, c) => s + c.n, 0);
      const rolledBack = of.filter((c) => c.status === 'rolled_back').reduce((s, c) => s + c.n, 0);
      return { type, rolledBack, of: n, rate: proportion(rolledBack, n) };
    }),
  };
}

/**
 * The metrics over the store, for a route such as GET /api/loop/metrics. projectKeys: only these projects (and global
 * lessons and decisions with no project), for a viewer who may see only some. The decisions are counted in the store,
 * so a busy one is counted whole. The decisions window starts a week before the first week shown, as the list it
 * replaces read it.
 */
export async function readLoopMetrics(
  s: { insights: Pick<InsightsStore, 'patterns'>; decisions: Pick<DecisionsStore, 'listSignals' | 'count'> },
  o: { now: number; weeks?: number; projectKeys?: string[] },
): Promise<LoopMetrics> {
  const weeks = o.weeks ?? 8;
  const scope = o.projectKeys ? { projectKeys: o.projectKeys } : {};
  const made = { since: new Date(o.now - (weeks * 7 + 7) * DAY).toISOString(), ...scope };
  const [patterns, signals, proposals, applied] = await Promise.all([
    s.insights.patterns(scope),
    s.decisions.listSignals(scope),
    s.decisions.count({ ...made, mode: 'propose' }, ['createdWeek']),
    s.decisions.count({ ...made, appliedSince: windowStart(o.now, weeks) }, ['type', 'status']),
  ]);
  return loopMetrics({ patterns, signals, proposals, applied, now: o.now, weeks });
}
