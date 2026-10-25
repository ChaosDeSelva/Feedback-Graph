import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ActivityStore, CodeGraphStore, CodeMapStats } from '@fb/core';
import { GIT_SAFE } from '../ingest/git.ts';
import { MAX_AUTO_MAP_FILES } from '../scan/rank.ts';
import { candidatePaths } from '../scan/scan.ts';
import { buildCodeMap } from './codemap.ts';
import { churn as gitChurn } from './churn.ts';
import { testsFor } from './queries.ts';
import type { BuildOpts, CodeMap } from './types.ts';

const run = promisify(execFile);

/** Commits per file are counted over this window. */
export const CHURN_DAYS = 90;
/** A project's repo is looked at no more often than this (a scan maps its project regardless). */
export const MAP_INTERVAL_MS = 5 * 60_000;
/**
 * How long one project may hold the background pass before it counts as stalled: git status may take 5 minutes, a
 * 4000-file parse and write a minute or two. A stalled pass is logged and abandoned, so one hung read over the mount
 * (nothing can cancel it) does not stop every other project's map for good.
 */
export const MAP_STALL_MS = 20 * 60_000;
/** Orphan CodeFile records deleted per purge (once per MAP_INTERVAL_MS): one bounded transaction each time. */
export const ORPHAN_PURGE_LIMIT = 5000;
/** How many of the files a project's sessions edited a capped map or a scan keeps first. */
export const EDITED_PATHS_LIMIT = 1000;

/** How long `git status` may take: a bind-mounted tree of thousands of files can need minutes. */
export const gitStatusTimeoutMs = (files: number) => Math.min(300_000, 30_000 + 10 * Math.max(0, files));

/**
 * What the repo looks like right now, cheaply: HEAD, `git status` (which respects .gitignore), and the size and mtime
 * of each dirty file (at most maxFiles of them). Null when git cannot tell (not a repo, a worktree whose git dir is
 * out of reach, status failing): the map stage then falls back to fileFingerprint.
 */
