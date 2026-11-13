/**
 * The similarity thresholds, in one place (0.9.1). Each says what it gates, in which unit, and why it has its value.
 * Two units are used, and they are not interchangeable:
 * - score: what the stores' vector searches return, (1 + cos) / 2 (Neo4j's cosine score; Postgres returns the same).
 * - cosine: the plain cosine of two stored embeddings (similarLessons, the duplicate and merge checks).
 * With nomic-embed-text (768 dimensions), two English sentences with no topic in common still score about 0.70-0.76
 * (the retrieval eval's non-applying lessons: 0.698 and up), a cosine of 0.40-0.52. scripts/retrieval-eval.ts measures the serving path on the labelled acme corpus
 * (testing/lessonCorpus.ts) with the real model; docs/operations.md#similarity-thresholds records its last run.
 */

/**
 * score. Below this, a past miss, a fact, a doc or a lesson found by meaning alone is never served: a nonsense task
 * gets nothing. Set in the field before 0.9 as the floor where unrelated work stopped reaching agents. The 0.9.1
 * retrieval eval (nomic-embed-text) kept it: all 9 lessons that apply to the labelled tasks score 0.787 or more, and
 * 7 non-applying lessons of the tasks' top 5 clear it; 0.80 drops 2 applying lessons, 0.75 lets in 32 others.
 */
export const SERVE_BY_MEANING = 0.78;

/**
 * cosine. Two lessons of one project this close say the same thing: the lesson re-check flags the newer duplicate-of
 * (worker postmortem/recheck.ts), and merge_duplicates may merge it. Kept from 0.7: a flag only, which you or the loop
 * act on, so it sits where a pair is very likely one rule. The retrieval eval does not measure pairs, so it is unchanged.
 */
export const DUPLICATE_FLAG = 0.92;

/**
 * cosine. Two approved lessons are merged on the loop's own (merge_duplicates, auto) only this close and only when the
 * duplicate names no file the keeper does not: merging two rules agents follow is the costliest merge to get wrong, so
 * it is above DUPLICATE_FLAG, and anything under it waits for you as a proposal. Kept from 0.8.0; not measured by the eval.
 */
export const AUTO_MERGE = 0.95;

/**
 * cosine. The near-duplicate middle band (0.9.1): two lessons from this bar up to DUPLICATE_FLAG are not a duplicate
 * by the cosine alone; the learning loop asks its model, a yes or no, whether they say the same thing (merge_duplicates).
 * 0.85 is where a cosine stops being enough on its own either way: lower pairs are left alone, and the judge's calls
 * are spent only on the pairs a number cannot settle. Its answer only ever makes a proposal.
 */
export const NEAR_DUPLICATE_FROM = 0.85;

/**
 * Inbox dedupe by words (core dedupe.ts): an agent's report and a flagged turn within INBOX_MERGE_MINUTES are one miss
 * when this share of the shorter one's words is in the other (or they share a session). 0.6 and 60 minutes since 0.6.x:
 * the agent reports after fixing the work, usually within the hour, in words close to the developer's.
 */
export const INBOX_WORD_OVERLAP = 0.6;
export const INBOX_MERGE_MINUTES = 60;

/**
 * cosine. Inbox dedupe by meaning (0.9.1): a report and a flagged turn of the same project this close are one miss
 * within INBOX_SEMANTIC_DAYS, so a reworded complaint, or the same one the next day, joins the first item. 0.85 is
 * well above what unrelated sentences reach (cosine 0.40-0.55 on nomic-embed-text) and as strict as the bar a past miss
 * clears to be served with no file in common (relevance.ts MISS_CLOSE); a merge keeps both texts, and a wrong one is
 * undone by rejecting the item. Three days covers a complaint repeated the next working day.
 */
export const INBOX_SEMANTIC_COSINE = 0.85;
export const INBOX_SEMANTIC_DAYS = 3;

/**
 * relevance (a fact's 0-1 score, not a similarity). An accepted claim's fact, until you or the loop score it: everyday,
 * the lowest relevance a fact with no file in the task is served at (rankFacts' FACT_RANK_FLOOR); the design's
 * "sometimes" (0.55) kept every one from agents. The review route, import and the loop's accept_claim all file it so.
 */
export const CLAIM_FACT_RELEVANCE = 0.8;

/** How many of your verdicts nearest an item the approve score reads (loop/itemScore.ts, 0.9.5). */
export const VERDICT_NEIGHBOURS = 10;
/** A verdict made in another project counts this much of one in the item's own project. Not fitted: a stated choice. */
export const VERDICT_CROSS_PROJECT_WEIGHT = 0.5;
/** The neighbours' approve rate is a Beta posterior with this many labels of prior at your approve rate for the kind. */
export const VERDICT_PRIOR_LABELS = 2;

/**
 * One kind's approve-score model (loop/itemScore.ts): logit P(approve) = intercept + verdicts x (logit(neighbour rate) -
 * logit(base)) + sum(features[name] x value). floor (cosine): your verdicts on items at least this close are read,
 * each weighing (cosine - floor) / (1 - floor). base: your approve rate for the kind. featureLabels: how many labels
 * the features are worth when the score is shrunk toward 5 (added to the neighbours' weight); a stated choice, not
 * fitted (0.9.4's SIGNAL_LABELS).
 */
export type ScoreModel = { floor: number; base: number; intercept: number; verdicts: number; features: Record<string, number>; featureLabels: number };

/**
 * Fitted offline by scripts/score-eval.ts on the owner's own verdicts (decidedBy 'you') in a copy of the author's
 * install, 2026-11-13: 287 Inbox verdicts (179 confirmed) and 240 lesson verdicts (153 approved). Floor and L2 penalty
 * chosen on the older 70% alone; on the newer 30% (each item scored only from verdicts made before it) the score's AUC
 * was 0.80 for Inbox items (0.9.4: one score per band; its no-call signal 0.62) and 0.76 for lessons (0.49). The
 * coefficients are the refit on every verdict at that floor and penalty. docs/operations.md#measuring-the-approve-score
 * has the decile tables and how to rerun it on your own store. Claims had one verdict: their model is stated, not
 * fitted (confidence and flags as 0.9.4 read them), and its neighbours term is the same as the others'.
 */
export const APPROVE_SCORE_MODEL: Record<'candidate' | 'lesson' | 'claim', ScoreModel> = {
  candidate: { floor: 0.4, base: 0.62, intercept: 0.08, verdicts: 0.47, features: { classifier: 0.07, synced: 0.03, prAuthor: -0.61, reply: -0.23, merged: 0.44, closedUnmerged: -0.17, bot: 0 }, featureLabels: 4 },
  lesson: { floor: 0.5, base: 0.64, intercept: 0.95, verdicts: 0.92, features: { failsCheck: 0.29, badPath: 0.29, flagged: -1.76, unchecked: 0 }, featureLabels: 4 },
  claim: { floor: 0.5, base: 0.5, intercept: 0, verdicts: 1, features: { confidence: 0.7, flagged: -0.8, opinion: -0.3 }, featureLabels: 4 },
};
