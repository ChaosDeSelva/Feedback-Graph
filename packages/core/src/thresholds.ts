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
