// Browser-safe (the UI reads the bands): type imports only, besides beta.ts and state.ts.
import type { CalibrationBucket, Candidate, Claim, Decision, DecisionType, Lesson, LessonCheckName, Question } from '../types.ts';
import { betaQuantile, CALIBRATION_LOWER_QUANTILE } from './beta.ts';
import { LOOP_POLICY_VERSION, LOOP_TYPE_INFO } from './state.ts';

/**
 * The approve score (0.9.4): for a reviewable item, the chance (0-10, one decimal) that your verdict is approve
 * (confirm, accept, approve the proposal). It is read off what the loop already calibrates, not a new model: the
 * newest proposed loop call on the item and the Beta posterior of that call's type in its band (10 x p when the call
 * approves, 10 x (1 - p) when it rejects). An item no call names falls back to its own uncalibrated signal (the
 * classifier's confidence, the lesson checks, the claim's confidence), counted as SIGNAL_LABELS labels. Either way the
 * chance is shrunk toward 5 by the posterior's width, so little evidence reads as a judgement call; a blocking flag
 * caps it at BLOCKING_SCORE_CAP.
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
/**
 * The lesson checks that block a lesson: reject_lesson proposes rejecting one carrying any (its floor). Read here as a
 * reason to reject when no call names the lesson yet.
 */
export const LESSON_BLOCKING_CHECKS: readonly LessonCheckName[] = ['platitude', 'generic', 'meta-lesson', 'not-pushback', 'no-miss', 'self-review', 'wrong-session'];
/** A claim flag or an open conflict: accept_claim's floors refuse it, so it is never above a judgement call. */
export const CLAIM_FLAG_CAP = 5;
/**
 * An uncalibrated signal (a confidence nobody has checked against your verdicts) weighs as this many labels on a flat
 * Beta(1, 1): a 95% classifier alone scores 6.7, under the green band, until your reviews calibrate a call.
 */
export const SIGNAL_LABELS = 4;
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

/** The chance of approve from an uncalibrated signal (p: its own chance of approve), and why. */
export function fromSignal(p: number, why: string): { q: number; why: string } {
  const post = { alpha: 1 + SIGNAL_LABELS * clamp01(p), beta: 1 + SIGNAL_LABELS * (1 - clamp01(p)) };
  return { q: shrink(post.alpha / (post.alpha + post.beta), post), why };
}

/** One score from the evidence, then the caps in order (lowest wins), each cap's reason first. */
function finish(base: { q: number; why: string }, caps: { at: number; why: string }[]): Scored {
  let score = toScore(base.q);
  const reasons = [base.why];
  for (const c of [...caps].sort((a, b) => b.at - a.at)) {
    if (score > c.at) { score = c.at; reasons.unshift(c.why); }
  }
  return scored(score, reasons);
}

/** The newest proposed loop decision of these types naming `id` as its primary target (list order is newest first). */
export function callOn(id: string, decisions: readonly Decision[], types: readonly DecisionType[]): Decision | null {
  return decisions.find((d) => d.status === 'proposed' && (d.author ?? 'loop') === 'loop' && types.includes(d.type) && d.targets.some((t) => t.id === id && t.role === 'primary')) ?? null;
}
const afterStatus = (d: Decision, id: string) => d.after.find((a) => a.id === id)?.fields.status;

/** A pending Inbox item: approve is confirm (a triage_inbox call, else the classifier). */
export function scoreCandidate(c: Pick<Candidate, 'id' | 'status' | 'classification'>, decisions: readonly Decision[], post: PosteriorOf): Scored {
  if (c.status !== 'pending') return UNSCORED;
  const call = callOn(c.id, decisions, ['triage_inbox']);
  if (call) return finish(fromCall({ type: call.type, band: call.confidence.band, approves: afterStatus(call, c.id) === 'confirmed' }, post), []);
  const { label, confidence } = c.classification;
  const pushback = label === 'pushback' || label === 'correction';
  return finish(fromSignal(pushback ? confidence : 1 - confidence, `classifier ${Math.round(confidence * 100)}% sure it is ${label}`), []);
}

