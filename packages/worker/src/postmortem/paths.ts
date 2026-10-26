import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cleanLessonPath, pathMatches } from '@fb/core';
import { GIT_SAFE } from '../ingest/git.ts';

const run = promisify(execFile);

/**
 * Whether the repository on disk (the worker's read-only mount) has this repo-relative file or folder. No repository
 * path known: true, so nothing is dropped for want of a place to look. Paths that leave the repo never get here
 * (junkPathReason).
 */
export async function repoHas(repoPath: string | null | undefined, path: string): Promise<boolean> {
  if (!repoPath) return true;
  if (!cleanLessonPath(path)) return false;
  if (await lstat(join(repoPath, path)).catch(() => null)) return true;
  // The repository itself is not here (not mounted, or a path from another machine): nothing to check against.
  return !(await lstat(repoPath).catch(() => null));
}

/**
 * The paths a proposed lesson may carry, checked against the evidence instead of trusted from the model or inherited
 * from a session: a lesson fires when an agent edits one of its paths, so a wrong path serves it to the wrong edit
 * (an instruction file, another feature's folder) or to none.
 */

/** Edits of the session: before the feedback, and after it (the fix). */
export type Touched = { edited: string[]; fixed: string[] };

const INSTRUCTION_FILE = /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$|(^|\/)\.cursorrules$|(^|\/)\.github\/copilot-instructions\.md$/i;
/** "#13513", "acme/shop#12", "pull/13859/head", "refs/pull/7/merge", "PR-812": a pull request, not a file. */
const PR_REF = /#\d+\b|(^|\/)pulls?\/\d+(\/|$)|^(PR|MR)[-_ ]?\d+$/i;
const GLOB = /[*?[\]{}]/;

/** Why a path cannot be a lesson's path, or null when it can be (it may still not exist). */
export function junkPathReason(raw: string): string | null {
  const p = raw.trim();
  if (!p || p.startsWith('~') || p.startsWith('/') || p.includes('://') || p.includes(':') || !cleanLessonPath(p)) return 'not a repository path';
  if (PR_REF.test(p)) return 'a pull request reference, not a path';
  if (INSTRUCTION_FILE.test(p)) return 'an instruction file, not the code the lesson is about';
  if (/\s/.test(p) || p.includes('***') || p.includes('//') || unbalanced(p, '{', '}') || unbalanced(p, '[', ']')) return 'a malformed path or glob';
  // A function or variable name: no folder, no extension, no glob. (Makefile, Dockerfile and the like start upper case.)
  if (!p.includes('/') && !p.includes('.') && !GLOB.test(p) && !/^[A-Z][a-z]+file$|^[A-Z]+$/.test(p)) return 'a bare identifier, not a path';
  return null;
}

function unbalanced(s: string, open: string, close: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === open) depth++;
    else if (c === close && --depth < 0) return true;
  }
  return depth !== 0;
}

export type PathEvidence = {
  /** The file a review comment is on. */
  commentPath?: string | null;
  /** What the comment says, its diff lines and the PR or ticket description: a path named there is evidence. */
  named: string;
  /** The work session's edits (none for a comment with no session). */
  touched: Touched;
  /** Whether the repository has this file, or (for a folder) anything under it. Unset: not checked. */
  exists?: (path: string) => Promise<boolean>;
  /** Feedback in a transcript: the model read the repository the session ran in, so paths it found there may stand. */
  transcript?: boolean;
  /** A global lesson: about no repository's files, so only the shape is checked. */
  global?: boolean;
  /** The repository's files (repoFileList); unset or null: bare names resolve only against the evidence. */
  repoFiles?: () => Promise<string[] | null>;
};

export type Dropped = { path: string; why: string };
/** A bare file name (or partial path) the repository has more than once: kept as it is, and the owner told where. */
export type Ambiguous = { path: string; matches: string[] };
export const ambiguousFlag = (a: Ambiguous) => ({ name: 'ambiguous-path' as const, why: `${a.path} is in more than one place (${a.matches.join(', ')}): say which` });


const MAX_EXACT_PATHS = 3;

/**
 * The lesson's paths: each model path must be a repository path (not an instruction file, a PR reference or a bare
 * identifier), resolve to a file the evidence knows when it is only a file name, and exist in the repository. Then it
 * must be backed by the evidence: for a review comment the commented file is always in the set; for another comment
 * only paths the comment, its diff, the description or the session's edits name; for a transcript also paths the
 * repository has. When none survive, a transcript falls back to the files edited to fix the miss; a comment never
 * falls back to a session's edits. Empty: the owner sees that the lesson needs a path.
 */
