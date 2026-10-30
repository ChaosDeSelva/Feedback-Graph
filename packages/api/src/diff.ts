import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { GIT_SAFE, isSecretPath, redactSecrets, tokenFingerprint } from '@fb/core';

/**
 * The diff check_before_done puts to its judge: split into files and hunks, cut to a budget with a note naming what
 * was not shown, and the place in it (file, hunk, line) that a quoted line of evidence comes from.
 */

export type DiffHunk = { header: string; lines: string[] };
export type FileDiff = { path: string; text: string; hunks: DiffHunk[] };
/** Where a verdict's evidence is in the diff: the file, its hunk header, and the diff line as it is there. */
export type DiffCite = { path: string; hunk: string; line: string };

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/** A unified diff (git diff, git log -p) as files and their hunks. Text before the first file is ignored. */
export function splitDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  const lines = text.split('\n');
  // The last line's newline ends it; it starts no empty line.
  if (text.endsWith('\n')) lines.pop();
  for (const [i, l] of lines.entries()) {
    const git = GIT_HEADER.exec(l);
    // A bare diff (no git header) starts a file at its --- line, named by the +++ line after it.
    const bare = !git && l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && (!cur || hunk);
    if (git || bare) {
      cur = { path: git ? git[2] : pathOf(lines[i + 1]), text: '', hunks: [] };
      hunk = null;
      out.push(cur);
    }
    if (!cur) continue;
    cur.text += `${l}\n`;
    if (l.startsWith('+++ ') && !hunk) {
      const p = pathOf(l);
      if (p !== '/dev/null') cur.path = p;
    } else if (l.startsWith('@@')) {
      hunk = { header: l, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk && /^[ +\\-]/.test(l)) hunk.lines.push(l);
  }
  // The split adds a newline the input may not have ended with.
  if (out.length && !text.endsWith('\n')) out[out.length - 1].text = out[out.length - 1].text.slice(0, -1);
  return out;
}

const pathOf = (l: string) => l.slice(4).trim().replace(/^[ab]\//, '');

export type CappedDiff = {
  text: string;
  /** Files shown whole or in part, in order. */
  shown: string[];
  /** Files not shown (a file shown only in part is listed with " (partly)"). */
  omitted: string[];
  /** Secret files (isSecretPath) left out whatever the budget. */
  secret: string[];
  /** What the judge was not shown, in one line; null when it was shown everything. */
  note: string | null;
};

/** Which files a capped diff keeps first: those `related` to what is judged, then `changed` (files_changed) in its order. */
export type DiffPreference = { related?: (path: string) => boolean; changed?: string[] };

/**
 * The diff cut to `maxChars`: secret files dropped, whole files kept in order while they fit (a later, smaller one
 * still gets in), the first file that is too big for an empty budget kept hunk by hunk. When it does not all fit, the
 * order is `prefer`'s (related files, then files_changed, then the rest as the diff has them), so a cut drops the least
 * related. Secrets
 * are redacted. The note says how big the cut was and names every file not shown, so a cap never reads as the whole
 * change.
 */
export function capDiff(raw: string, maxChars: number, prefer: DiffPreference = {}): CappedDiff {
  const files = splitDiff(raw);
  if (!files.length) {
    const text = redactSecrets(raw);
    const cut = text.length > maxChars;
    return { text: text.slice(0, maxChars), shown: [], omitted: [], secret: [], note: cut ? `diff cut at ${kb(maxChars)} KB` : null };
  }
  const secret = files.filter((f) => isSecretPath(f.path)).map((f) => f.path);
  let text = '';
  const shown: string[] = [];
  const omitted: string[] = [];
  const changed = new Map((prefer.changed ?? []).map((p, i) => [p, i]));
  const rank = (f: FileDiff) => (prefer.related?.(f.path) ? -1 : changed.get(f.path) ?? changed.size);
  const open = files.filter((x) => !isSecretPath(x.path));
  // Reordered only when something has to go (a stable sort: within a rank, the diff's own order); whole, it stays as is.
  const whole = open.reduce((n, f) => n + redactSecrets(f.text).length, 0) <= maxChars;
  const ordered = whole ? open : open.map((f) => ({ f, r: rank(f) })).sort((x, y) => x.r - y.r).map((x) => x.f);
  for (const f of ordered) {
    const body = redactSecrets(f.text);
    if (text.length + body.length <= maxChars) {
      text += body;
      shown.push(f.path);
      continue;
    }
    if (!text) {
      const part = partOf(f, maxChars);
      if (part) {
        text = part;
        shown.push(f.path);
        omitted.push(`${f.path} (partly)`);
        continue;
      }
    }
    omitted.push(f.path);
  }
  // How much of it was shown, so a cut never reads as the whole change ("30.5 of 47.0 KB shown").
  const total = open.reduce((n, f) => n + redactSecrets(f.text).length, 0);
  const notes = [omitted.length ? `diff cut to fit (${kb(text.length)} of ${kb(total)} KB shown), files not shown: ${omitted.join(', ')}` : '', secret.length ? `secret files left out: ${secret.join(', ')}` : ''].filter(Boolean);
  return { text, shown, omitted, secret, note: notes.length ? notes.join('; ') : null };
}

const kb = (chars: number) => (chars / 1024).toFixed(1);

/** A file's header and as many of its hunks as fit; '' when not even the first does. */
function partOf(f: FileDiff, maxChars: number): string {
  const head = redactSecrets(f.text.slice(0, f.text.indexOf('\n@@') + 1));
  let text = head;
  for (const h of f.hunks) {
    const body = redactSecrets(`${[h.header, ...h.lines].join('\n')}\n`);
    if (text.length + body.length > maxChars) break;
    text += body;
  }
  return text === head ? '' : text;
}

// A quote shorter than this ("}", "return") would be found in any diff and proves nothing.
const MIN_QUOTE = 6;
const norm = (s: string) => s.replace(/^[+\- ]/, '').trim().replace(/\s+/g, ' ');

/**
 * The code a judge quoted in prose (its `why`): `backticked`, single-quoted and "double-quoted" spans, longest first. A model that
 * leaves out the evidence field often names the line there; citeDiff decides whether it is in the diff.
 */
export function quotedCode(text: string): string[] {
  const spans = [...text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|\u201c([^\u201d\n]+)\u201d|(?<![\w])'([^'\n]+)'(?![\w])/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]).trim());
  return [...new Set(spans.filter((x) => x.length >= 3 && /[a-zA-Z0-9_$]/.test(x)))].sort((a, b) => b.length - a.length);
}

