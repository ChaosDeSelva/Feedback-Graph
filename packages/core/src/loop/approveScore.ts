// Browser-safe (the UI reads the bands): type imports only, besides beta.ts, state.ts, itemScore.ts and the thresholds.
import type { VerdictKind, VerdictNeighbour } from '../store.ts';
import type { CalibrationBucket, Candidate, Claim, Decision, DecisionType, Lesson, LessonCheckName, Question } from '../types.ts';
import { betaQuantile, CALIBRATION_LOWER_QUANTILE } from './beta.ts';
import type { ScoreModel } from '../thresholds.ts';
import { candidateFeatures, claimFeatures, itemChance, lessonFeatures, type Feature } from './itemScore.ts';
import { LOOP_POLICY_VERSION, LOOP_TYPE_INFO } from './state.ts';

/**
 * The approve score (0.9.4; per item since 0.9.5): for a reviewable item, the chance (0-10, one decimal) that your
 * verdict is approve (confirm, accept, approve the proposal). Inbox items, lessons and claims are scored from your own
 * past verdicts on the items most like them and a few of their features (loop/itemScore.ts); open questions and the
 * loop calls that act on no single reviewed item from the loop's calibration of their type in their band. Either way
 * the chance is shrunk toward 5 by how little evidence it rests on, and a blocking flag caps it at BLOCKING_SCORE_CAP.
 * It ranks and explains; it never gates anything: the loop acts on its own only by its calibration (loop/state.ts).
 */
export type Scored = { score: number | null; scoreWhy: string | null };
export const UNSCORED: Scored = { score: null, scoreWhy: null };

/** At or above: the evidence says approve (green). At or below SCORE_LOW: reject (red). Between: your call (grey). */
export const SCORE_HIGH = 7;
export const SCORE_LOW = 3;
export type ScoreBand = 'high' | 'middle' | 'low';
export const scoreBand = (score: number): ScoreBand => (score >= SCORE_HIGH ? 'high' : score <= SCORE_LOW ? 'low' : 'middle');

/** Flags that say a person must read the item first: they hold the score at or under BLOCKING_SCORE_CAP. */
export const SCORE_BLOCKING_FLAGS = ['risky-command', 'may-hold-secret', 'off-turn', 'example-applies-when'] as const satisfies readonly LessonCheckName[];
export const BLOCKING_SCORE_CAP = 2;
/** A claim flag or an open conflict: accept_claim's floors refuse it, so it is never above a judgement call. */
export const CLAIM_FLAG_CAP = 5;
/** The 80% interval of Beta(1, 1): no evidence at all, so no weight off 5. */
const NO_EVIDENCE_WIDTH = 1 - 2 * CALIBRATION_LOWER_QUANTILE;

export type Posterior = { alpha: number; beta: number; n: number };
/** The current posterior of a type's band: its calibration bucket, else the type's prior with no labels. */
export type PosteriorOf = (type: DecisionType, band: number) => Posterior;

