// Browser-safe (lessonRank and the serving path import it): type imports only.
import type { Lesson } from '../types.ts';

/** Lesson.servingWeight's range and the most one rank_weight decision moves it. */
export const SERVING_WEIGHT_MIN = 0.5;
export const SERVING_WEIGHT_MAX = 1.5;
export const SERVING_WEIGHT_STEP = 0.1;

/** A weight as stored: in range, to one decimal, so steps add up exactly. */
export const roundWeight = (w: number) => Math.round(Math.min(SERVING_WEIGHT_MAX, Math.max(SERVING_WEIGHT_MIN, w)) * 10) / 10;

/** The lesson's serving weight: 1 when no decision set one. */
export const servingWeightOf = (l: Pick<Lesson, 'servingWeight'>) => l.servingWeight ?? 1;

/**
 * How far apart in relevance two lessons may be for a serving weight to swap them: the weight breaks near-ties, it
 * never outweighs a clearly better match (relevance across the lessons tied to one file spans only about 0.2).
 */
export const WEIGHT_TIE_BAND = 0.02;

/**
 * Lessons already chosen for the task (tied to its files), in the order given (best first), with the weighted ones
 * reordered among themselves by score plus their weight's share of WEIGHT_TIE_BAND: a weight moves a lesson only past
 * another weighted one less than the band apart. A lesson with no weight (1: one the loop never weighed, every
 * held-out lesson among them) keeps its place, so no weight ever pushes it down or out of a cut. It only reorders:
 * nothing is added or dropped.
 */
export function orderByServingWeight<T extends { lesson: Pick<Lesson, 'servingWeight'>; score: number }>(hits: T[]): T[] {
  const slots = hits.flatMap((h, i) => (servingWeightOf(h.lesson) === 1 ? [] : [i]));
  if (!slots.length) return hits;
  const key = (h: T) => h.score + (WEIGHT_TIE_BAND / 2) * ((servingWeightOf(h.lesson) - 1) / (SERVING_WEIGHT_MAX - 1));
  const weighted = slots.map((i) => ({ h: hits[i], i })).sort((a, b) => key(b.h) - key(a.h) || a.i - b.i);
  const out = [...hits];
  slots.forEach((slot, k) => { out[slot] = weighted[k].h; });
  return out;
}

/** How far a project's floor may move from the default (tune_threshold). */
export const TUNE_MARGIN = 0.03;
