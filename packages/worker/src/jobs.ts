import { providerUnavailableReason, redactSecrets, RUNNER_READINESS_CURSOR, type DocsStore, type FactsStore, type GraphRepo, type IntegrationLink, type LlmProvider, type ScanJob } from '@fb/core';
import { readFile } from 'node:fs/promises';
import { githubTarget, type SyncProject } from './integrations/feedbackSync.ts';
import type { ScanResult } from './scan/scan.ts';
import { parkedOn, type ScanTurn } from './scan/runner.ts';

type Log = (msg: string, extra?: object) => void;

/** Build a provider, or log why it can't be built (and pass the reason to `why`) and return null. */
export type ProviderFactory = (job: string, spec: string, why?: (reason: string) => void) => LlmProvider | null;

export function providerFactory(make: (spec: string) => LlmProvider, log: Log): ProviderFactory {
  return (job, spec, why) => {
    try {
      const p = make(spec);
      log('provider', { job, provider: p.id });
      return p;
    } catch (err) {
      log('provider unavailable', { job, spec, error: String(err) });
      why?.(err instanceof Error ? err.message : String(err));
      return null;
    }
  };
}

/** Providers that explore the repo themselves (LlmProvider.agentic): their scans run one at a time. */
export const isAgenticSpec = (spec: string) => /^(claude-cli|codex-cli)(:|$)/.test(spec);

/** Uploads one round may pass over (not selected, replaced while picked, failed) before it gives up for the round. */
const DOC_TRIES = 5;

/**
 * One upload read into facts; true when one was read (so the loop keeps going). Uploads skipped are passed over in
 * the same round, a few at most; a model that is down, or an error, ends the round's reading.
 */
export async function readDocsRound(read: () => Promise<{ read: boolean; unavailable?: string } | null>, log: Log): Promise<boolean> {
  for (let i = 0; i < DOC_TRIES; i++) {
    const r = await read().catch((err) => {
      log('document reading failed', { error: redactSecrets(String(err)) });
      return null;
    });
    if (!r || r.read || r.unavailable) return !!r?.read;
  }
  return false;
}

/** GitHub review comments read per scan for the files they are on (scan order hotspots). */
const PR_PATHS_LIMIT = 500;

/** The files review comments are on: where reviewers found something to say, so scanned early. */
export async function reviewedPaths(repo: Pick<GraphRepo, 'listCandidates'>, projectKey: string): Promise<string[]> {
  const comments = await repo.listCandidates({ projectKey, source: 'github', limit: PR_PATHS_LIMIT });
  return [...new Set(comments.map((c) => c.external?.path).filter((p): p is string => !!p))];
}

export type ScanJobDeps = {
  /** ProjectScope.folder: the project is selected and not excluded (re-read from the store when the held scope says no). */
  inScope: (projectKey: string) => boolean | Promise<boolean>;
  facts: Pick<FactsStore, 'updateScanJob'>;
  /** The job's model (health-tracked), or null with the reason passed to `why`. */
  provider: (spec: string, why: (reason: string) => void) => LlmProvider | null;
  defaultSpec: string;
  /** The project's code map, made first; logs its own failure. */
  mapProject: (p: { key: string; repoPath: string }) => Promise<unknown>;
  scan: (job: ScanJob, llm: LlmProvider, turn?: ScanTurn) => Promise<ScanResult>;
  log: Log;
};

/**
 * Run one claimed scan job to its end, or to a shard boundary where it gives way to a scan waiting for its slot (turn);
 * true when it finished (done or failed) or gave way, false when it went back to wait out a retry (its model
 * unreachable, or the scan failed and was charged): not progress, so the loop sleeps.
 */
export async function runScanJob(job: ScanJob, d: ScanJobDeps, turn?: ScanTurn): Promise<boolean> {
  if (!await d.inScope(job.projectKey)) {
    await d.facts.updateScanJob(job.id, { status: 'failed', error: 'project is not selected in Settings, or is in EXCLUDE_PROJECTS' });
    return true;
  }
  const spec = job.provider || d.defaultSpec;
  let reason = '';
  const llm = d.provider(spec, (r) => (reason = r));
  if (!llm) {
    await d.facts.updateScanJob(job.id, { status: 'failed', error: `provider unavailable: ${spec}${reason ? `: ${reason}` : ''}` });
    return true;
  }
  // It runs now, on this model: a park reason from waiting on another (or this one, before it answered) no longer holds.
  if (job.parkedAt || parkedOn(job)) await d.facts.updateScanJob(job.id, { parkedAt: null, ...(parkedOn(job) && { error: null, retryAt: null }) });
  // The map first, so the scan's project has a current one. A scan going on after giving way had its map made when it started.
  if (!job.shards?.processed) await d.mapProject({ key: job.projectKey, repoPath: job.repoPath });
  d.log('scan started', { project: job.projectKey, provider: llm.id });
  const r = await d.scan(job, llm, turn).catch((err) => {
    const unavailable = providerUnavailableReason(err);
    if (unavailable) d.log('scan model unavailable, the scan stays queued', { project: job.projectKey, reason: unavailable });
    else d.log('scan failed', { project: job.projectKey, error: redactSecrets(String(err)) });
    return null;
  });
  if (r && !r.paused) d.log('scan done', { project: job.projectKey, ...r });
  return !!r;
}

const RETENTION_EVERY_MS = 6 * 3600_000;