export async function repoFingerprint(
  repoPath: string,
  maxFiles: number,
  o: { exec?: (args: string[], timeoutMs?: number) => Promise<string>; log?: (msg: string, extra?: object) => void; timeoutMs?: number; gitArgs?: readonly string[] } = {},
): Promise<string | null> {
  const timeoutMs = o.timeoutMs ?? gitStatusTimeoutMs(0);
  const exec = o.exec ?? (async (args: string[], timeout = 30_000) => (await run('git', args, { timeout, maxBuffer: 64 * 1024 * 1024 })).stdout);
  // The repo is mounted read-only: --no-optional-locks stops `git status` from trying to refresh the index.
  // gitArgs: a worktree's git dir reached through the roots mapping (worktreeGitArgs).
  const base = ['--no-optional-locks', ...GIT_SAFE, '-C', repoPath, ...(o.gitArgs ?? [])];
  const git = (...args: string[]) => exec([...base, ...args]);
  const status = (untracked: 'normal' | 'no') =>
    exec([...base, 'status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`, '--', '.'], timeoutMs);
  let top: string;
  try {
    top = (await git('rev-parse', '--show-toplevel')).trim();
  } catch {
    return null;
  }
  const head = (await git('rev-parse', '-q', '--verify', 'HEAD').catch(() => '')).trim();
  const failed = (e: unknown, extra: object = {}) => {
    const err = e as { killed?: boolean; signal?: string; message?: string };
    o.log?.(err.killed ? 'git status timed out' : 'git status failed', { repoPath, error: String(err.message ?? e).slice(0, 300), ...extra });
    return !!err.killed;
  };
  let out: string;
  try {
    out = await status('normal');
  } catch (e) {
    // Listing untracked files is the slow part of a big tree: a timeout is tried once more without them (new files
    // then show up at the next commit or edit of a tracked file, or when the interval rebuild runs).
    if (!failed(e)) return null;
    try {
      out = `untracked=no\0${await status('no')}`;
    } catch (e2) {
      // Without status a dirty tree looks clean: no fingerprint, so the map is rebuilt on the interval instead.
      failed(e2, { untracked: 'no' });
      return null;
    }
  }
  const h = createHash('sha256').update(`${head}\n${out}\n`);
  // -z: "XY <path>\0", and a rename's old path as one more "\0"-terminated field.
  const entries = out.split('\0');
  let seen = 0;
  for (let i = 0; i < entries.length && seen < maxFiles; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    if (e[0] === 'R' || e[0] === 'C') i++;
    seen++;
    const st = await lstat(join(top, e.slice(3))).catch(() => null);
    h.update(st ? `${e.slice(3)}\0${st.size}\0${st.mtimeMs}\0` : `${e.slice(3)}\0gone\0`);
  }
  return h.digest('hex');
}

/**
 * The fallback when git cannot tell (not a repo, a worktree whose git dir is out of reach, `git status` failing): the
 * path, size and mtime of every file a map would consider. Dearer than git (one lstat per candidate) but far cheaper
 * than a rebuild; `fs:`-prefixed so it never equals a git fingerprint.
 */
export async function fileFingerprint(repoPath: string): Promise<string> {
  const h = createHash('sha256');
  for (const path of (await candidatePaths(repoPath)).sort()) {
    const st = await lstat(join(repoPath, path)).catch(() => null);
    h.update(st ? `${path}\0${st.size}\0${st.mtimeMs}\0` : `${path}\0gone\0`);
  }
  return `fs:${h.digest('hex')}`;
}

export type MapStageDeps = {
  store: Pick<CodeGraphStore, 'codeMap' | 'codeMapMeta' | 'replaceCodeMap'> & Partial<Pick<CodeGraphStore, 'codeMapRebuildsRequested' | 'purgeOrphanCodeFiles'>>;
  activity?: Pick<ActivityStore, 'record'>;
  /** The selected projects (scope) and their folders, as the worker sees them. */
  projects(): Promise<{ key: string; repoPath: string }[]>;
  /** The scanner's bounds. maxFiles null: the map's cap scales with the repo (SCAN_MAX_FILES unset). */
  maxFiles: number | null;
  maxBytes: number;
  minIntervalMs?: number;
  /** MAP_STALL_MS: how long one project may hold the background pass before kick() gives up on that pass. */
  stallMs?: number;
  build?: (repoPath: string, opts: BuildOpts, prev?: CodeMap) => Promise<CodeMap>;
  churn?: typeof gitChurn;
  fingerprint?: (repoPath: string, maxFiles: number, o?: { timeoutMs?: number; gitArgs?: readonly string[] }) => Promise<string | null>;
  /** The fallback fingerprint when git gives none (fileFingerprint). */
  fsFingerprint?: (repoPath: string) => Promise<string | null>;
  /** Extra global git options for a folder: a worktree's git dir through the roots mapping (worktreeGitArgs). */
  gitArgs?: (repoPath: string) => Promise<string[]>;
  /** Files the project's sessions edited, most recent first (CodeGraphStore.editedPaths): kept in a capped map first. */
  editedPaths?: (projectKey: string) => Promise<string[]>;
  log?: (msg: string, extra?: object) => void;
  now?: () => number;
  /**
   * SelectionStore.exclusive, the section cleanup and project delete run in: the map is written inside it (the
   * parse before it), so a delete never interleaves with a map write or is undone by one.
   */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Read inside the section: whether the project is still selected (the selection as stored right now). */
  inScope?: (key: string) => Promise<boolean>;
};

export type MapResult = CodeMapStats & { durationMs: number };

/** The `why` of a map built because you asked for it (POST /api/projects/:key/codemap/rebuild). */
const REBUILD_WHY = 'you asked for a rebuild of the map';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The worker's "map" stage: keeps each selected project's code map current. It runs beside ingest (kick() starts a
 * background pass and returns at once; one pass at a time), so a slow parse never holds up transcripts.
 */
export class MapStage {
  private readonly d: MapStageDeps;
  private readonly checkedAt = new Map<string, number>();
  /** When orphan code files were last purged (d.now). */
  private purgedAt: number | null = null;
  /** Projects already logged as having no git fingerprint (said once, not every interval). */
  private readonly noGitFingerprint = new Set<string>();
  private running: Promise<void> | null = null;
  /** The background pass's current project and since when (d.now), for the stall check. */
  private current: { key: string; since: number } | null = null;
  /** One build per project at a time: a scan's map waits for the background one on the same project. */
  private readonly building = new Map<string, Promise<MapResult | null>>();
  /** Aborted by stop(): parsing stops, nothing new starts, and a map not yet being written is not written. */
  private readonly stopping = new AbortController();

  constructor(d: MapStageDeps) {
    this.d = d;
  }

  /** Start a pass over the selected projects unless one is running. Never throws; nothing waits for it. */
  kick(): void {
    if (this.stopping.signal.aborted) return;
    if (this.running) {
      const now = this.d.now ?? Date.now;
      const stuck = this.current;
      if (!stuck || now() - stuck.since < (this.d.stallMs ?? MAP_STALL_MS)) return;
      // Nothing can cancel a hung read or git call: the pass is left behind (it stops at its next project), and the
      // project's build no longer holds back the next one.
      this.d.log?.('code map stage stalled', { project: stuck.key, runningMs: now() - stuck.since });
      this.building.delete(stuck.key);
      this.current = null;
    }
    const pass: Promise<void> = this.pass(() => this.running === pass)
      .catch((err) => this.d.log?.('code map pass failed', { error: String(err) }))
      .finally(() => {
        if (this.running === pass) this.running = null;
      });
    this.running = pass;
  }

  /** Resolves when no pass is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Graceful shutdown: a map being parsed is abandoned (nothing of it is written), a map being written is waited for,
   * so the store is never closed under a write. Resolves when nothing runs; nothing starts after it.
   */
  async stop(): Promise<void> {
    this.stopping.abort(new Error('the worker is shutting down'));
    await this.idle();
    while (this.building.size) await Promise.all([...this.building.values()].map((b) => b.catch(() => null)));
  }

  /** Map every selected project whose repo was not looked at within the interval and has changed since its map. */
  async pass(live: () => boolean = () => true): Promise<void> {
    const now = this.d.now ?? Date.now;
    // Rebuilds you asked for (the Rebuild map button, `fg map rebuild`): pending until the map is built again.
    const asked = new Map(((await this.d.store.codeMapRebuildsRequested?.().catch(() => [])) ?? []).map((r) => [r.projectKey, Date.parse(r.requestedAt)]));
    for (const p of await this.d.projects()) {
      // Shutting down, or abandoned as stalled (a newer pass has taken over).
      if (this.stopping.signal.aborted || !live()) return;
      const last = this.checkedAt.get(p.key);
      const at = asked.get(p.key);
      // Asked since this project was last looked at: now. A rebuild that failed waits for the interval like any other.
      const fresh = at !== undefined && (last === undefined || at > last);
      if (!fresh && last !== undefined && now() - last < (this.d.minIntervalMs ?? MAP_INTERVAL_MS)) continue;
      this.checkedAt.set(p.key, now());
      this.current = { key: p.key, since: now() };
      await this.mapProject(p, at !== undefined ? REBUILD_WHY : null, { force: at !== undefined }).catch(() => null);
      if (live()) this.current = null;
    }
    if (!this.stopping.signal.aborted && live()) await this.purgeOrphans();
  }

  /** Files out of every map with nothing about them (see CodeGraphStore.purgeOrphanCodeFiles), once per interval. */
  private async purgeOrphans(): Promise<void> {
    const now = this.d.now ?? Date.now;
    if (!this.d.store.purgeOrphanCodeFiles) return;
    if (this.purgedAt !== null && now() - this.purgedAt < (this.d.minIntervalMs ?? MAP_INTERVAL_MS)) return;
    this.purgedAt = now();
    try {
      const files = await this.d.store.purgeOrphanCodeFiles(ORPHAN_PURGE_LIMIT);
      if (files > 0) this.d.log?.('orphan code files purged', { files });
    } catch (err) {
      this.d.log?.('orphan code file purge failed', { error: String(err) });
    }
  }

  /**
   * Map one project now if its repo changed since its map (any interval aside). `why` is the trigger for the log;
   * null: the background pass. Returns what was written, or null when nothing changed or the build failed.
   */
  async mapProject(p: { key: string; repoPath: string }, why: string | null, o: { force?: boolean } = {}): Promise<MapResult | null> {
    const pending = this.building.get(p.key);
    if (pending) await pending.catch(() => null);
    if (this.stopping.signal.aborted) return null;
    const job = this.build(p, why, !!o.force);
    this.building.set(p.key, job);
    try {
      return await job;
    } finally {
      if (this.building.get(p.key) === job) this.building.delete(p.key);
    }
  }

  /** force: a rebuild you asked for, from scratch (no previous map reused), whether or not the repo changed. */
  private async build(p: { key: string; repoPath: string }, why: string | null, force: boolean): Promise<MapResult | null> {
    const d = this.d;
    const t0 = Date.now();
    try {
      const meta = await d.store.codeMapMeta(p.key);
      const dirtyCap = d.maxFiles ?? MAX_AUTO_MAP_FILES;
      const timeoutMs = gitStatusTimeoutMs(meta?.candidates ?? meta?.stats.files ?? 0);
      const gitArgs = d.gitArgs ? await d.gitArgs(p.repoPath).catch(() => []) : [];
      let fingerprint = d.fingerprint
        ? await d.fingerprint(p.repoPath, dirtyCap, { timeoutMs, gitArgs })
        : await repoFingerprint(p.repoPath, dirtyCap, { log: d.log, timeoutMs, gitArgs });
      if (fingerprint === null) {
        // Without one the map would be rebuilt (and rewritten) every interval, forever: compare the files instead.
        if (!this.noGitFingerprint.has(p.key)) {
          this.noGitFingerprint.add(p.key);
          d.log?.('code map fingerprint unavailable', { project: p.key, repoPath: p.repoPath, fallback: 'file sizes and times' });
        }
        fingerprint = await (d.fsFingerprint ?? fileFingerprint)(p.repoPath).catch(() => null);
      }
      if (!force && meta && fingerprint !== null && meta.fingerprint === fingerprint) return null;
      // A stored map with no fingerprint is one whose write was cut short (the store clears it first, sets it last):
      // what it holds may be half old, half new, so it is not reused for the incremental parse.
      const prev = meta?.fingerprint && !force ? await d.store.codeMap(p.key) : null;
      const signal = this.stopping.signal;
      const priority = d.editedPaths ? await d.editedPaths(p.key).catch(() => []) : [];
      const map = await (d.build ?? buildCodeMap)(p.repoPath, { maxFiles: d.maxFiles, maxBytes: d.maxBytes, signal, priority }, prev ?? undefined);
      const commits = await (d.churn ?? gitChurn)(p.repoPath, CHURN_DAYS, gitArgs);
      const tests = map.files.filter((f) => !f.isTest).flatMap((f) => testsFor(map, f.path).map((test) => ({ test, target: f.path })));
      const exclusive = d.exclusive ?? (<T>(fn: () => Promise<T>) => fn());
      const stats = await exclusive(async () => {
        // Shutting down before the write began: the old map stays as it was, and the next start maps it again.
        if (signal.aborted) return 'stopped' as const;
        // Unselected, cleaned up or deleted while it was being parsed: writing now would bring its map back.
        if (d.inScope && !(await d.inScope(p.key))) return null;
        return d.store.replaceCodeMap(p.key, { ...map, tests, churn: Object.fromEntries(commits), fingerprint, candidates: map.candidates ?? null });
      });
      if (!stats || stats === 'stopped') {
        d.log?.('code map skipped', { project: p.key, reason: stats ? 'the worker is shutting down' : 'no longer selected' });
        return null;
      }
      const durationMs = Date.now() - t0;
      const candidates = map.candidates ?? null;
      const capped = candidates !== null && candidates > stats.files;
      if (capped) d.log?.('code map capped', { project: p.key, mapped: stats.files, totalCandidates: candidates });
      const filesPart = capped ? `${stats.files} of ${candidates} files (capped)` : plural(stats.files, 'file');
      await d.activity?.record({
        kind: 'code_mapped',
        actor: 'deterministic',
        projectKey: p.key,
        subject: `code map built: ${filesPart}, ${plural(stats.symbols, 'symbol')}, ${plural(stats.imports, 'import edge')}, ${plural(stats.tests, 'test link')}`,
        why: why ?? (meta ? 'the repo changed since the last map' : 'first map of this project'),
        details: { ...stats, candidates, durationMs, incremental: !!prev, fingerprint, churnDays: CHURN_DAYS },
      });
      d.log?.('code map built', { project: p.key, ...stats, durationMs });
      return { ...stats, durationMs };
    } catch (err) {
      if (this.stopping.signal.aborted) d.log?.('code map skipped', { project: p.key, reason: 'the worker is shutting down' });
      else d.log?.('code map failed', { project: p.key, error: String(err) });
      return null;
    }
  }
}