/**
 * Where a line the judge quoted as evidence is in the diff: the first diff line (code, with or without its +/- mark,
 * whole or in part) it matches. Only added and removed lines count. A multi-line quote needs every non-empty line found. File headers
 * (---, +++, diff --git, index) are not evidence about the code. Null: the quote is not in the diff.
 */
export function citeDiff(files: FileDiff[], quote: string): DiffCite | null {
  const wanted = quote.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!wanted.length) return null;
  let first: DiffCite | null = null;
  for (const w of wanted) {
    const hit = findLine(files, w);
    if (!hit) return null;
    first ??= hit;
  }
  return first;
}

function findLine(files: FileDiff[], quote: string): DiffCite | null {
  if (/^(\+\+\+|---|diff --git|index) /.test(quote)) return null;
  if (quote.startsWith('@@')) return null;
  const q = norm(quote);
  if (!q || !/[a-zA-Z0-9_$]/.test(q)) return null;
  const literal = /^(?:'[^'\n]{3,}'|"[^"\n]{3,}")$/.test(q);
  const call = /^[$A-Za-z_][\w.$]*\s*\([^\n]*\)$/.test(q);
  const tokenLiteral = /^[a-zA-Z0-9_]{3,}$/.test(q) ? new RegExp(`["']${q}["']`) : null;
  // A quote with its +/- mark is that side of the change first: a removed line can read the same as an added one.
  const mark = /^[+-]/.test(quote) ? quote[0] : null;
  for (const want of mark ? [(l: string) => l[0] === mark] : [() => true]) {
    for (const f of files) {
      for (const h of f.hunks) {
        const line = h.lines.find((l) => /^[+-]/.test(l) && want(l) && norm(l).includes(q) && (q.length >= MIN_QUOTE || literal || call || tokenLiteral?.test(norm(l)) || norm(l) === q));
        if (line) return { path: f.path, hunk: h.header, line };
      }
    }
  }
  return null;
}

// ── Reading the diff from the project's folder (mounted read-only) ──

const run = promisify(execFile);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_FILE = 200_000;
// Commits newer than this, on the named files, count as this session's work already committed.
const RECENT_COMMITS = '24.hours';

