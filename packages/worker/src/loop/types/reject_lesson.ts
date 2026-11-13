import { LESSON_BLOCKING_CHECKS, LOOP_ACTOR, lessonSnapshot, type Lesson, type LessonCheckName } from '@fb/core';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { lessonNeverTarget, ownerTouchedRecently } from './guards.ts';
import { daysSince, lessonAfter, loopDecided, round3 } from './lessonSnapshots.ts';

/** The lesson checks that block a lesson (its floor): a proposal carrying one is rejected. Kept in core, where the approve score reads them too. */
export const BLOCKING_CHECKS = LESSON_BLOCKING_CHECKS;
/** The checks that say the lesson rests on nothing (no miss, the wrong session, the agent's own review): stronger. */
const STRONG: readonly LessonCheckName[] = ['no-miss', 'self-review', 'wrong-session'];

/**
 * reject_lesson (tier A): a proposed lesson a blocking check flags is rejected. It extends the post-mortem's own
 * rejection of a no-miss lesson (postmortem/step.ts) to the other blocking checks, and to the lessons that one leaves
 * flagged. A lesson you edited while proposed is yours: that, or any touch within 14 days, is proposed at most.
 * Only proposals change; agents are told nothing new.
 */
export const rejectLesson: LoopType = {
  type: 'reject_lesson',
  weights: { bias: -0.5, strongCheck: 1.5, checks: 1.5, waited: 0.5 },
  groups: { evidence: ['strongCheck', 'checks'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    // The round's lessons: a new proposal is named by its post-mortem's entry, and a check added later is found by the sweep.
    const proposed = (await ctx.lessons()).filter((l) => l.status === 'proposed');
    for (const l of proposed) {
      if (lessonNeverTarget(l)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(l.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      if (!blocking(l).length) { skip(skipped, SKIP.belowFloor); continue; }
      const proposeOnly = l.proposedAs ? 'you edited this lesson' : ownerTouchedRecently(await ctx.signals(l.id), ctx.now) ? 'you changed this lesson in the last 14 days' : null;
      candidates.push(rejectCandidate(l, ctx.now, proposeOnly));
    }
    return { candidates, scanned: proposed.length, skipped };
  },
};

/** The blocking checks on `l`, in LESSON_CHECKS order of its checks, each once. */
export const blocking = (l: Lesson) => [...new Set((l.checks ?? []).filter((c) => BLOCKING_CHECKS.includes(c.name)).map((c) => c.name))];

/** The call rejecting `l`. proposeOnly: why it may not apply on its own (null: it may). */
export function rejectCandidate(l: Lesson, now: number, proposeOnly: string | null = null): LoopCandidate {
  const names = blocking(l);
  const whys = names.map((n) => `${n}: ${l.checks!.find((c) => c.name === n)!.why}`);
  return {
    projectKey: l.projectKey,
    targets: [{ kind: 'lesson', id: l.id, role: 'primary' }],
    before: [lessonSnapshot(l)],
    after: [lessonAfter(l, loopDecided('rejected', now, LOOP_ACTOR, `rejected by the learning loop: ${names.join(', ')}`))],
    evidence: names.map((n) => ({ kind: 'check' as const, id: l.id, role: `check ${n}`, weight: 1, observedAt: l.createdAt })),
    features: {
      strongCheck: names.some((n) => STRONG.includes(n)) ? 1 : 0,
      checks: round3(Math.min(names.length, 3) / 3),
      waited: round3(Math.min(1, Math.max(0, daysSince(l.createdAt, now)!) / 30)),
    },
    subject: `reject "${l.title.slice(0, 80)}"`,
    rationale: `The proposed lesson fails blocking checks (${whys.join('; ')}). Rejecting it changes no lesson agents are served.` +
      (proposeOnly ? ` Proposed only: ${proposeOnly}.` : ''),
    ...(proposeOnly && { proposeOnly }),
  };
}