/** TURN_RETENTION_DAYS: the text of old unflagged turns is removed, at most every six hours; unset (0) keeps it. */
export class RetentionPacer {
  private d: {
    days: number;
    /** While summaries are on, a turn keeps its text until a summary covers it (summaries themselves are never pruned). */
    keepUnsummarized: boolean;
    prune: (before: Date, o: { keepUnsummarized: boolean }) => Promise<number>;
    log: Log;
  };
  private last = 0;

  constructor(d: RetentionPacer['d']) {
    this.d = d;
  }

  async tick(now = Date.now()): Promise<void> {
    if (!this.d.days || now - this.last < RETENTION_EVERY_MS) return;
    this.last = now;
    const pruned = await this.d.prune(new Date(now - this.d.days * 86_400_000), { keepUnsummarized: this.d.keepUnsummarized });
    if (pruned) this.d.log('retention: removed text of old unflagged turns', { pruned, days: this.d.days });
  }
}

/**
 * A round beside the loop, never awaited by it, at most every `everyMs` and never two at once: one over many projects
 * must not hold up ingest, scans or uploads. Its failure is logged (redacted) and it runs again when due.
 */
export class Sometimes {
  private d: { everyMs: number; run: () => Promise<void>; what: string; log: Log };
  private at = 0;
  private running = false;

  constructor(d: Sometimes['d']) {
    this.d = d;
  }

  /** The round in flight, when one started; else undefined. */
  tick(now = Date.now()): Promise<void> | undefined {
    if (this.running || now - this.at < this.d.everyMs) return;
    this.at = now;
    this.running = true;
    return this.d.run()
      .catch((err) => this.d.log(`${this.d.what} failed`, { error: redactSecrets(String(err)) }))
      .finally(() => { this.running = false; });
  }
}

/**
 * The selected folders with their remotes, for link detection: the stored project's remote, else (a record a scan or
 * code map made has none until the next cycle fills it) the folder's own.
 */
export async function foldersWithRemotes(
  stored: { key: string; remote?: string | null }[],
  folders: { key: string; repoPath: string }[],
  remote: (repoPath: string) => Promise<string | null>,
): Promise<{ key: string; repoPath: string; remote: string | null }[]> {
  const remotes = new Map(stored.map((p) => [p.key, p.remote]));
  return Promise.all(folders.map(async (p) => ({ ...p, remote: remotes.get(p.key) ?? (await remote(p.repoPath)) })));
}

/** Where the worker sees the runner's persisted safety flag (docker-compose.yml mounts state/runner-control here). */
export const RUNNER_DISABLED_FLAG = '/state/runner-control/codex-runner-disabled';

/** The flag's reasons (printable lines joined by "; ", or "no reason recorded"); null when there is no flag. */
export async function runnerDisabledFlag(path: string): Promise<string | null> {
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (text === null) return null;
  const reasons = text.slice(0, 4096).split('\n').map((l) => l.replace(/[^\x20-\x7e]/g, '').trim()).filter(Boolean);
  return reasons.length ? reasons.join('; ') : 'no reason recorded';
}

/**
 * The Codex runner's readiness (CODEX_RUNNER_URL), published in the store so the api can show it without network
 * access to the runner. Reports in flight are shared; a failure is logged and the next report tries again.
 */
export class RunnerReport {
  private d: {
    url: string | undefined;
    readiness: (url: string) => Promise<{ ok: boolean; reason: string | null }>;
    /**
     * The runner's persisted safety flag (state/runner-control/codex-runner-disabled, set by doctor or restore): its
     * reasons, or null when there is none. With it the runner does not start, so it is reported off, not asked.
     */
    disabled?: () => Promise<string | null>;
    cursors: Pick<DocsStore, 'setCursor'>;
    log: Log;
    now?: () => number;
  };
  private inFlight: Promise<void> | undefined;

  constructor(d: RunnerReport['d']) {
    this.d = d;
  }

  report(): Promise<void> {
    const url = this.d.url;
    if (!url) return Promise.resolve();
    return this.inFlight ??= (async () => {
      try {
        const flag = await this.d.disabled?.();
        const result = flag !== null && flag !== undefined ? { ok: false, reason: flag, disabled: true } : await this.d.readiness(url);
        await this.d.cursors.setCursor(RUNNER_READINESS_CURSOR, JSON.stringify({ ...result, reason: result.reason ? redactSecrets(result.reason) : null, at: (this.d.now ?? Date.now)() }));
      } catch (err) {
        this.d.log('runner readiness report failed', { error: redactSecrets(String(err)) });
      }
    })().finally(() => { this.inFlight = undefined; });
  }

  /** The report in flight, if any (shutdown waits for it). */
  pending(): Promise<void> | undefined {
    return this.inFlight;
  }
}

/**
 * Which repository's PR discussions each project reads (its remote's, or GITHUB_REPOS's override), for the projects
 * whose link leaves GitHub on, and whose PRs only (githubAuthor) where the owner set one.
 */
export async function githubDocTargets(
  projects: SyncProject[],
  link: (projectKey: string) => Promise<Pick<IntegrationLink, 'github' | 'githubAuthor'>>,
  overrides: Map<string, string>,
): Promise<{ repos: Map<string, string>; authors: Map<string, string> }> {
  const repos = new Map<string, string>();
  const authors = new Map<string, string>();
  for (const p of projects) {
    const l = await link(p.key);
    if (l.githubAuthor) authors.set(p.key, l.githubAuthor);
    const target = l.github ? githubTarget(p, overrides) : null;
    if (target) repos.set(p.key, target);
  }
  return { repos, authors };
}
