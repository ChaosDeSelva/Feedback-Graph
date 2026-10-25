// Browser-safe (the UI imports @fb/core/relevance): type imports and types.ts only.
import type { FactHit } from './graph/facts.ts';
import { UNSCORED_RELEVANCE, type FactOrigin } from './types.ts';

/**
 * Where a fact came from: as recorded, else (a fact saved before that was recorded) a document fact by its docId and a
 * manifest fact by the reason the manifest reader always gives.
 */
export function factOrigin(f: { origin?: FactOrigin | null; docId?: string | null; why?: string | null }): FactOrigin {
  if (f.origin) return f.origin;
  if (f.docId) return 'document';
  return /^Read directly from \S+; no model involved\.$/.test(f.why ?? '') ? 'manifest' : 'model';
}

/** Below this relevance a fact is "rare": setup of an external tool, CI or deploy steps, machine setup. */
export const RARE_BELOW = 0.4;
/** Where the rubric's "needed in most changes" starts (RELEVANCE_RUBRIC in the scan); 0.4 to 0.7 is "some changes". */
export const EVERYDAY_FROM = 0.8;
/** A rare fact (relevance < MIN_RELEVANCE) is served only when the task is at least this close to it. */
const MIN_RELEVANCE = 0.3;
const CLOSE_ENOUGH = 0.8;
/** Similarity below which a past miss is never served, whatever else ranks. */
const MISS_FLOOR = 0.3;
/** A fact or miss scoring under this share of the best one is noise next to it, and is left out. */
const RELATIVE_FLOOR = 0.6;

export type RelevanceBand = 'everyday' | 'sometimes' | 'rare' | 'unscored';

export function relevanceBand(r: number | null): RelevanceBand {
  if (r === null) return 'unscored';
  return r >= EVERYDAY_FROM ? 'everyday' : r >= RARE_BELOW ? 'sometimes' : 'rare';
}

const NON_MISS = /^\s*(?:the agent|it|this|there)\s+(?:did not|didn't|was not|wasn't|is not|isn't)\s+(?:miss\b|a miss\b)|^\s*no miss\b|\bnot a (?:real |genuine )?miss\b/i;

/** A post-mortem that concluded the agent missed nothing ("The agent did not miss the feedback, ..."): never served. */
export function isNonMiss(missed: string): boolean {
  return NON_MISS.test(missed);
}

const dirSegs = (path: string) => path.replace(/^\.\//, '').split('/').slice(0, -1).filter(Boolean);

/**
 * How much a fact or miss about `path` is worth to a task naming `files`, as a weight: above 1 when its folder holds
 * one of them (an AGENTS.md or README governing them) or it is in the same service (the first two folders match),
 * below 1 when it is in another service, 1 when it is project-wide or no files were named.
 */
export function pathAffinity(path: string, files: string[]): number {
  const own = dirSegs(path);
  if (!files.length || path === '.' || !own.length) return 1;
  let best = 0.75;
  for (const f of files) {
    const theirs = dirSegs(f);
    let common = 0;
    while (common < own.length && common < theirs.length && own[common] === theirs[common]) common++;
    if (common === own.length) return 1.3;
    if (common >= 2) best = Math.max(best, 1.15);
    else if (theirs.length < 2) best = Math.max(best, 1);
  }
  return best;
}

/** Repo paths a model's text mentions ("in src/api/orders.ts"): a slash inside, no spaces, no URL. */
function mentionedPaths(text: string): string[] {
  return [...text.matchAll(/(?<![\w:/.-])((?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)+)/g)].map((m) => m[1]);
}

const keepNearBest = <T extends { score: number }>(xs: T[]) => {
  const best = xs[0]?.score ?? 0;
  return xs.filter((x) => x.score >= best * RELATIVE_FLOOR);
};

/**
 * The facts worth giving an agent, best first: similarity weighted by relevance (an unscored fact counts as middling),
 * so a convention it needs every day beats a slightly closer note on setting up some tool. A rare fact stays out
 * unless the task is very close to it, which is what a setup task looks like. With `files` (the files the task
 * names), facts of their folders and service rank up and other services' down (pathAffinity). Facts far below the
 * best are dropped. `score` becomes the weighted score.
 */
export function rankFacts<T extends FactHit>(hits: T[], n: number, files: string[] = []): T[] {
  return keepNearBest(
    hits
      .filter((h) => (h.fact.relevance ?? UNSCORED_RELEVANCE) >= MIN_RELEVANCE || h.score >= CLOSE_ENOUGH)
      .map((h) => ({ ...h, score: h.score * (0.55 + 0.45 * (h.fact.relevance ?? UNSCORED_RELEVANCE)) * pathAffinity(h.fact.path ?? '.', files) }))
      .sort((a, b) => b.score - a.score),
  ).slice(0, n);
}

/**
 * Past misses worth giving an agent, best first: never a non-miss (isNonMiss), never below MISS_FLOOR, weighted by
 * where the paths they mention sit against the named files (pathAffinity), and none far below the best.
 */
export function rankMisses<T extends { missed: string; feedbackText: string; score: number }>(hits: T[], n: number, files: string[] = []): T[] {
  return keepNearBest(
    hits
      .filter((m) => !isNonMiss(m.missed) && m.score >= MISS_FLOOR)
      .map((m) => {
        const paths = mentionedPaths(`${m.missed} ${m.feedbackText}`);
        const w = paths.length ? Math.max(...paths.map((p) => pathAffinity(p, files))) : 1;
        return { ...m, score: m.score * w };
      })
      .sort((a, b) => b.score - a.score),
  ).slice(0, n);
}