/**
 * The repo is not ours: its attributes (.gitattributes, .git/info/attributes) can name filter, textconv and external
 * diff commands its config defines, and any git command that reads the working tree (diff, status) runs the clean
 * filter. So git here only reads committed objects (cat-file, log -p with no textconv or external diff), never the
 * working tree; the working-tree side is read under the snippet rules and the two are diffed with `git diff
 * --no-index` in an empty folder outside any repo, with no system or global config and no attributes file.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
// GIT_SAFE brings back the container's safe.directory (the system config is skipped) and switches off diff.external.
const NEUTRAL = ['--no-optional-locks', ...GIT_SAFE];
const FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

export type RepoDiffOpts = { gitArgs?: string[]; associatedPulls?: (sha: string) => Promise<number[]> };

/**
 * The change to the named files in `repoPath`, read-only: each file as it is now against HEAD (staged and unstaged in
 * one; new and deleted files too) and, for a named file unchanged since HEAD, its commits from the last day (work
 * committed before the check). Secret paths and paths that leave the repo are never read; secrets in what is read are
 * redacted; no command the repo configures runs (see GIT_ENV). Null: not a git repo, nothing named, or nothing changed.
 */
export async function readRepoDiff(repoPath: string, paths: string[], o: RepoDiffOpts = {}): Promise<{ text: string; files: string[] } | null> {
  const named = [...new Set(paths.filter(safeRel))];
  if (!named.length) return null;
  const git = (args: string[], cwd?: string) =>
    run('git', [...NEUTRAL, ...(cwd ? [] : ['-C', repoPath, ...(o.gitArgs ?? [])]), ...args], {
      timeout: 20_000,
      maxBuffer: MAX_GIT_OUTPUT,
      // Outside the repo (the no-index diff), git must not find a repo above the scratch folder and read its config.
      env: cwd ? { ...GIT_ENV, GIT_CEILING_DIRECTORIES: dirname(cwd) } : GIT_ENV,
      ...(cwd && { cwd }),
    }).then((r) => r.stdout);
  try {
    await git(['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    return null;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'fg-diff-'));
  try {
    const parts: string[] = [];
    const unchanged: string[] = [];
    for (const p of named) {
      const [before, now] = await Promise.all([git(['cat-file', 'blob', `HEAD:${p}`]).catch(() => null), readWorkingFile(repoPath, p)]);
      if (before === null && now === null) continue;
      if (before !== null && now !== null && before === now) {
        unchanged.push(p);
        continue;
      }
      if (before === null && (await git(['check-ignore', '-q', '--no-index', '--', p]).then(() => true, () => false))) continue;
      if ((before?.length ?? 0) > MAX_FILE || (now?.length ?? 0) > MAX_FILE || isBinary(before) || isBinary(now)) {
        parts.push(`diff --git a/${p} b/${p}\n(binary or over ${MAX_FILE / 1000} KB: not shown)\n`);
        continue;
      }
      if (before === null) parts.push(wholeFile(p, now!, '+'));
      else if (now === null) parts.push(wholeFile(p, before, '-'));
      else parts.push(await noIndexDiff(p, before, now, scratch, git));
    }
    if (unchanged.length) {
      parts.push(await git(['log', '-p', ...FLAGS, `--since=${RECENT_COMMITS}`, '-n', '20', '--format=', '--', ...unchanged]).catch(() => ''));
    }
    const text = redactSecrets(parts.filter((x) => x.trim()).join(''));
    if (!text.trim()) return null;
    return { text, files: [...new Set(splitDiff(text).map((f) => f.path))] };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const isBinary = (s: string | null) => s !== null && s.includes('\0');

/** A new file (+) or a deleted one (-) as a diff, every line on that side. */
function wholeFile(p: string, body: string, side: '+' | '-'): string {
  const lines = body.endsWith('\n') ? body.slice(0, -1).split('\n') : body.split('\n');
  const head = side === '+' ? `new file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@` : `deleted file mode 100644\n--- a/${p}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@`;
  return `diff --git a/${p} b/${p}\n${head}\n${lines.map((l) => `${side}${l}`).join('\n')}\n`;
}

/** HEAD's and the working tree's text of `p`, diffed by git outside the repo (a/<p> against b/<p>, so the header names p). */
async function noIndexDiff(p: string, before: string, now: string, scratch: string, git: (args: string[], cwd?: string) => Promise<string>): Promise<string> {
  for (const [side, body] of [['a', before], ['b', now]] as const) {
    await mkdir(dirname(join(scratch, side, p)), { recursive: true });
    await writeFile(join(scratch, side, p), body);
  }
  // Exit code 1 means "they differ": the diff is on stdout either way.
  return git(['diff', '--no-index', ...FLAGS, '--no-prefix', '--', `a/${p}`, `b/${p}`], scratch).catch((e: { code?: number; stdout?: string }) => (e.code === 1 ? (e.stdout ?? '') : ''));
}

/** A repo-relative path that stays in the repo and is not a secret. */
const safeRel = (p: string) => !!p && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '' || s === '.git') && !isSecretPath(p);

/** A working-tree file's text, under the snippet rules (the resolved file inside the repo, not a secret, a file); else null. */
async function readWorkingFile(repoPath: string, rel: string): Promise<string | null> {
  const root = await realpath(repoPath).catch(() => null);
  const abs = root && (await realpath(join(root, rel)).catch(() => null));
  if (!root || !abs || !abs.startsWith(`${root}/`) || isSecretPath(abs.slice(root.length + 1))) return null;
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile()) return null;
  // Too big to diff: a NUL makes it read as binary, so it is named as not shown.
  if (st.size > MAX_FILE) return '\0';
  const buf = await readFile(abs).catch(() => null);
  return buf ? buf.toString('utf8') : null;
}

/** PR identities explicitly named by the task, independent of the repository's current HEAD. */
export function taskPrNumbers(task: string): number[] {
  return [...new Set([...task.matchAll(/(?:github\.com\/[^\s/]+\/[^\s/]+\/pull\/|\b(?:PR|pull request)(?:\s*#|\s+)|#)(\d+)\b/gi)]
    .map(m => Number(m[1])).filter(n => Number.isSafeInteger(n) && n > 0))];
}

/** PR numbers associated with the task or commit being worked on (merge and squash commit subjects). */
export async function readRepoPrNumbers(repoPath: string, task: string, o: RepoDiffOpts = {}): Promise<number[]> {
  const named = [...task.matchAll(/\b[0-9a-f]{7,40}\b/gi)].slice(0, 5).map((m) => m[0]);
  const explicit = taskPrNumbers(task);
  if (explicit.length && !named.length) return explicit;
  if (!named.length) return explicit;
  const revisions = named;
  const messages = await Promise.all(revisions.map((rev) => run('git', [...NEUTRAL, '-C', repoPath, ...(o.gitArgs ?? []), 'log', '-1', '--format=%H%n%B', rev, '--'], {
    timeout: 2000, maxBuffer: 64_000, env: GIT_ENV,
  }).then((r) => r.stdout).catch(() => '')));
  const numbers = messages.flatMap((m) => [...m.matchAll(/(?:Merge pull request #|\(#)(\d+)/gi)].map((x) => Number(x[1])));
  const associated = o.associatedPulls ? await Promise.all(messages.map((message) => {
    const sha = message.split('\n')[0];
    return /^[0-9a-f]{40,64}$/i.test(sha) ? o.associatedPulls!(sha).catch(() => []) : Promise.resolve([]);
  })) : [];
  return [...new Set([...explicit, ...numbers, ...associated.flat()])];
}

/** GitHub's commit association covers rebase/ordinary commits with no PR number in their subject. */
export function githubCommitPrLookup(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { until: number; value: Promise<number[]> }>();
  return async (repo: string, sha: string, token: string): Promise<number[]> => {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || !/^[0-9a-f]{40,64}$/i.test(sha)) return [];
    const key = `${tokenFingerprint(token)}:${repo.toLowerCase()}:${sha.toLowerCase()}`;
    const known = cache.get(key);
    if (known && known.until > now()) return known.value;
    const value = (async () => {
      const numbers: number[] = [];
      // GitHub lists at most 100 associations per page. Bound time and pages for an interactive context call.
      const signal = AbortSignal.timeout(3000);
      for (let page = 1; page <= 3; page++) {
        const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${sha}/pulls?per_page=100&page=${page}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
          signal, redirect: 'error',
        });
        if (!res.ok) throw new Error('GitHub commit association unavailable');
        const data: unknown = await res.json();
        if (!Array.isArray(data)) throw new Error('Invalid GitHub commit association');
        for (const pr of data) if (pr && Number.isSafeInteger(pr.number) && pr.number > 0) numbers.push(pr.number);
        if (!res.headers.get('link')?.includes('rel="next"')) break;
      }
      return [...new Set(numbers)];
    })().catch(() => [] as number[]);
    // Empty/failed lookups can change when the PR is first opened; retry after a short grace period.
    cache.set(key, { until: now() + 30_000, value });
    try {
      const result = await value;
      if (result.length) cache.set(key, { until: now() + 300_000, value: Promise.resolve(result) });
      if (cache.size > 1000) cache.delete(cache.keys().next().value!);
      return result;
    } catch { return []; }
  };
}
