import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { GIT_SAFE } from '../ingest/git.ts';

const run = promisify(execFile);

/**
 * Which files a scan reads first. Path order left the files where traps are written down for last: a file whose long
 * comment explained the very bug an agent then hit was never scanned. So, best first: files an agent asked for (it
 * named them and found no facts), files sessions edited, then hotspots: recent churn, files PR discussions are about,
 * and files with long explanatory comments. Ties keep the ranked order (rank.ts).
 */
export type ScanSignals = {
  /** Paths an agent asked for (FactsStore.scanRequests), oldest request first. */
  requested?: string[];
  /** Paths sessions edited, most recent first. */
  touched?: string[];
  /** Commits that touched each path recently (gitChurn). */
  churn?: Map<string, number>;
  /** Paths review comments or PR discussions are about. */
  prPaths?: Set<string>;
  /** Long explanatory comment lines per path (longCommentLines). */
  comments?: Map<string, number>;
};

/** Days of history gitChurn reads, and the most commits it walks. */
const CHURN_DAYS = 90;
const CHURN_COMMITS = 2000;
/** Commits, and long comment lines, at which a file counts as fully hot on that signal. */
const HOT_CHURN = 10;
const HOT_COMMENTS = 12;

/** Commits in the last CHURN_DAYS that touched each path (repo-relative); empty when the folder is not a git repo. */
export async function gitChurn(repoPath: string, o: { days?: number } = {}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'log', `--since=${o.days ?? CHURN_DAYS}.days`, '-n', String(CHURN_COMMITS), '--no-renames', '--name-only', '--format='], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    for (const p of stdout.split('\n')) if (p.trim()) out.set(p.trim(), (out.get(p.trim()) ?? 0) + 1);
  } catch {
    // not a repo, no commits, or git missing: no churn signal
  }
  return out;
}

/** Comment syntax per extension: the markers a whole-line comment starts with. */
const SLASH = ['//', '/*', '*'];
const HASH = ['#'];
const COMMENT_MARKERS: Record<string, string[]> = {
  '.ts': SLASH, '.tsx': SLASH, '.js': SLASH, '.jsx': SLASH, '.mjs': SLASH, '.cjs': SLASH, '.go': SLASH, '.rs': SLASH, '.java': SLASH, '.kt': SLASH,
  '.swift': SLASH, '.cs': SLASH, '.cpp': SLASH, '.c': SLASH, '.h': SLASH, '.php': SLASH, '.scss': SLASH, '.css': ['/*', '*'], '.proto': SLASH,
  '.py': HASH, '.rb': HASH, '.sh': HASH, '.yaml': HASH, '.yml': HASH, '.toml': HASH, '.tf': HASH, '.gd': HASH, '.graphql': HASH,
  '.sql': ['--'], '.lua': ['--'],
};
/** A comment line with at least this many words explains something; shorter ones label code. */
const EXPLAINS_WORDS = 8;

/**
 * Whole-line comments of at least EXPLAINS_WORDS words in a source file: where conventions and traps are written down.
 * 0 for docs and data (markdown headings are not comments).
 */
export function longCommentLines(path: string, content: string): number {
  const markers = COMMENT_MARKERS[extname(path).toLowerCase()];
  if (!markers) return 0;
  let n = 0;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const marker = markers.find((m) => line.startsWith(m));
    if (!marker || line.startsWith('#!') || line.startsWith('*/')) continue;
    const words = line.slice(marker.length).replace(/^[/*#\s-]+/, '').split(/\s+/).filter(Boolean);
    if (words.length >= EXPLAINS_WORDS) n++;
  }
  return n;
}

/** 0 (nothing marks it) to 7: churn up to 3, a PR discussion 2, long comments up to 2. */
export function hotScore(path: string, s: ScanSignals): number {
  const churn = Math.min(1, (s.churn?.get(path) ?? 0) / HOT_CHURN) * 3;
  const pr = s.prPaths?.has(path) ? 2 : 0;
  const comments = Math.min(1, (s.comments?.get(path) ?? 0) / HOT_COMMENTS) * 2;
  return churn + pr + comments;
}

/** `files` best first for a scan (see ScanSignals); stable, so files no signal marks keep their order. */
export function scanOrder<T extends { path: string }>(files: T[], s: ScanSignals): T[] {
  const at = new Map<string, number>();
  for (const [i, p] of (s.requested ?? []).entries()) if (!at.has(p)) at.set(p, i);
  const touchedFrom = at.size;
  for (const [i, p] of (s.touched ?? []).entries()) if (!at.has(p)) at.set(p, touchedFrom + i);
  const tier = (p: string) => (s.requested?.includes(p) ? 0 : at.has(p) ? 1 : 2);
  return files
    .map((f, i) => ({ f, i, tier: tier(f.path), pos: at.get(f.path) ?? 0, hot: hotScore(f.path, s) }))
    .sort((a, b) => a.tier - b.tier || a.pos - b.pos || b.hot - a.hot || a.i - b.i)
    .map((x) => x.f);
}
