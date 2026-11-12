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
export const MIN_RELEVANCE = 0.3;
const CLOSE_ENOUGH = 0.8;
/** Similarity below which a past miss or a fact is never served, whatever else ranks: a nonsense task gets nothing. */
export const SIMILARITY_FLOOR = 0.78;
/** Field-calibrated weighted fact rank threshold; custom low-scale embedders keep their explicit calibration. */
export const FACT_RANK_FLOOR = 0.80;
/**
 * What a fact is embedded from (and re-embedded from: graph/embeddings.ts and the Postgres one say the same). Its path
 * first, where it names a file; a fact an accepted claim became (origin claim, filed under source:<doc id> when it scopes
 * no file) or a conflict's reconciled statement (conflict:<id>) by its statement alone: those ids are noise a task's
 * words never match, and cost such a fact the similarity it needs to be served.
 */
export const factEmbeddingText = (f: { path: string; statement: string; origin?: string | null }) =>
  f.origin === 'claim' || f.path.startsWith('conflict:') ? f.statement : `${f.path}: ${f.statement}`;
export const boundedScore = (score: number): number => Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
/** A fact or miss scoring under this share of the best one is noise next to it, and is left out. */
const RELATIVE_FLOOR = 0.6;

export type RelevanceBand = 'everyday' | 'sometimes' | 'rare' | 'unscored';

export function relevanceBand(r: number | null): RelevanceBand {
  if (r === null) return 'unscored';
  return r >= EVERYDAY_FROM ? 'everyday' : r >= RARE_BELOW ? 'sometimes' : 'rare';
}

/**
 * Kinds that can be needed in most changes (the rubric's "core conventions, invariants, the data model, auth and
 * security rules, how modules fit together"). One module's API, a config option, a gotcha in one area, a command or a
 * dependency is needed for some changes: at most SOMETIMES_TOP.
 */
const EVERYDAY_KINDS = new Set(['convention', 'invariant', 'architecture', 'data_model', 'security']);
/** Where a fact the calibration takes out of "everyday" lands: the top of "sometimes". */
export const SOMETIMES_TOP = 0.7;
/** The most of a set of scored facts that may be everyday (at least one). Models scored 62% of facts everyday in 0.6.2. */
export const EVERYDAY_SHARE = 0.25;

/**
 * Models score generously (0.6.2: 62% of facts "everyday", which then ranks nothing above anything). Calibrated in code,
 * over one set (a shard's or a file's facts, a scoring batch): a fact of a kind that is about one area
 * (EVERYDAY_KINDS) is at most SOMETIMES_TOP; past EVERYDAY_SHARE of the scored facts, the least relevant everyday ones
 * (project-wide ones win a tie) are set to SOMETIMES_TOP too. Facts under everyday, and unscored ones, are left as
 * they are; calibrating twice changes nothing. Order is kept.
 */
export function calibrateRelevance<T extends { kind: string; path: string; relevance?: number | null }>(facts: T[]): T[] {
  const out = facts.map((f) => (typeof f.relevance === 'number' && f.relevance >= EVERYDAY_FROM && !EVERYDAY_KINDS.has(f.kind) ? { ...f, relevance: SOMETIMES_TOP } : f));
  const scored = out.filter((f) => typeof f.relevance === 'number').length;
  const room = Math.max(1, Math.floor(EVERYDAY_SHARE * scored));
  const everyday = out.map((f, i) => ({ f, i })).filter(({ f }) => typeof f.relevance === 'number' && f.relevance >= EVERYDAY_FROM);
  if (everyday.length <= room) return out;
  const wide = (p: string) => (p === '.' || p === '' ? 1 : 0);
  const keep = new Set(everyday.sort((a, b) => b.f.relevance! - a.f.relevance! || wide(b.f.path) - wide(a.f.path) || a.i - b.i).slice(0, room).map(({ i }) => i));
  return out.map((f, i) => (everyday.some((e) => e.i === i) && !keep.has(i) ? { ...f, relevance: SOMETIMES_TOP } : f));
}