/** A proposed lesson: approve is approving it (an approve_lesson or reject_lesson call, else its checks). */
export function scoreLesson(l: Pick<Lesson, 'id' | 'status' | 'checks'>, decisions: readonly Decision[], post: PosteriorOf): Scored {
  if (l.status !== 'proposed') return UNSCORED;
  const names = [...new Set((l.checks ?? []).map((c) => c.name))];
  const caps = names.filter((n) => (SCORE_BLOCKING_FLAGS as readonly string[]).includes(n)).map((n) => ({ at: BLOCKING_SCORE_CAP, why: `flagged ${n}` }));
  const call = callOn(l.id, decisions, ['approve_lesson', 'reject_lesson']);
  if (call) return finish(fromCall({ type: call.type, band: call.confidence.band, approves: call.type === 'approve_lesson' }, post), caps);
  const blocking = names.filter((n) => LESSON_BLOCKING_CHECKS.includes(n));
  const base = l.checks == null ? { q: 0.5, why: 'not checked yet' }
    : blocking.length ? fromSignal(0.2, `fails check ${blocking.slice(0, 2).join(', ')}`)
      : names.length ? fromSignal(0.5, `flagged ${names.slice(0, 2).join(', ')}`)
        : fromSignal(0.8, 'no lesson check flags it');
  return finish(base, caps);
}

/** A proposed claim: approve is accepting it (an accept_claim call, else its confidence); a flag or open conflict caps it. */
export function scoreClaim(c: Pick<Claim, 'id' | 'status' | 'confidence' | 'flags'> & { conflicts?: unknown[] }, decisions: readonly Decision[], post: PosteriorOf): Scored {
  if (c.status !== 'proposed') return UNSCORED;
  const caps = [
    ...(c.flags.length ? [{ at: CLAIM_FLAG_CAP, why: `flagged ${c.flags.join(', ')}` }] : []),
    ...(c.conflicts?.length ? [{ at: CLAIM_FLAG_CAP, why: 'an open conflict names it' }] : []),
  ];
  const call = callOn(c.id, decisions, ['accept_claim']);
  return finish(call ? fromCall({ type: call.type, band: call.confidence.band, approves: true }, post) : fromSignal(c.confidence, `extraction ${Math.round(c.confidence * 100)}% sure`), caps);
}

/** An open question: scored only when the loop proposes assigning or closing it (approve is doing that). */
export function scoreQuestion(q: Pick<Question, 'id' | 'status'>, decisions: readonly Decision[], post: PosteriorOf): Scored {
  if (q.status !== 'open' && q.status !== 'assigned') return UNSCORED;
  const call = callOn(q.id, decisions, ['assign_question', 'close_question']);
  return call ? finish(fromCall({ type: call.type, band: call.confidence.band, approves: true }, post), []) : UNSCORED;
}

/** A proposed loop decision: approve is applying it, at its type's calibrated p in its band. */
export function scoreDecision(d: Pick<Decision, 'type' | 'status' | 'confidence' | 'author'>, post: PosteriorOf): Scored {
  if (d.status !== 'proposed' || (d.author ?? 'loop') !== 'loop') return UNSCORED;
  return finish(fromCall({ type: d.type, band: d.confidence.band, approves: true }, post), []);
}

/** Highest score first; unscored last; ties keep their order. */
export const byScore = <T extends Scored>(a: T, b: T) => (b.score ?? -1) - (a.score ?? -1);
/** Judgement calls (the middle band) first, nearest 5 first, then the rest by score; unscored last. */
export const judgementFirst = <T extends Scored>(a: T, b: T) => {
  const k = (s: number | null) => (s === null ? 99 : scoreBand(s) === 'middle' ? Math.abs(s - 5) : 10 + (10 - s));
  return k(a.score) - k(b.score);
};
