import { questionSnapshot, subjectTokens, type Claim, type Question } from '@fb/core';
import type { LoopTypeContext } from '../plugin.ts';
import { CLAIM_PAGE } from './claims.ts';

/** Open questions looked at per round, newest first. */
export const QUESTION_PAGE = 200;

/** The open questions no run made, of these statuses. */
export const openQuestions = async (ctx: LoopTypeContext, status: Question['status'][]) =>
  (await ctx.store.intake.listQuestions({ status, limit: QUESTION_PAGE })).filter((q) => !q.run && !q.sandbox);

/** What a question is about: the subject words of its text and quote. */
export const questionWords = (q: Pick<Question, 'text' | 'quote'>) => subjectTokens({ about: null, text: `${q.text} ${q.quote ?? ''}` });
/** What a claim is about: the subject words of its `about` and statement. */
export const claimWords = (c: Pick<Claim, 'about' | 'statement'>) => new Set([...subjectTokens({ about: c.about || null, text: c.statement }), ...subjectTokens({ about: null, text: c.statement })]);
/** The words of `q` that `c` shares. */
export const shared = (q: Set<string>, c: Set<string>) => [...q].filter((w) => c.has(w));

/** Accepted claims of each project (and the global ones), read once a round, no run's. */
export function acceptedClaims(ctx: LoopTypeContext): (projectKey: string | null) => Promise<Claim[]> {
  const cache = new Map<string, Promise<Claim[]>>();
  return (projectKey) => {
    const k = projectKey ?? '';
    if (!cache.has(k)) {
      cache.set(k, ctx.store.intake.listClaims({ status: ['accepted'], ...(projectKey && { projectKeys: [projectKey] }), limit: CLAIM_PAGE })
        .then((cs) => cs.filter((c) => !c.run && !c.sandbox && (c.projectKey === projectKey || c.projectKey === null))));
    }
    return cache.get(k)!;
  };
}

/** The question as the decision leaves it. */
export const questionAfter = (q: Question, patch: Partial<Pick<Question, 'status' | 'assignee' | 'answerClaimId'>>) => questionSnapshot({ ...q, ...patch });
