import { Badge, type Tone } from './display.tsx';

/**
 * The approve score (0.9.4, core loop/approveScore.ts): the calibrated chance, 0-10, that your verdict is approve. The
 * bands repeat core's SCORE_HIGH and SCORE_LOW (the UI does not load core's runtime): green says approve, red reject,
 * grey a judgement call. The number is the label, so the colour is never the only cue.
 */
export const SCORE_HIGH = 7;
export const SCORE_LOW = 3;
export type ScoreBand = 'high' | 'middle' | 'low';
export const scoreBand = (score: number): ScoreBand => (score >= SCORE_HIGH ? 'high' : score <= SCORE_LOW ? 'low' : 'middle');
const TONE: Record<ScoreBand, Tone> = { high: 'ok', middle: 'neutral', low: 'bad' };
export type Scored = { score?: number | null; scoreWhy?: string | null };

/** Highest first, unscored last (ties keep their order). */
export const byScore = (a: Scored, b: Scored) => (b.score ?? -1) - (a.score ?? -1);
/** Judgement calls (the middle band) first, nearest 5 first, then the rest by score; unscored last. */
export function judgementFirst(a: Scored, b: Scored) {
  const k = (s: number | null | undefined) => (s == null ? 99 : scoreBand(s) === 'middle' ? Math.abs(s - 5) : 10 + (10 - s));
  return k(a.score) - k(b.score);
}

export function ScoreChip({ score, why, className = '' }: { score: number | null | undefined; why: string | null | undefined; className?: string }) {
  if (score == null) return null;
  const band = scoreBand(score);
  const reasons = why?.replace(/^\d+(?:\.\d)? · /, '') ?? '';
  return (
    <span role="img" aria-label={`Approve score ${score.toFixed(1)} of 10${reasons ? `: ${reasons}` : ''}`} data-band={band} className={`inline-flex ${className}`}>
      <Badge tone={TONE[band]} title={why ?? undefined} className="tabular-nums">
        <span aria-hidden="true">{score.toFixed(1)}</span>
      </Badge>
    </span>
  );
}
