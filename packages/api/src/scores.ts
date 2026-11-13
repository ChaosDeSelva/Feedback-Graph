import {
  byScore, LOOP_POLICY_VERSION, posteriorOf, scoreCandidate, scoreClaim, scoreDecision, scoreLesson, scoreQuestion,
  type Candidate, type Claim, type Decision, type DecisionsStore, type DecisionType, type Lesson, type Question, type Scored,
} from '@fb/core';
import { z } from 'zod';

/**
 * The approve score on the review lists and details (core loop/approveScore.ts): each page reads the proposed loop
 * calls naming its rows in one list and the calibration of the types it needs. Without a loop store the items are
 * scored from their own signals alone.
 */
export type DecisionScored = { approveScore: number | null; scoreWhy: string | null };
export type ScoreSource = Pick<DecisionsStore, 'list' | 'calibration'>;

/** ?sort=score: highest first, over the first SCORE_SORT_WINDOW matches (the stores page newest first). */
export const SortQuery = { sort: z.enum(['score']).optional() };
export const SCORE_SORT_WINDOW = 500;

/** Per kind: the loop types whose calls score it, and the statuses that are up for review (the rest are unscored). */
const KINDS = {
  candidate: { types: ['triage_inbox'], open: ['pending'] },
  lesson: { types: ['approve_lesson', 'reject_lesson'], open: ['proposed'] },
  claim: { types: ['accept_claim'], open: ['proposed'] },
  question: { types: ['assign_question', 'close_question'], open: ['open', 'assigned'] },
} as const satisfies Record<string, { types: readonly DecisionType[]; open: readonly string[] }>;

export function scorer(d?: ScoreSource) {
  const calls = async (ids: string[]): Promise<Decision[]> =>
    d && ids.length ? d.list({ targets: ids, status: ['proposed'], author: 'loop', limit: Math.max(100, ids.length * 4) }) : [];
  const post = async (types: readonly DecisionType[]) =>
    posteriorOf(d ? (await Promise.all([...new Set(types)].map((t) => d.calibration(t, LOOP_POLICY_VERSION)))).flat() : []);
  /** Only the rows up for review cost a read: a page of decided ones reads nothing. */
  const each = <B extends { id: string; status: string }>(kind: { types: readonly DecisionType[]; open: readonly string[] }, score: (row: B, calls: Decision[], p: ReturnType<typeof posteriorOf>) => Scored) =>
    async <T extends B>(rows: T[]): Promise<(T & Scored)[]> => {
      const open = rows.filter((r) => kind.open.includes(r.status));
      const [found, p] = open.length ? await Promise.all([calls(open.map((r) => r.id)), post(kind.types)]) : [[], posteriorOf([])];
      return rows.map((r) => ({ ...r, ...score(r, found, p) }));
    };
  return {
    candidates: each(KINDS.candidate, scoreCandidate),
    lessons: each(KINDS.lesson, scoreLesson),
    claims: each(KINDS.claim, scoreClaim),
    questions: each(KINDS.question, scoreQuestion),
    /**
     * A decision already has a `score` (the loop's raw score, before calibration), so its approve score is
     * `approveScore`, with `scoreWhy` as on every other item.
     */
    async decisions<T extends Pick<Decision, 'type' | 'status' | 'confidence' | 'author'>>(rows: T[]): Promise<(T & DecisionScored)[]> {
      const p = await post(rows.filter((r) => r.status === 'proposed').map((r) => r.type));
      return rows.map((r) => {
        const { score, scoreWhy } = scoreDecision(r, p);
        return { ...r, approveScore: score, scoreWhy };
      });
    },
  };
}
export type Scorer = ReturnType<typeof scorer>;

/**
 * A page sorted by score: the first SCORE_SORT_WINDOW rows read, scored and ordered (ties keep the store's order), then
 * cut at offset. next: where the following page starts, or null.
 */
export async function pageByScore<T>(read: (limit: number) => Promise<T[]>, limit: number, offset: number, scoreOf: (row: T) => number | null = (r) => (r as Scored).score): Promise<{ page: T[]; next: number | null }> {
  const all = (await read(SCORE_SORT_WINDOW)).sort((a, b) => byScore({ score: scoreOf(a), scoreWhy: null }, { score: scoreOf(b), scoreWhy: null }));
  return { page: all.slice(offset, offset + limit), next: offset + limit < all.length ? offset + limit : null };
}