const NON_MISS = /^\s*(?:the agent|it|this|there)\s+(?:did not|didn't|was not|wasn't|is not|isn't)\s+(?:miss\b|a miss\b)|^\s*no miss\b|\bnot a (?:real |genuine )?miss\b/i;

/** A post-mortem that concluded the agent missed nothing ("The agent did not miss the feedback, ..."): never served. */
export function isNonMiss(missed: string): boolean {
  return NON_MISS.test(missed);
}

/** A path with Windows separators written as forward slashes, so "src\routes\a.ts" splits like "src/routes/a.ts". */
export const slashPath = (path: string) => path.replace(/\\/g, '/');

const dirSegs = (path: string) => slashPath(path).replace(/^\.\//, '').split('/').slice(0, -1).filter(Boolean);

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

// Folders that hold services rather than being one: a task saying "src" or "packages" names no service.
const GENERIC_DIRS = new Set([
  'src', 'lib', 'libs', 'app', 'apps', 'packages', 'package', 'pkg', 'services', 'service', 'internal', 'cmd', 'test',
  'tests', 'spec', 'specs', 'docs', 'doc', 'scripts', 'script', 'tools', 'config', 'configs', 'build', 'dist', 'bin',
  'public', 'assets', 'static', 'common', 'shared', 'utils', 'util', 'core', 'components', 'modules', 'vendor', 'main',
  'data', 'types', 'examples', 'example',
]);

/**
 * The folders that could be a service, from repo paths (of files, facts or misses): every first folder and every
 * first-two-folders prefix, with no generic one (src, packages) or short one (ui) as the last part. Sorted, once each.
 */
export function serviceDirs(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const segs = dirSegs(p);
    for (let i = 1; i <= Math.min(2, segs.length); i++) {
      const name = segs[i - 1].toLowerCase();
      if (name.length >= 3 && !GENERIC_DIRS.has(name)) out.add(segs.slice(0, i).join('/'));
    }
  }
  return [...out].sort();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The service folders (from serviceDirs) whose name the task says as a word ("the portal settings" names src/portal). */
export function servicesInTask(task: string, dirs: string[]): string[] {
  return dirs.filter((d) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(slashPath(d).split('/').at(-1)!)}(?![\\p{L}\\p{N}_])`, 'iu').test(task));
}

/**
 * pathAffinity for services a task names in words, not files: a guess, so a milder weight. Above 1 inside one of them,
 * below 1 in another folder, 1 for a project-wide path or with no service named.
 */
function serviceAffinity(path: string, services: string[]): number {
  if (!services.length || path === '.' || !dirSegs(path).length) return 1;
  const p = slashPath(path).replace(/^\.\//, '');
  return services.some((s) => p.startsWith(`${s}/`)) ? 1.15 : 0.85;
}

/** Named files decide where a path sits; without them, the services the task names do. */
const affinity = (path: string, files: string[], services: string[]) => (files.length ? pathAffinity(path, files) : serviceAffinity(path, services));

/** A piece of a base64 run rather than a name: upper, lower and digits mixed with no word shape (kL9mN2pQ, not Button2). */
const randomSegment = (seg: string) => /[A-Z]/.test(seg) && /[a-z]/.test(seg) && /\d/.test(seg) && !/^(?:[A-Z]{0,3}[a-z]+\d*)+$/.test(seg);

/**
 * Repo paths a model's text mentions ("in src/api/orders.ts"): a slash inside, no spaces, no URL. A slashed piece of a
 * key (no extension, a random-looking segment, or a + or = against it) is not a path, and neither is the host part of
 * a URL whose password was redacted (https://admin:[REDACTED]@host/x). A Windows path ("src\api\orders.ts") is found
 * the same way and returned with forward slashes; with a backslash it needs a file extension, so an escape in quoted
 * text ("line\nnext") is not a path.
 */
export function mentionedPaths(text: string): string[] {
  return [...text.matchAll(/(?<![\w:/\\.+=@\]-])((?:\.[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)+)(?![\w@.+=/\\-])/g)].map((m) => m[1])
    .filter((p) => /\.[A-Za-z][\w-]*$/.test(p) || (!p.includes('\\') && !p.split('/').some(randomSegment))).map(slashPath);
}

const keepNearBest = <T extends { score: number }>(xs: T[]) => {
  const best = xs[0]?.score ?? 0;
  return xs.filter((x) => x.score >= best * RELATIVE_FLOOR);
};

/**
 * The facts worth giving an agent, best first: similarity weighted by relevance (an unscored fact counts as middling),
 * so a convention it needs every day beats a slightly closer note on setting up some tool. A rare fact stays out
 * unless the task is very close to it, which is what a setup task looks like. With `files` (the files the task
 * names), facts of their folders and service rank up and other services' down (pathAffinity); without files, the
 * same, more mildly, for `services` (the folders the task names, servicesInTask). Nothing under SIMILARITY_FLOOR,
 * and nothing far below the best, is kept. Similarity stays unchanged; only the sort key is weighted.
 */
export function rankFacts<T extends FactHit>(hits: T[], n: number, files: string[] = [], services: string[] = [], floor = SIMILARITY_FLOOR, minimumRank = 0): (T & { rankingScore: number })[] {
  return keepNearBest(
    hits.filter((h) => boundedScore(h.score) >= floor && ((h.fact.relevance ?? UNSCORED_RELEVANCE) >= MIN_RELEVANCE || h.score >= CLOSE_ENOUGH))
      .map((hit) => ({ hit, score: boundedScore(hit.score) * (0.55 + 0.45 * boundedScore(hit.fact.relevance ?? UNSCORED_RELEVANCE)) * affinity(hit.fact.path ?? '.', files, services) }))
      .filter(({ hit, score }) => score >= minimumRank || files.includes(hit.fact.path))
      .sort((a, b) => b.score - a.score),
  ).slice(0, n).map(({ hit, score }) => ({ ...hit, score: boundedScore(hit.score), rankingScore: boundedScore(score) }));
}

/**
 * How close a past miss must be to the work to be served or judged when it shares no file with it (MISS_MIN_SIMILARITY):
 * the bar a lesson learned elsewhere clears on similarity alone (lessonRank GLOBAL_CLOSE). Two sentences in the same
 * register score well above SIMILARITY_FLOOR with no topic in common: misses of another feature scored 0.80-0.82 for
 * unrelated tasks, and every one the judge was given came back not applicable.
 */
export const MISS_CLOSE = 0.85;

const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
/** A path named in a miss as a folder: its folder is itself; as a file (it has an extension): the folder it is in. */
const folderOf = (p: string) => (/\.[A-Za-z][\w-]*$/.test(p.split('/').pop()!) ? dirOf(p) : p);

/**
 * Whether a miss's paths share a file with the named files: the same file (a miss may name it from a subfolder), or a
 * file in the folder the miss names or names a file in.
 */
export function missTouches(paths: string[], files: string[]): boolean {
  const clean = (p: string) => slashPath(p).replace(/^\.\//, '').replace(/\/+$/, '');
  const fs = files.map(clean);
  return paths.map(clean).some((p) => fs.some((f) => f === p || f.endsWith(`/${p}`) || (!!folderOf(p) && folderOf(p) === dirOf(f))));
}

/**
 * Whether a past miss may be served or judged for work naming `files`: it shares a file with them (missTouches), or it
 * is at least `close` (MISS_CLOSE) similar to the work. A miss that is merely in the same register is neither.
 */
export function missAdmitted(m: { missed: string; feedbackText: string; score: number }, files: string[], close = MISS_CLOSE): boolean {
  return (files.length > 0 && missTouches(mentionedPaths(`${m.missed} ${m.feedbackText}`), files)) || boundedScore(m.score) >= close;
}

/**
 * Past misses worth giving an agent, best first: never a non-miss (isNonMiss), never below SIMILARITY_FLOOR, weighted by
 * where the paths they mention sit against the named files (pathAffinity), and none far below the best. Never one whose
 * lesson you rejected as worked out from the wrong session (rejectedWrongSession): it is evidence of nothing.
 */
export function rankMisses<T extends { missed: string; feedbackText: string; score: number; rejectedWrongSession?: boolean }>(hits: T[], n: number, files: string[] = [], services: string[] = [], floor = SIMILARITY_FLOOR, minimumRank = 0): (T & { rankingScore: number })[] {
  return keepNearBest(
    hits.filter((m) => !m.rejectedWrongSession && !isNonMiss(m.missed) && boundedScore(m.score) >= floor)
      .map((hit) => {
        const paths = mentionedPaths(`${hit.missed} ${hit.feedbackText}`);
        const weight = paths.length ? Math.max(...paths.map((p) => affinity(p, files, services))) : 1;
        return { hit, score: boundedScore(hit.score) * weight };
      }).filter(({ score }) => score >= minimumRank).sort((a, b) => b.score - a.score),
  ).slice(0, n).map(({ hit, score }) => ({ ...hit, score: boundedScore(hit.score), rankingScore: boundedScore(score) }));
}


/** Document chunks use the same raw/weighted gates as misses; explicit file references determine affinity. */
export function rankDocs<T extends { score: number; ref: string; text: string; title: string }>(hits: T[], n: number, files: string[] = [], services: string[] = [], floor = SIMILARITY_FLOOR, minimumRank = 0): (T & { rankingScore: number })[] {
  return keepNearBest(hits.filter(hit => boundedScore(hit.score) >= floor).map(hit => {
    const paths = mentionedPaths(`${hit.ref} ${hit.title} ${hit.text}`);
    const weight = paths.length ? Math.max(...paths.map(path => affinity(path, files, services))) : 1;
    return { hit, score: boundedScore(boundedScore(hit.score) * weight) };
  }).filter(({ score }) => score >= minimumRank).sort((a, b) => b.score - a.score))
    .slice(0, n).map(({ hit, score }) => ({ ...hit, score: boundedScore(hit.score), rankingScore: score }));
}
