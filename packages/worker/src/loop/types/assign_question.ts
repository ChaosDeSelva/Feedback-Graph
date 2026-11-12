import { questionSnapshot, type Question } from '@fb/core';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { decidedAlready } from './approve_lesson.ts';
import { acceptedClaims, claimWords, openQuestions, questionAfter, questionWords, shared } from './questions.ts';

/** The suggested person said at least this many accepted claims on the question's subject, more than anyone else. */
export const ASSIGN_MIN_CLAIMS = 2;

/**
 * assign_question (tier P: always a proposal): an open question nobody is assigned is suggested for the person who said
 * the most accepted claims on its subject (sharing a subject word with it: its `about`, paths, code names): at least
 * ASSIGN_MIN_CLAIMS, strictly more than anyone else, a person you confirmed. Approving it assigns the question.
 */
export const assignQuestion: LoopType = {
  type: 'assign_question',
  weights: { bias: -0.5, claimsAbove: 1, lead: 1 },
  groups: { evidence: ['claimsAbove', 'lead'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const open = (await openQuestions(ctx, ['open'])).filter((q) => !q.assignee);
    if (!open.length) return { candidates, scanned: 0, skipped };
    const people = new Map((await ctx.store.intake.people({ status: ['confirmed'] })).map((p) => [p.id, p]));
    const accepted = acceptedClaims(ctx);
    for (const q of open) {
      if (!ctx.inScope(q.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      const words = questionWords(q);
      const said = new Map<string, string[]>();
      for (const c of await accepted(q.projectKey)) {
        if (!c.speakerId || !people.has(c.speakerId) || !shared(words, claimWords(c)).length) continue;
        said.set(c.speakerId, [...(said.get(c.speakerId) ?? []), c.id]);
      }
      const ranked = [...said].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
      const [top, next] = ranked;
      if (!top || top[1].length < ASSIGN_MIN_CLAIMS || (next && next[1].length >= top[1].length)) { skip(skipped, SKIP.belowFloor); continue; }
      if (await decidedAlready(ctx, 'assign_question', q.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
      candidates.push(assignCandidate(q, top[0], people.get(top[0])!.displayName, top[1], next?.[1].length ?? 0));
    }
    return { candidates, scanned: open.length, skipped };
  },
};

export function assignCandidate(q: Question, personId: string, name: string, claims: string[], runnerUp: number): LoopCandidate {
  return {
    projectKey: q.projectKey,
    targets: [{ kind: 'question', id: q.id, role: 'primary' }],
    before: [questionSnapshot(q)],
    after: [questionAfter(q, { status: 'assigned', assignee: personId })],
    evidence: claims.slice(0, 5).map((id) => ({ kind: 'claim' as const, id, role: `said by ${personId}`, weight: 1, observedAt: q.createdAt })),
    features: { claims: claims.length, claimsAbove: Math.min(claims.length - ASSIGN_MIN_CLAIMS + 1, 5) / 5, lead: Math.min(claims.length - runnerUp, 5) / 5 },
    subject: `assign "${q.text.slice(0, 60)}" to ${name}`,
    rationale: `${name} said ${claims.length} of the accepted claims on what this question is about${runnerUp ? `, more than anyone else (${runnerUp})` : ''}, so they are suggested to answer it.`,
  };
}
