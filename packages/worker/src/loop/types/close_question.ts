import { questionSnapshot, type Claim, type Question } from '@fb/core';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { decidedAlready } from './approve_lesson.ts';
import { acceptedClaims, claimWords, openQuestions, questionAfter, questionWords, shared } from './questions.ts';

/** The answering claim shares at least this many of the question's subject words, and this share of them. */
export const CLOSE_MIN_WORDS = 2;
export const CLOSE_MIN_SHARE = 0.5;

/**
 * close_question (tier P: always a proposal): an open or assigned question that a later accepted claim answers (a
 * claim you accepted after the question was asked, not of an opinion, sharing at least CLOSE_MIN_WORDS and
 * CLOSE_MIN_SHARE of its subject words) is proposed closed as answered by that claim, which the proposal cites.
 * Approving it marks the question answered by it; rolling it back reopens it.
 */
export const closeQuestion: LoopType = {
  type: 'close_question',
  weights: { bias: -1, share: 2, words: 1 },
  groups: { evidence: ['share', 'words'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const open = await openQuestions(ctx, ['open', 'assigned']);
    const accepted = acceptedClaims(ctx);
    for (const q of open) {
      if (!ctx.inScope(q.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      const words = questionWords(q);
      let best: { c: Claim; n: number } | null = null;
      for (const c of await accepted(q.projectKey)) {
        if (c.type === 'opinion' || !c.decidedAt || c.decidedAt <= q.createdAt) continue;
        const n = shared(words, claimWords(c)).length;
        if (n >= CLOSE_MIN_WORDS && n / words.size >= CLOSE_MIN_SHARE && (!best || n > best.n || (n === best.n && c.id < best.c.id))) best = { c, n };
      }
      if (!best) { skip(skipped, SKIP.belowFloor); continue; }
      if (await decidedAlready(ctx, 'close_question', q.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
      candidates.push(closeCandidate(q, best.c, best.n, words.size));
    }
    return { candidates, scanned: open.length, skipped };
  },
};

export function closeCandidate(q: Question, c: Claim, n: number, of: number): LoopCandidate {
  return {
    projectKey: q.projectKey,
    targets: [{ kind: 'question', id: q.id, role: 'primary' }],
    before: [questionSnapshot(q)],
    after: [questionAfter(q, { status: 'answered', answerClaimId: c.id })],
    evidence: [{ kind: 'claim', id: c.id, role: 'answers it', weight: Math.round((n / of) * 1000) / 1000, observedAt: c.decidedAt ?? c.createdAt }],
    features: { share: Math.round((n / of) * 1000) / 1000, words: Math.min(n, 5) / 5 },
    subject: `close "${q.text.slice(0, 60)}" as answered`,
    rationale: `The ${c.type} claim ${c.id}, accepted after the question was asked, answers it: "${c.statement.slice(0, 200)}" (it shares ${n} of the question's ${of} subject words).`,
  };
}
