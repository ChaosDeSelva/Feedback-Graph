import { LOOP_ACTOR, lessonSnapshot, type Lesson, type LessonSignals } from '@fb/core';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { lessonNeverTarget } from './guards.ts';
import { DAY_MS, daysSince, lessonAfter, loopDecided, round3 } from './lessonSnapshots.ts';

/** The floors, the least evidence before it makes a call: calibration only raises the bar above them. */
export const RETIRE = { approvedDays: 60, served: 15, judged: 8, notApplicableShare: 0.8, ownerQuietDays: 30 } as const;

const judgedOf = (c: LessonSignals['counts']) => c.addressed + c.notAddressed + c.notApplicable + c.cannotTell;

/**
 * Whether the lesson's record clears every floor: approved ≥ 60 days, served ≥ 15, judged ≥ 8 with no gap caught
 * (not_addressed) and none fixed, not_applicable ≥ 80% of verdicts, its miss never repeated. The owner's touch is
 * checked apart (a skip of its own).
 */
export function retireFloors(l: Lesson, s: LessonSignals | null, now: number): boolean {
  const age = daysSince(l.decidedAt, now);
  if (age === null || age < RETIRE.approvedDays || !s) return false;
  const c = s.counts;
  const judged = judgedOf(c);
  return c.served >= RETIRE.served && judged >= RETIRE.judged && c.notAddressed === 0 && c.gapsFixed === 0 &&
    c.notApplicable >= RETIRE.notApplicableShare * judged && c.repeatServed + c.repeatUnserved === 0;
}

/**
 * retire_lesson (tier H): an approved lesson agents keep being served and keep judging not applicable, that never once
 * caught a gap, is revoked (decided by the loop, with a note). It leaves what agents are told; a rollback restores it.
 * Never one you wrote, nor one you changed within 30 days.
 */
export const retireLesson: LoopType = {
  type: 'retire_lesson',
  weights: { bias: -0.5, notApplicableAbove: 1.5, servedMore: 1, judgedMore: 1, olderMore: 0.5 },
  groups: { evidence: ['notApplicableAbove', 'servedMore', 'judgedMore'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    // The round's lessons (those changed since the last round, and the sweep's page), not every approved one: a lesson
    // crosses the age floor without an entry, and the sweep reaches it.
    const approved = (await ctx.lessons()).filter((l) => l.status === 'approved');
    for (const l of approved) {
      if (lessonNeverTarget(l)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(l.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      const s = await ctx.signals(l.id);
      if (!retireFloors(l, s, ctx.now)) { skip(skipped, SKIP.belowFloor); continue; }
      if (s!.lastOwnerTouch && ctx.now - Date.parse(s!.lastOwnerTouch) < RETIRE.ownerQuietDays * DAY_MS) { skip(skipped, SKIP.ownerTouched); continue; }
      candidates.push(retireCandidate(l, s!, ctx.now));
    }
    return { candidates, scanned: approved.length, skipped };
  },
};

/** The call retiring `l` on its signals `s` (which cleared the floors). */
export function retireCandidate(l: Lesson, s: LessonSignals, now: number): LoopCandidate {
  const c = s.counts;
  const judged = judgedOf(c);
  const share = c.notApplicable / judged;
  const age = daysSince(l.decidedAt, now)!;
  const why = `served ${c.served} times; of ${judged} verdicts ${c.notApplicable} said not applicable and none caught a gap; its miss never repeated`;
  return {
    projectKey: l.projectKey,
    targets: [{ kind: 'lesson', id: l.id, role: 'primary' }],
    before: [lessonSnapshot(l)],
    after: [lessonAfter(l, loopDecided('revoked', now, LOOP_ACTOR, `retired by the learning loop: ${why}`))],
    evidence: [{ kind: 'lesson', id: l.id, role: 'served, never helped', weight: round3(share), observedAt: s.updatedAt }],
    features: {
      notApplicableShare: round3(share),
      notApplicableAbove: round3((share - RETIRE.notApplicableShare) / (1 - RETIRE.notApplicableShare)),
      servedMore: round3(Math.min(1, (c.served - RETIRE.served) / 35)),
      judgedMore: round3(Math.min(1, (judged - RETIRE.judged) / 22)),
      olderMore: round3(Math.min(1, (age - RETIRE.approvedDays) / 120)),
    },
    subject: `retire "${l.title.slice(0, 80)}"`,
    rationale: `Approved ${Math.floor(age)} days ago and ${why}. Revoking it stops serving it to agents; rolling back restores it as approved.`,
  };
}