export async function validateLessonPaths(modelPaths: string[], ev: PathEvidence): Promise<{ paths: string[]; dropped: Dropped[]; ambiguous: Ambiguous[] }> {
  const dropped: Dropped[] = [];
  const ambiguous: Ambiguous[] = [];
  const known = [...new Set([...(ev.commentPath ? [ev.commentPath] : []), ...ev.touched.fixed, ...ev.touched.edited])];
  const verified = new Set<string>();
  const valid: string[] = [];
  const listing = ev.global ? null : await listOnce(ev.repoFiles);
  for (const raw of modelPaths) {
    const why = junkPathReason(raw);
    if (why) {
      dropped.push({ path: raw, why });
      continue;
    }
    let p = cleanLessonPath(raw)!.replace(/\/+$/, '');
    if (!GLOB.test(p) && !known.includes(p)) {
      const bare = !p.includes('/');
      const hits = known.filter((f) => endsAs(f, p));
      if (hits.length === 1) p = hits[0];
      else if (listing) {
        const found = resolveIn(p, listing);
        if (found.drop) {
          dropped.push({ path: raw, why: found.drop });
          continue;
        }
        if (found.ambiguous) ambiguous.push({ path: p, matches: found.ambiguous });
        p = found.path;
      } else if (bare && /\.\w+$/.test(p) && !(ev.exists && (await ev.exists(p)))) {
        dropped.push({ path: raw, why: 'a bare file name that matches no file the comment or the session names' });
        continue;
      }
    }
    if (listing && GLOB.test(p) && !listing.some((f) => pathMatches(p, f))) {
      dropped.push({ path: raw, why: NO_GLOB_MATCH });
      continue;
    }
    // Ambiguous: the repository has it, in more than one place; it stays as the model wrote it.
    if (ambiguous.some((a) => a.path === p)) {
      if (!valid.includes(p)) valid.push(p);
      verified.add(p);
      continue;
    }
    if (ev.exists && !ev.global) {
      const probe = GLOB.test(p) ? p.split('/').filter((s, i, all) => !all.slice(0, i + 1).some((x) => GLOB.test(x))).join('/') : p;
      if (probe) {
        if (!(await ev.exists(probe).catch(() => true))) {
          dropped.push({ path: raw, why: 'no such file in the repository' });
          continue;
        }
        verified.add(p);
      }
    }
    if (!valid.includes(p)) valid.push(p);
  }
  if (ev.global) return { paths: valid, dropped, ambiguous };

  const evidenced = (p: string) => ev.named.includes(p) || [...ev.touched.fixed, ...ev.touched.edited].some((f) => pathMatches(p, f));
  // A transcript with nothing to check against (no repository lookup, no edits recorded): the model's clean paths stand.
  const unchecked = !!ev.transcript && !ev.exists && !ev.touched.fixed.length && !ev.touched.edited.length;
  const keep = (p: string) => (ev.commentPath && pathMatches(p, ev.commentPath)) || evidenced(p) || (!!ev.transcript && verified.has(p)) || unchecked;
  const paths = valid.filter((p) => {
    if (keep(p)) return true;
    dropped.push({ path: p, why: 'nothing in the comment or the work names it' });
    return false;
  });
  if (ev.commentPath && !paths.some((p) => pathMatches(p, ev.commentPath!)) && !junkPathReason(ev.commentPath)) paths.unshift(ev.commentPath);
  const kept = ambiguous.filter((a) => paths.includes(a.path));
  if (paths.length || !ev.transcript || !ev.touched.fixed.length) return { paths, dropped, ambiguous: kept };
  return { paths: fixedPaths(ev.touched.fixed), dropped, ambiguous: [] };
}

const NO_GLOB_MATCH = 'a glob that matches no file in the repository';
const NO_SUCH_FILE = 'no such file in the repository';
const MAX_LISTED = 5;

/** The file `f` is `p`, or ends in it: a bare name by its last segment, a partial path by its trailing segments. */
const endsAs = (f: string, p: string) => f === p || f.endsWith(`/${p}`);