export function posteriorOf(buckets: readonly CalibrationBucket[]): PosteriorOf {
  const by = new Map(buckets.filter((b) => b.policyVersion === LOOP_POLICY_VERSION).map((b) => [`${b.type}:${b.band}`, b]));
  return (type, band) => {
    const b = by.get(`${type}:${band}`);
    const prior = LOOP_TYPE_INFO[type].prior;
    return b ? { alpha: b.alpha, beta: b.beta, n: b.n } : { alpha: prior.alpha, beta: prior.beta, n: 0 };
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const two = (p: number) => p.toFixed(2).replace(/^0(?=\.)/, '');

/** The chance of approve, shrunk toward one half by the width of the posterior it came from (0 weight at Beta(1, 1)). */
export function shrink(pApprove: number, post: Pick<Posterior, 'alpha' | 'beta'>): number {
  const width = betaQuantile(1 - CALIBRATION_LOWER_QUANTILE, post.alpha, post.beta) - betaQuantile(CALIBRATION_LOWER_QUANTILE, post.alpha, post.beta);
  const weight = clamp01(1 - width / NO_EVIDENCE_WIDTH);
  return 0.5 + (clamp01(pApprove) - 0.5) * weight;
}

const toScore = (q: number) => Math.round(clamp01(q) * 100) / 10;
const scored = (score: number, reasons: string[]): Scored => ({ score, scoreWhy: `${score.toFixed(1)} · ${reasons.slice(0, 2).join('; ')}` });

/** A loop call on the item: its type and band, and whether doing it is your approve or your reject. */
export type ScoreCall = { type: DecisionType; band: number; approves: boolean };

/** The chance of approve from a calibrated call, and why. */
export function fromCall(call: ScoreCall, post: PosteriorOf): { q: number; why: string } {
  const b = post(call.type, call.band);
  const p = b.alpha / (b.alpha + b.beta);
  const kept = Math.max(0, Math.round(b.alpha - LOOP_TYPE_INFO[call.type].prior.alpha));
  const record = b.n ? `you kept ${kept} of ${b.n} in its band (p ${two(p)})` : `none of yours in its band yet (prior p ${two(p)})`;
  return { q: shrink(call.approves ? p : 1 - p, b), why: `loop proposes ${call.type}: ${record}` };
}

/** One score from the evidence (its reasons, strongest first), then the caps in order (lowest wins), each cap's reason first. */
function finish(base: { q: number; why: string | string[] }, caps: { at: number; why: string }[]): Scored {
  let score = toScore(base.q);
  const reasons = typeof base.why === 'string' ? [base.why] : [...base.why];
  for (const c of [...caps].sort((a, b) => b.at - a.at)) {
    if (score > c.at) { score = c.at; reasons.unshift(c.why); }
  }
  return scored(score, reasons);
}

/** The newest proposed loop decision of these types naming `id` as its primary target (list order is newest first). */
export function callOn(id: string, decisions: readonly Decision[], types: readonly DecisionType[]): Decision | null {
  return decisions.find((d) => d.status === 'proposed' && (d.author ?? 'loop') === 'loop' && types.includes(d.type) && d.targets.some((t) => t.id === id && t.role === 'primary')) ?? null;
}

/**
 * The per-item chance (loop/itemScore.ts) as a score's evidence: shrunk toward one half as a Beta of `labels` labels
 * would be (your similar verdicts' weight plus what the features are worth), so an item like nothing you decided
 * reads near 5.
 */
export function fromItem(kind: VerdictKind, features: Feature[], near: readonly VerdictNeighbour[] | undefined, model?: ScoreModel): { q: number; why: string[] } {
  const { p, labels, reasons } = itemChance(kind, features, near, model);
  return { q: shrink(p, { alpha: 1 + labels * p, beta: 1 + labels * (1 - p) }), why: reasons };
}

/**
 * A pending Inbox item: approve is confirm. 0.9.5: scored from your verdicts on the items nearest it and its own
 * features (classifier, who wrote it, its PR's state), not from the triage call (loop calibration still decides when the
 * loop triages on its own). `near`: VerdictsStore.neighbours for it; unset or [] when it has no embedding or no close verdicts.
 */
export function scoreCandidate(c: Pick<Candidate, 'status' | 'classification' | 'source' | 'external'>, near?: readonly VerdictNeighbour[]): Scored {
  if (c.status !== 'pending') return UNSCORED;
  return finish(fromItem('candidate', candidateFeatures(c), near), []);
}

/** A proposed lesson: approve is approving it. Its checks and your verdicts on similar lessons; a blocking flag caps it. */
export function scoreLesson(l: Pick<Lesson, 'status' | 'checks'>, near?: readonly VerdictNeighbour[]): Scored {
  if (l.status !== 'proposed') return UNSCORED;
  const names = [...new Set((l.checks ?? []).map((c) => c.name))];
  const caps = names.filter((n) => (SCORE_BLOCKING_FLAGS as readonly string[]).includes(n)).map((n) => ({ at: BLOCKING_SCORE_CAP, why: `flagged ${n}` }));
  return finish(fromItem('lesson', lessonFeatures(l), near), caps);
}

/** A proposed claim: approve is accepting it; a flag or open conflict caps it. */
export function scoreClaim(c: Pick<Claim, 'status' | 'confidence' | 'flags' | 'type'> & { conflicts?: unknown[] }, near?: readonly VerdictNeighbour[]): Scored {
  if (c.status !== 'proposed') return UNSCORED;
  const caps = [
    ...(c.flags.length ? [{ at: CLAIM_FLAG_CAP, why: `flagged ${c.flags.join(', ')}` }] : []),
    ...(c.conflicts?.length ? [{ at: CLAIM_FLAG_CAP, why: 'an open conflict names it' }] : []),
  ];
  return finish(fromItem('claim', claimFeatures(c), near), caps);
}

/** An open question: scored only when the loop proposes assigning or closing it (approve is doing that). */
export function scoreQuestion(q: Pick<Question, 'id' | 'status'>, decisions: readonly Decision[], post: PosteriorOf): Scored {
  if (q.status !== 'open' && q.status !== 'assigned') return UNSCORED;
  const call = callOn(q.id, decisions, ['assign_question', 'close_question']);
  return call ? finish(fromCall({ type: call.type, band: call.confidence.band, approves: true }, post), []) : UNSCORED;
}

/** The loop types that act on one reviewed item: their approve score is the item's (reversed when the call rejects it). */
export const ITEM_CALL_KIND: Partial<Record<DecisionType, VerdictKind>> = { triage_inbox: 'candidate', approve_lesson: 'lesson', reject_lesson: 'lesson', accept_claim: 'claim' };

/** Whether applying an item call is your approve of its item (confirm, approve, accept) rather than your reject. */
export function callApproves(d: Pick<Decision, 'type' | 'after' | 'targets'>): boolean {
  if (d.type === 'reject_lesson') return false;
  if (d.type !== 'triage_inbox') return true;
  const id = d.targets.find((t) => t.role === 'primary')?.id;
  return d.after.find((a) => a.id === id)?.fields.status === 'confirmed';
}

/**
 * A proposed loop decision: approve is applying it. One that acts on a reviewed item (ITEM_CALL_KIND) scores as that
 * item does (`item`: its Scored), 10 minus it when applying the call rejects the item; the rest at its type's
 * calibrated p in its band.
 */
export function scoreDecision(d: Pick<Decision, 'type' | 'status' | 'confidence' | 'author' | 'after' | 'targets'>, post: PosteriorOf, item?: Scored): Scored {
  if (d.status !== 'proposed' || (d.author ?? 'loop') !== 'loop') return UNSCORED;
  if (ITEM_CALL_KIND[d.type] && item?.score != null) {
    const score = callApproves(d) ? item.score : Math.round((10 - item.score) * 10) / 10;
    return { score, scoreWhy: `${score.toFixed(1)} · ${item.scoreWhy!.replace(/^\S+ · /, '')}` };
  }
  return finish(fromCall({ type: d.type, band: d.confidence.band, approves: true }, post), []);
}

/** Highest score first; unscored last; ties keep their order. */
export const byScore = <T extends Scored>(a: T, b: T) => (b.score ?? -1) - (a.score ?? -1);
/** Judgement calls (the middle band) first, nearest 5 first, then the rest by score; unscored last. */
export const judgementFirst = <T extends Scored>(a: T, b: T) => {
  const k = (s: number | null) => (s === null ? 99 : scoreBand(s) === 'middle' ? Math.abs(s - 5) : 10 + (10 - s));
  return k(a.score) - k(b.score);
};
