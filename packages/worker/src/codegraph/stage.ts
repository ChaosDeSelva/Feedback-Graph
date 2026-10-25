import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ActivityStore, CodeGraphStore, CodeMapStats } from '@fb/core';
import { GIT_SAFE } from '../ingest/git.ts';
import { MAX_AUTO_MAP_FILES } from '../scan/rank.ts';
import { buildCodeMap } from './codemap.ts';
import { churn as gitChurn } from './churn.ts';
import { testsFor } from './queries.ts';
import type { BuildOpts, CodeMap } from './types.ts';

const run = promisify(execFile);

/** Commits per file are counted over this window. */
export const CHURN_DAYS = 90;
/** A project's repo is looked at no more often than this (a scan maps its project regardless). */
export const MAP_INTERVAL_MS = 5 * 60_000;
/** How many of the files a project's sessions edited a capped map or a scan keeps first. */
export const EDITED_PATHS_LIMIT = 1000;

/** How long `git status` may take: a bind-mounted tree of thousands of files can need minutes. */
export const gitStatusTimeoutMs = (files: number) => Math.min(300_000, 30_000 + 10 * Math.max(0, files));

/**
 * What the repo looks like right now, cheaply: HEAD, `git status` (which respects .gitignore), and the size and mtime
 * of each dirty file (at most maxFiles of them). Null when the folder is not in a git repo: then there is no cheap
 * check, and the map is rebuilt on the interval (incrementally, so unchanged files are not reparsed).
 */
export async function repoFingerprint(
  repoPath: string,
  maxFiles: number,
  o: { exec?: (args: string[], timeoutMs?: number) => Promise<string>; log?: (msg: string, extra?: object) => void; timeoutMs?: number } = {},
): Promise<string | null> {
  const timeoutMs = o.timeoutMs ?? gitStatusTimeoutMs(0);
  const exec = o.exec ?? (async (args: string[], timeout = 30_000) => (await run('git', args, { timeout, maxBuffer: 64 * 1024 * 1024 })).stdout);
  // The repo is mounted read-only: --no-optional-locks stops `git status` from trying to refresh the index.
  const git = (...args: string[]) => exec(['--no-optional-locks', ...GIT_SAFE, '-C', repoPath, ...args]);
  const status = (untracked: 'normal' | 'no') =>
    exec(['--no-optional-locks', ...GIT_SAFE, '-C', repoPath, 'status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`, '--', '.'], timeoutMs);
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

export type MapStageDeps = {
  store: Pick<CodeGraphStore, 'codeMap' | 'codeMapMeta' | 'replaceCodeMap'>;
  activity?: Pick<ActivityStore, 'record'>;
  /** The selected projects (scope) and their folders, as the worker sees them. */
  projects(): Promise<{ key: string; repoPath: string }[]>;
  /** The scanner's bounds. maxFiles null: the map's cap scales with the repo (SCAN_MAX_FILES unset). */
  maxFiles: number | null;
  maxBytes: number;
  minIntervalMs?: number;
  build?: (repoPath: string, opts: BuildOpts, prev?: CodeMap) => Promise<CodeMap>;
  churn?: typeof gitChurn;
  fingerprint?: (repoPath: string, maxFiles: number, o?: { timeoutMs?: number }) => Promise<string | null>;
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The worker's "map" stage: keeps each selected project's code map current. It runs beside ingest (kick() starts a
 * background pass and returns at once; one pass at a time), so a slow parse never holds up transcripts.
 */
export class MapStage {
  private readonly d: MapStageDeps;
  private readonly checkedAt = new Map<string, number>();
  private running: Promise<void> | null = null;
  /** One build per project at a time: a scan's map waits for the background one on the same project. */
  private readonly building = new Map<string, Promise<MapResult | null>>();
  /** Aborted by stop(): parsing stops, nothing new starts, and a map not yet being written is not written. */
  private readonly stopping = new AbortController();

  constructor(d: MapStageDeps) {
    this.d = d;
  }

  /** Start a pass over the selected projects unless one is running. Never throws; nothing waits for it. */
  kick(): void {
    if (this.running || this.stopping.signal.aborted) return;
    this.running = this.pass()
      .catch((err) => this.d.log?.('code map pass failed', { error: String(err) }))
      .finally(() => {
        this.running = null;
      });
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
  async pass(): Promise<void> {
    const now = this.d.now ?? Date.now;
    for (const p of await this.d.projects()) {
      if (this.stopping.signal.aborted) return;
      const last = this.checkedAt.get(p.key);
      if (last !== undefined && now() - last < (this.d.minIntervalMs ?? MAP_INTERVAL_MS)) continue;
      this.checkedAt.set(p.key, now());
      await this.mapProject(p, null).catch(() => null);
    }
  }

  /**
   * Map one project now if its repo changed since its map (any interval aside). `why` is the trigger for the log;
   * null: the background pass. Returns what was written, or null when nothing changed or the build failed.
   */
  async mapProject(p: { key: string; repoPath: string }, why: string | null): Promise<MapResult | null> {
    const pending = this.building.get(p.key);
    if (pending) await pending.catch(() => null);
    if (this.stopping.signal.aborted) return null;
    const job = this.build(p, why);
    this.building.set(p.key, job);
    try {
      return await job;
    } finally {
      if (this.building.get(p.key) === job) this.building.delete(p.key);
    }
  }

  private async build(p: { key: string; repoPath: string }, why: string | null): Promise<MapResult | null> {
    const d = this.d;
    const t0 = Date.now();
    try {
      const meta = await d.store.codeMapMeta(p.key);
      const dirtyCap = d.maxFiles ?? MAX_AUTO_MAP_FILES;
      const timeoutMs = gitStatusTimeoutMs(meta?.candidates ?? meta?.stats.files ?? 0);
      const fingerprint = d.fingerprint ? await d.fingerprint(p.repoPath, dirtyCap, { timeoutMs }) : await repoFingerprint(p.repoPath, dirtyCap, { log: d.log, timeoutMs });
      if (meta && fingerprint !== null && meta.fingerprint === fingerprint) return null;
      const prev = meta ? await d.store.codeMap(p.key) : null;
      const signal = this.stopping.signal;
      const priority = d.editedPaths ? await d.editedPaths(p.key).catch(() => []) : [];
      const map = await (d.build ?? buildCodeMap)(p.repoPath, { maxFiles: d.maxFiles, maxBytes: d.maxBytes, signal, priority }, prev ?? undefined);
      const commits = await (d.churn ?? gitChurn)(p.repoPath, CHURN_DAYS);
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
