import { AUTO_MERGE, inHoldout, LOOP_ACTOR, lessonFingerprint, lessonSnapshot, NEAR_DUPLICATE_FROM, normalizeStatement, type Lesson } from '@fb/core';
import { sameRuleJudge } from '../nearDuplicate.ts';
import { DUPLICATE_COSINE } from '../../postmortem/recheck.ts';
import { markedDistinct, SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { lessonNeverTarget, ownerTouchedRecently } from './guards.ts';
import { decidedAlready } from './approve_lesson.ts';
import { lessonAfter, loopDecided, round3 } from './lessonSnapshots.ts';

/** Both approved: auto only this close (core thresholds.ts AUTO_MERGE, over duplicate-of's DUPLICATE_COSINE). */
export const MERGE_APPROVED_COSINE = AUTO_MERGE;
/** Lessons read per round: more than any instance flags. */
const MAX_LESSONS = 10_000;
/** Neighbours similarLessons is asked for: the duplicate-of check looks at as many. */
const NEIGHBOURS = 5;

const live = (l: Lesson) => l.status === 'proposed' || l.status === 'approved';

/**
 * merge_duplicates (tier H): a lesson the duplicate-of check flagged is superseded into the lesson it repeats (the
 * keeper), whose paths become the union. Floor: duplicate-of, cosine ≥ DUPLICATE_COSINE measured again now, both
 * lessons proposed or approved. Auto only when: same project; the duplicate is proposed, or both are approved with cosine
 * ≥ MERGE_APPROVED_COSINE and the duplicate's paths within the keeper's; and the owner touched neither within 14 days.
 * Anything else is proposed. Agents get one lesson instead of two.
 */
export const mergeDuplicates: LoopType = {
  type: 'merge_duplicates',
  weights: { bias: -0.5, cosineAbove: 2, dupProposed: 1, pathsWithin: 0.5, sameProject: 1 },
  groups: { evidence: ['cosineAbove'], scope: ['pathsWithin'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const flagged = (await ctx.store.knowledge.listLessons({ flag: 'duplicate-of', limit: MAX_LESSONS })).filter(live);
    for (const dup of flagged) {
      const of = dup.checks!.find((c) => c.name === 'duplicate-of')!.of;
      if (lessonNeverTarget(dup)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(dup.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      const keeper = of && of !== dup.id ? (await ctx.store.knowledge.lessonDetail(of))?.lesson : null;
      if (!keeper || !live(keeper)) { skip(skipped, SKIP.belowFloor); continue; }
      if (lessonNeverTarget(keeper)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(keeper.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      const cos = (await ctx.store.knowledge.similarLessons?.(dup.id, NEIGHBOURS))?.find((n) => n.id === keeper.id)?.cosine;
      if (cos === undefined || cos < DUPLICATE_COSINE) { skip(skipped, SKIP.belowFloor); continue; }
      if (await markedDistinct(ctx.store, dup.id, keeper.id)) { skip(skipped, SKIP.distinct); continue; }
      const touched = ownerTouchedRecently(await ctx.signals(dup.id), ctx.now) || ownerTouchedRecently(await ctx.signals(keeper.id), ctx.now);
      candidates.push(mergeCandidate(dup, keeper, cos, ctx.now, touched));
    }
    const near = await nearBand(ctx, skipped, new Set(candidates.flatMap((c) => c.targets.map((t) => t.id))));
    candidates.push(...near.candidates);
    return { candidates, scanned: flagged.length + near.scanned, skipped, ...(Object.keys(near.remember).length && { remember: near.remember }) };
  },
};

/** Judge calls the middle band may spend per round: the rest wait for the next round. */
export const NEAR_JUDGE_PER_ROUND = 5;
const NEAR_SKIP = { judgedDifferent: 'judged_different', noJudge: 'no_judge' } as const;
/** Two lessons say the same in so many words (title and rule, case, punctuation and spacing ignored): no model needed. */
const sameWords = (a: Lesson, b: Lesson) => normalizeStatement(`${a.title} ${a.rule}`) === normalizeStatement(`${b.title} ${b.rule}`);
/** What the judge said of a pair, kept against both lessons' fingerprints so a changed lesson is judged again. */
type NearMemo = { fp: string; same: boolean | null; why: string };

/**
 * The near-duplicate middle band (0.9.1): pairs of the round's live lessons in one project whose cosine is from
 * NEAR_DUPLICATE_FROM up to DUPLICATE_COSINE, which the duplicate-of flag leaves alone. The same words (structural)
 * settle it without a model; otherwise the loop's model is asked, yes or no, whether they say the same thing (at most
 * NEAR_JUDGE_PER_ROUND a round, each answer remembered against both fingerprints). Yes, or unsure, is a merge proposed
 * for you, never applied on its own; no is dropped. A pair you said is not the same is never looked at.
 */
async function nearBand(ctx: LoopTypeContext, skipped: Record<string, number>, taken: Set<string>): Promise<{ candidates: LoopCandidate[]; scanned: number; remember: Record<string, string> }> {
  const out: LoopCandidate[] = [];
  const remember: Record<string, string> = {};
  let judged = 0;
  let scanned = 0;
  const lessons = (await ctx.lessons()).filter((l) => live(l) && !lessonNeverTarget(l) && ctx.inScope(l.projectKey));
  for (const l of lessons) {
    const near = ((await ctx.store.knowledge.similarLessons?.(l.id, NEIGHBOURS)) ?? []).filter((n) => n.cosine >= NEAR_DUPLICATE_FROM && n.cosine < DUPLICATE_COSINE && n.id > l.id);
    for (const n of near) {
      if (taken.has(l.id) || taken.has(n.id)) continue;
      const other = (await ctx.store.knowledge.lessonDetail(n.id))?.lesson;
      if (!other || !live(other) || other.projectKey !== l.projectKey || lessonNeverTarget(other)) continue;
      scanned++;
      if (inHoldout(l.id, ctx.holdout) || inHoldout(other.id, ctx.holdout)) { skip(skipped, SKIP.holdout); continue; }
      if (await markedDistinct(ctx.store, l.id, other.id)) { skip(skipped, SKIP.distinct); continue; }
      const key = `near:${l.id}|${other.id}`;
      const fp = `${lessonFingerprint(l)}|${lessonFingerprint(other)}`;
      const memo = JSON.parse((await ctx.recall(key)) ?? 'null') as NearMemo | null;
      let verdict: { same: boolean | null; why: string; model?: string };
      if (memo?.fp === fp) verdict = memo;
      else if (sameWords(l, other)) verdict = { same: true, why: 'they say the same in the same words' };
      else if (!ctx.llm) { skip(skipped, NEAR_SKIP.noJudge); continue; }
      else if (judged >= NEAR_JUDGE_PER_ROUND) continue;
      else {
        judged++;
        const v = await sameRuleJudge(ctx.llm, l, other);
        if (v.error) ctx.log('merge_duplicates: the near-duplicate judge gave no usable answer', { a: l.id, b: other.id, error: v.error });
        verdict = { same: v.same, why: v.why, model: ctx.llm.id };
        remember[key] = JSON.stringify({ fp, same: v.same, why: v.why } satisfies NearMemo);
      }
      if (verdict.same === false) { skip(skipped, NEAR_SKIP.judgedDifferent); continue; }
      // The approved one is kept; of two alike, the older.
      const [keeper, dup] = l.status === 'approved' && other.status !== 'approved' ? [l, other] : other.status === 'approved' && l.status !== 'approved' ? [other, l]
        : [l, other].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
      if (await decidedAlready(ctx, 'merge_duplicates', dup.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
      taken.add(l.id);
      taken.add(other.id);
      out.push(nearCandidate(dup, keeper, n.cosine, ctx.now, verdict));
    }
  }
  return { candidates: out, scanned, remember };
}

/** A middle-band merge: always a proposal, resting on the judge's answer (or the same words), not on a flag. */
export function nearCandidate(dup: Lesson, keeper: Lesson, cos: number, now: number, v: { same: boolean | null; why: string; model?: string }): LoopCandidate {
  const c = mergeCandidate(dup, keeper, cos, now);
  const said = v.same === null ? 'the loop\'s model could not tell whether they say the same thing' : `the loop's model judged they say the same thing${v.why ? ` (${v.why})` : ''}`;
  const proposeOnly = `a near duplicate (cosine ${round3(cos)}, under the duplicate flag's ${DUPLICATE_COSINE}): ${v.same === null ? 'the judge was unsure' : 'judged, not measured'}`;
  return {
    ...c,
    evidence: [{ kind: 'lesson', id: dup.id, role: v.same === null ? 'near duplicate, judge unsure' : 'near duplicate, judged the same', weight: round3(cos), observedAt: dup.createdAt }, c.evidence[1]],
    features: { ...c.features, cosineAbove: 0, nearJudged: v.same === null ? 0 : 1 },
    rationale: `The ${dup.status} lesson ${dup.id} and the ${keeper.status} lesson ${keeper.id} are close (cosine ${round3(cos)}) and ${said}. Merging supersedes ${dup.id} into ${keeper.id}; it waits for you.`,
    proposeOnly,
    ...(v.model && { model: v.model }),
  };
}

/** Why a merge that passed the floors may only be proposed; null: it may apply on its own. */
export function mergeProposeOnly(dup: Lesson, keeper: Lesson, cos: number, touched: boolean): string | null {
  if (touched) return 'you changed one of the lessons in the last 14 days';
  if (dup.projectKey !== keeper.projectKey) return 'the lessons serve different projects';
  if (dup.status === 'proposed') return null;
  if (keeper.status !== 'approved') return 'the duplicate is approved and the lesson it repeats is not';
  if (cos < MERGE_APPROVED_COSINE) return `both are approved and the cosine is under ${MERGE_APPROVED_COSINE}`;
  if (!dup.paths.every((p) => keeper.paths.includes(p))) return 'both are approved and the duplicate names files the other does not';
  return null;
}

/** The call merging `dup` into `keeper` at cosine `cos`. touched: the owner changed either within 14 days. */
export function mergeCandidate(dup: Lesson, keeper: Lesson, cos: number, now: number, touched = false): LoopCandidate {
  const added = dup.paths.filter((p) => !keeper.paths.includes(p));
  const proposeOnly = mergeProposeOnly(dup, keeper, cos, touched);
  const keeperAfter = lessonAfter(keeper, { paths: [...keeper.paths, ...added] });
  const dupAfter = lessonAfter(dup, loopDecided('superseded', now, LOOP_ACTOR, `merged into ${keeper.id}, which says the same`));
  return {
    projectKey: keeper.projectKey,
    targets: [{ kind: 'lesson', id: keeper.id, role: 'keeper' }, { kind: 'lesson', id: dup.id, role: 'merged' }],
    before: [lessonSnapshot(keeper), lessonSnapshot(dup)],
    after: [keeperAfter, dupAfter],
    evidence: [
      { kind: 'check', id: dup.id, role: 'duplicate-of', weight: round3(cos), observedAt: dup.createdAt },
      { kind: 'lesson', id: keeper.id, role: 'kept lesson', weight: 1, observedAt: keeper.createdAt },
    ],
    features: {
      cosine: round3(cos),
      cosineAbove: round3(Math.min(1, (cos - DUPLICATE_COSINE) / (1 - DUPLICATE_COSINE))),
      dupProposed: dup.status === 'proposed' ? 1 : 0,
      pathsWithin: added.length ? 0 : 1,
      sameProject: dup.projectKey === keeper.projectKey ? 1 : 0,
    },
    subject: `merge "${dup.title.slice(0, 60)}" into "${keeper.title.slice(0, 60)}"`,
    rationale: `The ${dup.status} lesson ${dup.id} repeats the ${keeper.status} lesson ${keeper.id} (cosine ${round3(cos)}). ` +
      `It is superseded into ${keeper.id}${added.length ? `, which also takes its files ${added.slice(0, 3).join(', ')}${added.length > 3 ? ` and ${added.length - 3} more` : ''}` : ''}, ` +
      `so agents get one lesson instead of two.${proposeOnly ? ` Proposed only: ${proposeOnly}.` : ''}`,
    ...(proposeOnly && { proposeOnly }),
  };
}
