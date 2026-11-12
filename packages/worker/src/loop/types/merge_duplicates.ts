import { LOOP_ACTOR, lessonSnapshot, type Lesson } from '@fb/core';
import { DUPLICATE_COSINE } from '../../postmortem/recheck.ts';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { lessonNeverTarget, ownerTouchedRecently } from './guards.ts';
import { lessonAfter, loopDecided, round3 } from './lessonSnapshots.ts';

/** Both approved: auto only this close (the design's bar over duplicate-of's DUPLICATE_COSINE). */
export const MERGE_APPROVED_COSINE = 0.95;
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
      const touched = ownerTouchedRecently(await ctx.signals(dup.id), ctx.now) || ownerTouchedRecently(await ctx.signals(keeper.id), ctx.now);
      candidates.push(mergeCandidate(dup, keeper, cos, ctx.now, touched));
    }
    return { candidates, scanned: flagged.length, skipped };
  },
};

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
