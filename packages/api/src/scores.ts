import {
  byScore, ITEM_CALL_KIND, LOOP_POLICY_VERSION, posteriorOf, scoreCandidate, scoreClaim, scoreDecision, scoreLesson, scoreQuestion,
  APPROVE_SCORE_MODEL, VERDICT_NEIGHBOURS,
  type Candidate, type Claim, type Decision, type DecisionsStore, type DecisionType, type Lesson, type Question, type Scored,
  type VerdictKind, type VerdictNeighbour, type VerdictsStore,
} from '@fb/core';
import { z } from 'zod';

/**
 * The approve score on the review lists and details (core loop/approveScore.ts). Inbox items, lessons and claims: each
 * page reads your verdicts nearest its open rows in one lookup per kind (VerdictsStore.neighbours). Questions and the
 * loop calls on no single item: the proposed loop calls naming the rows and the calibration of their types. Without a
 * verdicts store, items are scored from their own features alone; without a loop store, questions are unscored.
 */
export type DecisionScored = { approveScore: number | null; scoreWhy: string | null };
export type ScoreSource = Pick<DecisionsStore, 'list' | 'calibration'>;
/** Your verdicts, and the reviewed items a loop call acts on (a call scores as its item does). */
export type ItemSource = {
  verdicts: Pick<VerdictsStore, 'neighbours'>;
  candidates?: (ids: string[]) => Promise<Candidate[]>;
  lessons?: (ids: string[]) => Promise<Lesson[]>;
  claims?: (ids: string[]) => Promise<Claim[]>;
};

/** ?sort=score: highest first, over the first SCORE_SORT_WINDOW matches (the stores page newest first). */
export const SortQuery = { sort: z.enum(['score']).optional() };
export const SCORE_SORT_WINDOW = 500;

/** The statuses up for review per kind (the rest are unscored). */
const OPEN: Record<VerdictKind | 'question', readonly string[]> = { candidate: ['pending'], lesson: ['proposed'], claim: ['proposed'], question: ['open', 'assigned'] };
const QUESTION_TYPES = ['assign_question', 'close_question'] as const satisfies readonly DecisionType[];

export function scorer(d?: ScoreSource, items?: ItemSource) {
  const calls = async (ids: string[]): Promise<Decision[]> =>
    d && ids.length ? d.list({ targets: ids, status: ['proposed'], author: 'loop', limit: Math.max(100, ids.length * 4) }) : [];
  const post = async (types: readonly DecisionType[]) =>
    posteriorOf(d && types.length ? (await Promise.all([...new Set(types)].map((t) => d.calibration(t, LOOP_POLICY_VERSION)))).flat() : []);
  const near = async (kind: VerdictKind, ids: string[]): Promise<Record<string, VerdictNeighbour[]>> =>
    items && ids.length ? items.verdicts.neighbours({ kind, ids, k: VERDICT_NEIGHBOURS, minCosine: APPROVE_SCORE_MODEL[kind].floor }) : {};
  /** Only the rows up for review cost a read: a page of decided ones reads nothing. */
  const each = <B extends { id: string; status: string }>(kind: VerdictKind, score: (row: B, near?: VerdictNeighbour[]) => Scored) =>
    async <T extends B>(rows: T[]): Promise<(T & Scored)[]> => {
      const found = await near(kind, rows.filter((r) => OPEN[kind].includes(r.status)).map((r) => r.id));
      return rows.map((r) => ({ ...r, ...score(r, found[r.id]) }));
    };
  const candidates = each<Pick<Candidate, 'id' | 'status' | 'classification' | 'source' | 'external'>>('candidate', scoreCandidate);
  const lessons = each<Pick<Lesson, 'id' | 'status' | 'checks'>>('lesson', scoreLesson);
  const claims = each<Pick<Claim, 'id' | 'status' | 'confidence' | 'flags' | 'type'> & { conflicts?: unknown[] }>('claim', scoreClaim);
  /** The items these calls act on, scored, by id. */
  const itemScores = async (rows: readonly Pick<Decision, 'type' | 'targets'>[]): Promise<Map<string, Scored>> => {
    const ids = (kind: VerdictKind) => [...new Set(rows.filter((r) => ITEM_CALL_KIND[r.type] === kind).flatMap((r) => r.targets.filter((t) => t.role === 'primary').map((t) => t.id)))];
    const load = async <T extends { id: string; status: string }>(kind: VerdictKind, read: ((ids: string[]) => Promise<T[]>) | undefined, score: (rows: T[]) => Promise<(T & Scored)[]>) => {
      const want = ids(kind);
      return want.length && read ? (await score(await read(want))).map((r) => [r.id, { score: r.score, scoreWhy: r.scoreWhy }] as const) : [];
    };
    const all = await Promise.all([load('candidate', items?.candidates, candidates), load('lesson', items?.lessons, lessons), load('claim', items?.claims, claims)]);
    return new Map(all.flat());
  };
  return {
    candidates,
    lessons,
    claims,
    async questions<T extends Pick<Question, 'id' | 'status'>>(rows: T[]): Promise<(T & Scored)[]> {
      const open = rows.filter((r) => OPEN.question.includes(r.status));
      const [found, p] = open.length ? await Promise.all([calls(open.map((r) => r.id)), post(QUESTION_TYPES)]) : [[], posteriorOf([])];
      return rows.map((r) => ({ ...r, ...scoreQuestion(r, found, p) }));
    },
    /**
     * A decision already has a `score` (the loop's raw score, before calibration), so its approve score is
     * `approveScore`, with `scoreWhy` as on every other item.
     */
    async decisions<T extends Pick<Decision, 'type' | 'status' | 'confidence' | 'author' | 'after' | 'targets'>>(rows: T[]): Promise<(T & DecisionScored)[]> {
      const proposed = rows.filter((r) => r.status === 'proposed');
      const [p, byItem] = await Promise.all([post(proposed.map((r) => r.type)), itemScores(proposed)]);
      return rows.map((r) => {
        const item = byItem.get(r.targets.find((t) => t.role === 'primary')?.id ?? '');
        const { score, scoreWhy } = scoreDecision(r, p, item);
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
