// Browser-safe (the UI imports @fb/core/relevance): type imports and types.ts only.
import type { FactHit } from './graph/facts.ts';
import { UNSCORED_RELEVANCE } from './types.ts';

/** Below this relevance a fact is "rare": setup of an external tool, CI or deploy steps, machine setup. */
export const RARE_BELOW = 0.4;
export const EVERYDAY_FROM = 0.7;
/** A rare fact (relevance < MIN_RELEVANCE) is served only when the task is at least this close to it. */
const MIN_RELEVANCE = 0.3;
const CLOSE_ENOUGH = 0.8;

export type RelevanceBand = 'everyday' | 'sometimes' | 'rare' | 'unscored';

export function relevanceBand(r: number | null): RelevanceBand {
  if (r === null) return 'unscored';
  return r >= EVERYDAY_FROM ? 'everyday' : r >= RARE_BELOW ? 'sometimes' : 'rare';
}

/**
 * The facts worth giving an agent, best first: similarity weighted by relevance (an unscored fact counts as middling),
 * so a convention it needs every day beats a slightly closer note on setting up some tool. A rare fact stays out
 * unless the task is very close to it, which is what a setup task looks like. `score` becomes the weighted score.
 */
export function rankFacts<T extends FactHit>(hits: T[], n: number): T[] {
  return hits
    .filter((h) => (h.fact.relevance ?? UNSCORED_RELEVANCE) >= MIN_RELEVANCE || h.score >= CLOSE_ENOUGH)
    .map((h) => ({ ...h, score: h.score * (0.55 + 0.45 * (h.fact.relevance ?? UNSCORED_RELEVANCE)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
