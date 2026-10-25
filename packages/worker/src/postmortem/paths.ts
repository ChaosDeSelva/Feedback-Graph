import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanLessonPath, pathMatches } from '@fb/core';

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
const PR_REF = /#\d+\b/;
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
};

export type Dropped = { path: string; why: string };

const MAX_EXACT_PATHS = 3;

/**
 * The lesson's paths: each model path must be a repository path (not an instruction file, a PR reference or a bare
 * identifier), resolve to a file the evidence knows when it is only a file name, and exist in the repository. Then it
 * must be backed by the evidence: for a review comment the commented file is always in the set; for another comment
 * only paths the comment, its diff, the description or the session's edits name; for a transcript also paths the
 * repository has. When none survive, a transcript falls back to the files edited to fix the miss; a comment never
 * falls back to a session's edits. Empty: the owner sees that the lesson needs a path.
 */
export async function validateLessonPaths(modelPaths: string[], ev: PathEvidence): Promise<{ paths: string[]; dropped: Dropped[] }> {
  const dropped: Dropped[] = [];
  const known = [...new Set([...(ev.commentPath ? [ev.commentPath] : []), ...ev.touched.fixed, ...ev.touched.edited])];
  const verified = new Set<string>();
  const valid: string[] = [];
  for (const raw of modelPaths) {
    const why = junkPathReason(raw);
    if (why) {
      dropped.push({ path: raw, why });
      continue;
    }
    let p = cleanLessonPath(raw)!.replace(/\/+$/, '');
    if (!GLOB.test(p) && !known.includes(p)) {
      const bare = !p.includes('/');
      const hits = known.filter((f) => (bare ? f.split('/').pop() === p : f.endsWith(`/${p}`)));
      if (hits.length === 1) p = hits[0];
      else if (bare && /\.\w+$/.test(p) && !(ev.exists && (await ev.exists(p)))) {
        dropped.push({ path: raw, why: 'a bare file name that matches no file the comment or the session names' });
        continue;
      }
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
  if (ev.global) return { paths: valid, dropped };

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
  if (paths.length || !ev.transcript || !ev.touched.fixed.length) return { paths, dropped };
  return { paths: fixedPaths(ev.touched.fixed), dropped };
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