/** A bare name or partial path against the repository's files: the one match, kept (ambiguous) or dropped. */
function resolveIn(p: string, files: string[]): { path: string; drop?: string; ambiguous?: string[] } {
  if (files.includes(p) || files.some((f) => f.startsWith(`${p}/`))) return { path: p };
  const hits = files.filter((f) => endsAs(f, p));
  if (hits.length === 1) return { path: hits[0] };
  if (hits.length > 1) return { path: p, ambiguous: hits.sort().slice(0, MAX_LISTED) };
  return { path: p, drop: NO_SUCH_FILE };
}

const listOnce = async (repoFiles: PathEvidence['repoFiles']) => (repoFiles ? await repoFiles().catch(() => null) : null);

/** What normalizeStoredPaths did to a stored lesson's paths. */
export type Normalized = { paths: string[]; dropped: Dropped[]; ambiguous: Ambiguous[]; resolved: { from: string; to: string }[] };

/**
 * A stored lesson's paths by today's rule, with no evidence to weigh (the comment and the session are not stored with
 * it): what cannot be a path (an instruction file, a PR reference, a bare identifier) goes; a bare name or partial path
 * resolves to its one repository match (several: kept, and said); a file the repository does not have and a glob that
 * matches nothing go. Without a repository to look in only the shape is checked.
 */
export async function normalizeStoredPaths(stored: string[], o: { exists?: (path: string) => Promise<boolean>; repoFiles?: () => Promise<string[] | null> }): Promise<Normalized> {
  const out: Normalized = { paths: [], dropped: [], ambiguous: [], resolved: [] };
  const listing = await listOnce(o.repoFiles);
  for (const raw of stored) {
    const why = junkPathReason(raw);
    if (why) {
      out.dropped.push({ path: raw, why });
      continue;
    }
    let p = cleanLessonPath(raw)!.replace(/\/+$/, '');
    if (GLOB.test(p)) {
      if (listing && !listing.some((f) => pathMatches(p, f))) {
        out.dropped.push({ path: raw, why: NO_GLOB_MATCH });
        continue;
      }
    } else if (listing) {
      const found = resolveIn(p, listing);
      if (found.drop) {
        out.dropped.push({ path: raw, why: found.drop });
        continue;
      }
      if (found.ambiguous) out.ambiguous.push({ path: p, matches: found.ambiguous });
      if (found.path !== p) out.resolved.push({ from: raw, to: found.path });
      p = found.path;
    } else if (o.exists && p.includes('/') && !(await o.exists(p).catch(() => true))) {
      out.dropped.push({ path: raw, why: NO_SUCH_FILE });
      continue;
    }
    if (!out.paths.includes(p)) out.paths.push(p);
  }
  return out;
}

/** How long a repository's listing is reused: a re-check or a batch of post-mortems lists each repository once. */
const LISTING_TTL_MS = 5 * 60_000;
const MAX_LISTING = 200_000;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage', 'vendor', '.venv', '__pycache__', 'target', '.turbo', '.cache']);
const listings = new Map<string, { at: number; files: Promise<string[] | null> }>();

/**
 * The repository's files, repo-relative: what git tracks and the untracked files it does not ignore, else a walk of
 * the folder. Null when no repository is known or it is not here. Kept for LISTING_TTL_MS.
 */
export function repoFileList(repoPath: string | null | undefined): Promise<string[] | null> {
  if (!repoPath) return Promise.resolve(null);
  const hit = listings.get(repoPath);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.files;
  const files = listFiles(repoPath);
  listings.set(repoPath, { at: Date.now(), files });
  return files;
}

async function listFiles(repoPath: string): Promise<string[] | null> {
  if (!(await lstat(repoPath).catch(() => null))) return null;
  try {
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    const files = stdout.split('\0').filter(Boolean);
    if (files.length) return files.slice(0, MAX_LISTING);
  } catch {
    // Not a git repository (or git is not here): walk it.
  }
  return walk(repoPath, '', []);
}

async function walk(root: string, rel: string, out: string[]): Promise<string[]> {
  for (const e of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    if (out.length >= MAX_LISTING) break;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, p, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The files edited to fix the miss: themselves when there are a few, else their common folder (or nothing). */
function fixedPaths(fixed: string[]): string[] {
  const base = [...new Set(fixed)].sort();
  if (base.length <= MAX_EXACT_PATHS) return base;
  const dirs = base.map((f) => f.split('/').slice(0, -1));
  const common: string[] = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
  return common.length ? [`${common.join('/')}/**`] : [];
}
