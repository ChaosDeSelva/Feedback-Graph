import { lessonSnapshot, SERVING_WEIGHT_MAX, wilson, SERVING_WEIGHT_MIN, servingWeightOf, type Decision, type Lesson, type LessonSignals } from '@fb/core';
import { holdsStill, primaryOf, SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { lessonNeverTarget, ownerTouchedRecently } from './guards.ts';

/** Decisive verdicts (addressed, not addressed, not applicable) a lesson needs before its weight moves. */
export const RANK_JUDGED_MIN = 5;
/** Judged verdicts at which the evidence feature is full. */
const JUDGED_FULL = 20;
/** Below this many tenths apart, the weight is where the evidence puts it. */
const TENTHS = 10;

/**
 * Where the verdicts put a lesson's weight: a verdict that the lesson applied (addressed, or a gap it caught) counts as
 * helpful, not_applicable as not; cannot_tell is no evidence. Helpful even at the Wilson lower bound (> .5): 1 plus
 * the bound's margin; unhelpful even at the upper bound (< .5): 1 minus it; otherwise 1. In [0.5, 1.5].
 */
export function targetWeight(s: LessonSignals['counts']): { target: number; judged: number; helpful: number; lower: number; upper: number } {
  const helpful = s.addressed + s.notAddressed;
  const judged = helpful + s.notApplicable;
  const { lower, upper } = judged ? wilson(helpful, judged) : { lower: 0, upper: 1 };
  const target = lower > 0.5 ? 1 + (lower - 0.5) : upper < 0.5 ? 1 - (0.5 - upper) : 1;
  return { target, judged, helpful, lower, upper };
}

/** The lessons the round's pre-done checks judged on their own files (not only through a trigger): new evidence. */
const judgedLessons = (ctx: LoopTypeContext) =>
  [...new Set(ctx.entries.filter((e) => e.kind === 'predone_check').flatMap((e) => ((e.details as { verdicts?: { lessonId?: unknown; triggerOnly?: unknown }[] }).verdicts ?? [])
    .filter((v) => v.triggerOnly !== true).map((v) => v.lessonId).filter((id): id is string => typeof id === 'string' && id.startsWith('lesson:'))))].sort();

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const tenths = (w: number) => Math.round(w * TENTHS);

/**
 * rank_weight (tier H): moves an approved lesson's serving weight one step (±0.1, within 0.5–1.5) toward where its
 * pre-done verdicts put it (targetWeight). Floor: RANK_JUDGED_MIN decisive verdicts. The weight only reorders lessons
 * already tied to a task's files, so what crosses the cut changes; no lesson reaches an agent that would not have.
 */
export const rankWeight: LoopType = {
  type: 'rank_weight',
  weights: { bias: -0.5, judged: 1.5, margin: 2, gapsFixed: 0.5 },
  groups: { evidence: ['judged', 'margin', 'gapsFixed'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const ids = judgedLessons(ctx);
    for (const id of ids) {
      const c = await weigh(ctx, id);
      if (typeof c === 'string') skip(skipped, c);
      else candidates.push(c);
    }
    return { candidates, scanned: ids.length, skipped };
  },

  /** Found only when a pre-done check judges the lesson: an observed step is weighed again on its signals as they are. */
  async recheck(ctx: LoopTypeContext, observed: readonly Decision[]): Promise<(LoopCandidate | string)[]> {
    const out: (LoopCandidate | string)[] = [];
    for (const d of observed) out.push(holdsStill(await weigh(ctx, primaryOf(d))));
    return out;
  },
};

/** The step for lesson `id`, or why there is none. */
async function weigh(ctx: LoopTypeContext, id: string): Promise<LoopCandidate | string> {
  const lesson = (await ctx.store.knowledge.lessonDetail(id))?.lesson;
  if (!lesson || lesson.status !== 'approved') return SKIP.belowFloor;
  if (lessonNeverTarget(lesson)) return SKIP.neverTarget;
  if (!ctx.inScope(lesson.projectKey ?? lesson.origin ?? null)) return SKIP.outOfScope;
  const signals = await ctx.signals(id);
  const c = signals && weightCandidate(lesson, signals);
  if (!c) return SKIP.belowFloor;
  if (ownerTouchedRecently(signals, ctx.now)) c.proposeOnly = 'you changed this lesson in the last 14 days';
  return c;
}

const why = (t: ReturnType<typeof targetWeight>) =>
  t.lower > 0.5 ? `helpful even at the lower bound (${round3(t.lower)})`
    : t.upper < 0.5 ? `not helpful even at the upper bound (${round3(t.upper)})`
      : `neither clearly helpful nor clearly not (${round3(t.lower)} to ${round3(t.upper)}), so its weight goes back toward 1`;

/** The one-step call for `l`, or null: under the floor, or its weight is already where the verdicts put it. */
export function weightCandidate(l: Lesson, s: LessonSignals): LoopCandidate | null {
  const t = targetWeight(s.counts);
  if (t.judged < RANK_JUDGED_MIN) return null;
  const now = tenths(servingWeightOf(l));
  const want = tenths(t.target);
  if (want === now) return null;
  const next = Math.min(tenths(SERVING_WEIGHT_MAX), Math.max(tenths(SERVING_WEIGHT_MIN), now + Math.sign(want - now))) / TENTHS;
  const from = (now / TENTHS).toFixed(1);
  const up = next > now / TENTHS;
  const share = `${t.helpful} of ${t.judged} decisive verdicts said it applied`;
  return {
    projectKey: l.projectKey ?? l.origin ?? null,
    targets: [{ kind: 'lesson', id: l.id, role: 'primary' }],
    before: [lessonSnapshot(l)],
    after: [lessonSnapshot({ ...l, servingWeight: next })],
    evidence: [{ kind: 'lesson', id: l.id, role: `serving weight ${from} -> ${next.toFixed(1)}`, weight: round3(up ? t.lower : 1 - t.upper), observedAt: s.updatedAt }],
    features: {
      judged: Math.min(t.judged, JUDGED_FULL) / JUDGED_FULL,
      margin: round3(Math.abs(t.target - 1) * 2),
      gapsFixed: Math.min(s.counts.gapsFixed, 3) / 3,
      lower: round3(t.lower),
      upper: round3(t.upper),
    },
    subject: `lesson "${l.title.slice(0, 80)}" serving weight ${from} -> ${next.toFixed(1)}`,
    rationale: `${share}: ${why(t)}, so it moves ${up ? 'up' : 'down'} among the lessons tied to the files a task names. The weight only reorders those; it never serves a lesson that was not already chosen.`,
  };
}
