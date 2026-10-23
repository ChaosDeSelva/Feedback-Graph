import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ConfigError, fetchPullRequestContext, killRunningCommands, loadConfig, makeProvider, ollamaEmbed, projectScope, providerUnavailableReason, ProviderUnavailableError, redactSecrets, runCloudSync, syncProjects,
  searchLinearIssues, selectionNote, touchedAround, VERSION, withHealth, type KnowledgeStore, type LlmProvider, type ModelJob, type ProjectScope, type SyncMemory, type WorkerStatus,
} from '@fb/core';
import { openStore } from '@fb/store-postgres';
import { CloudSyncSchedule } from './cloud/schedule.ts';
import { MapStage } from './codegraph/stage.ts';
import { runCycle, type FileInfo } from './cycle.ts';
import { classifyTurn } from './detect/classify.ts';
import { codexSessionFiles } from './ingest/codex.ts';
import { cachedRemote, commitsInWindow, projectRemote } from './ingest/git.ts';
import { readLines } from './ingest/lines.ts';
import { buildCandidates } from './projects/candidates.ts';
import { importMemories, memoryProjectKey } from './memory/memory.ts';
import { forgetDeleted } from './forget.ts';
import { loadStandingContext, memoryDirFor, runPostMortem } from './postmortem/postmortem.ts';
import { huntContext } from './postmortem/hunt.ts';
import { reposInScope, syncGithub } from './integrations/githubSync.ts';
import { runPostmortems } from './postmortem/step.ts';
import { runScan } from './scan/scan.ts';
import { FileState } from './state.ts';

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

/** Build a provider, or log why it can't be built (and pass the reason to `why`) and return null. */
function provider(job: string, spec: string, why?: (reason: string) => void): LlmProvider | null {
  try {
    const p = makeProvider(spec, process.env);
    log('provider', { job, provider: p.id });
    return p;
  } catch (err) {
    log('provider unavailable', { job, spec, error: String(err) });
    why?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Claude Code transcripts sit one level down: <transcripts>/<encoded-project>/<session>.jsonl. Links are not followed. */
async function listTranscripts(dir: string): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    for (const f of await readdir(join(dir, d.name)).catch(() => [] as string[])) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, d.name, f);
      const s = await lstat(path).catch(() => null);
      if (s?.isFile()) out.push({ path, size: s.size, mtimeMs: s.mtimeMs, source: 'claude' });
    }
  }
  return out;
}

export const embedMismatch = (stored: string, configured: string) =>
  `OLLAMA_EMBED_MODEL is ${configured} but the stored vectors were embedded with ${stored}. Set it back to ${stored}, or re-embed: docker compose run --rm worker node src/reembed.ts`;

const HEARTBEAT_MS = 30_000;
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? '/tmp/fg-heartbeat';
const RETENTION_EVERY_MS = 6 * 3600_000;
const REMOTE_TTL_MS = 10 * 60_000;
const SHUTDOWN_GRACE_MS = 20_000;

async function main() {
  const config = loadConfig(process.env);
  const store = await openStore(config);
  await store.ensureSchema();
  log('store', { store: store.kind });
  const emb = await store.embeddings.check(config.ollama.embedModel);
  if (!emb.ok) throw new ConfigError([embedMismatch(emb.stored, config.ollama.embedModel)]);
  const { graph: repo, knowledge, facts, activity, docs, selection } = store;
  await facts.requeueStaleScans();

  const transcripts = config.transcriptsDir;
  const roots = config.roots;
  const localModel = `ollama:${config.ollama.model}`;
  const embed = (input: string[]) => ollamaEmbed({ url: config.ollama.url, model: config.ollama.embedModel, input });

  // Each job's model reports whether it answers, so /api/status (and the sidebar badge) can say which one is down.
  const health: NonNullable<WorkerStatus['health']> = {};
  const tracked = (job: ModelJob, p: LlmProvider | null) => p && withHealth(p, (h) => { health[job] = h; });
  const classifier = tracked('classify', provider('classify', config.llm.classify ?? localModel));
  const postmortemLlm = tracked(
    'postmortem',
    provider('postmortem', config.llm.postmortem ?? (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'claude-cli' : localModel)) ??
      provider('postmortem (fallback)', localModel),
  );
  const defaultScan = config.llm.scan ?? localModel;
  const state = new FileState(config.stateDb);

  // The owner picks the folders to read (Settings). First start: INGEST_PROJECTS seeds the choice, or nothing does.
  const seeded = await selection.ensure(config, activity);
  log('project selection', { tracked: seeded.selection.tracked, initialized: seeded.selection.initialized, seededNow: seeded.seeded, excluded: config.excludeProjects });
  if (!seeded.seeded && config.ingestProjects.length && config.ingestProjects.join(',') !== seeded.selection.tracked.join(',')) {
    log('INGEST_PROJECTS only seeded the first selection; the projects read are the ones chosen in Settings', { ingestProjects: config.ingestProjects });
  }
  let scope: ProjectScope = projectScope(seeded.selection, config);
  let folderOf = new Map<string, string | string[] | null>();
  let lastNote: string | null = null;
  let codexMissingLogged = false;

  const status: WorkerStatus = {
    version: VERSION,
    startedAt: new Date().toISOString(),
    lastBeat: new Date().toISOString(),
    lastCycleAt: null,
    lastCycle: null,
    lastError: null,
    providers: { classify: classifier?.id ?? null, postmortem: postmortemLlm?.id ?? null, scan: defaultScan },
    health,
  };
  // A timer, not the loop, beats: a 15-minute post-mortem must not make the worker look dead.
  const beat = () => {
    status.lastBeat = new Date().toISOString();
    // A file too, so the container health check needs no database round trip.
    writeFile(HEARTBEAT_FILE, status.lastBeat).catch(() => {});
    repo.heartbeat(status).catch((err) => log('heartbeat failed', { error: String(err) }));
  };
  beat();
  const beater = setInterval(beat, HEARTBEAT_MS);

  let stopping = false;
  let wake: (() => void) | null = null;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('shutting down', { signal });
    clearInterval(beater);
    killRunningCommands(); // detached CLI agents would otherwise outlive the worker
    wake?.();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('exit', killRunningCommands);

  const cycleDeps = {
    listFiles: async () => [...(await listTranscripts(transcripts)), ...(await codexSessionFiles(config.codexSessionsDir)).map((f) => ({ ...f, source: 'codex' as const }))],
    readFile: (p: string) => readFile(p, 'utf8'),
    readLines,
    folderOf: (p: string) => folderOf.get(p),
    state,
    repo,
    roots,
    commits: commitsInWindow,
    // No classifier (it could not be built) is unavailability too: turns wait for one instead of being charged.
    classify: async (t: Parameters<typeof classifyTurn>[0]) => {
      if (!classifier) throw new ProviderUnavailableError('no classifier could be built (see the provider log line at startup)');
      return classifyTurn(t, classifier);
    },
    classifyBatch: config.classifyBatch,
    log,
    classifierId: classifier?.id,
    includeProject: (k: string) => scope.folder(k),
    // Each transcript is written under the store's lock, against the selection as stored then (cleanup can run mid-cycle).
    scopeNow: () => selection.scope(config),
    exclusive: <T>(fn: () => Promise<T>) => selection.exclusive(fn),
    onlyProjects: scope.projects,
    excludeProjects: config.excludeProjects.length ? config.excludeProjects : undefined,
    activity,
    remote: cachedRemote(projectRemote, REMOTE_TTL_MS),
    projects: repo,
    codegraph: store.codegraph,
  };

  const pmDeps = postmortemLlm && {
    k: knowledge,
    postmortem: (input: Parameters<typeof runPostMortem>[0]) =>
      runPostMortem(input, {
        llm: postmortemLlm,
        touched: async (i) => touchedAround(await store.codegraph.sessionFiles(i.sessionId), i.feedback.ts),
        // Instruction files from the repo up to its project root (the mount: nothing above it is visible here).
        standing: (i) =>
          loadStandingContext({
            repoPath: i.repoPath,
            stopAt: roots.find((r) => i.repoPath.startsWith(`${r.container}/`))?.container ?? dirname(i.repoPath),
            memoryDir: memoryDirFor(transcripts, i.cwd),
            source: i.source,
          }),
        facts: (i) =>
          huntContext(i, {
            embed,
            facts,
            docs,
            linear: process.env.LINEAR_API_KEY ? { apiKey: process.env.LINEAR_API_KEY, search: searchLinearIssues } : undefined,
            log,
          }),
      }),
    embed,
    batch: 1,
    log,
    activity,
  };

  const memDeps = {
    transcriptsDir: transcripts,
    roots: () =>
      Promise.all(roots.map(async (r) => ({
        host: r.host,
        keys: (await readdir(r.container, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name),
      }))),
    includeProject: (k: string) => scope.folder(k),
    state,
    embed,
    upsertLesson: (l: Parameters<KnowledgeStore['upsertLesson']>[0]) => knowledge.upsertLesson(l),
    activity,
    autoApprove: config.memoryAutoApprove,
  };

  /** The folders of the selected projects, under the first root that has them (plain directories only). */
  async function selectedFolders(): Promise<{ key: string; repoPath: string }[]> {
    const out: { key: string; repoPath: string }[] = [];
    for (const key of scope.projects) {
      for (const r of roots) {
        const repoPath = join(r.container, key);
        if ((await lstat(repoPath).catch(() => null))?.isDirectory()) {
          out.push({ key, repoPath });
          break;
        }
      }
    }
    return out;
  }

  // The code map of each selected project, kept current beside ingest (never awaited by it).
  const mapStage = new MapStage({
    store: store.codegraph,
    activity,
    projects: selectedFolders,
    maxFiles: config.scanMaxFiles,
    maxBytes: config.scanMaxBytes,
    log,
    exclusive: <T>(fn: () => Promise<T>) => selection.exclusive(fn),
    inScope: async (key: string) => (await selection.scope(config)).project(key),
  });

  async function scanOne(): Promise<boolean> {
    const job = await facts.nextScanJob();
    if (!job) return false;
    if (!scope.folder(job.projectKey)) {
      await facts.updateScanJob(job.id, { status: 'failed', error: 'project is not selected in Settings, or is in EXCLUDE_PROJECTS' });
      return true;
    }
    let reason = '';
    const llm = tracked('scan', provider('scan', job.provider || defaultScan, (r) => (reason = r)));
    if (!llm) {
      await facts.updateScanJob(job.id, { status: 'failed', error: `provider unavailable: ${job.provider || defaultScan}${reason ? `: ${reason}` : ''}` });
      return true;
    }
    // The map first, so the scan's project has a current one; a failure here is logged and the scan goes on.
    await mapStage.mapProject({ key: job.projectKey, repoPath: job.repoPath }, 'a scan was requested');
    log('scan started', { project: job.projectKey, provider: llm.id });
    let unavailable: string | null = null;
    const r = await runScan(job, { facts, llm, embed, maxBytes: config.scanMaxBytes, maxFiles: config.scanMaxFiles, log, activity }).catch((err) => {
      unavailable = providerUnavailableReason(err);
      if (unavailable) log('scan model unavailable, the scan stays queued', { project: job.projectKey, reason: unavailable });
      else log('scan failed', { project: job.projectKey, error: redactSecrets(String(err)) });
      return null;
    });
    if (r) log('scan done', { project: job.projectKey, ...r });
    // Back in the queue: not progress, or the loop would pick it up again at once instead of waiting a poll.
    return !unavailable;
  }

  const githubDeps = config.github
    ? {
        repos: new Map<string, string>(),
        token: config.github.token,
        fetchPrs: fetchPullRequestContext,
        docs,
        embed,
        activity,
        minIntervalMs: config.github.syncHours * 3600_000,
        log,
      }
    : null;
  log('github sync', { enabled: !!githubDeps, repos: [...(config.github?.repos.keys() ?? [])] });

  // Feedback Graph Cloud: off (and nothing is sent) unless CLOUD_URL and CLOUD_TOKEN are set.
  const cloud = config.cloud;
  const memory: SyncMemory = new Map();
  const cloudSchedule = cloud
    ? new CloudSyncSchedule({
        host: new URL(cloud.url).host,
        intervalMinutes: cloud.intervalMinutes,
        log,
        run: () =>
          runCloudSync({
            cloud,
            portability: store.portability,
            activity,
            projects: async () => syncProjects({ configured: cloud.projects, selected: scope.projects, excluded: config.excludeProjects }),
            trigger: 'schedule',
            memory,
          }),
      })
    : null;
  status.cloudSync = cloudSchedule?.status ?? null;
  log('cloud sync', cloud ? { enabled: true, host: new URL(cloud.url).host, intervalMinutes: cloud.intervalMinutes, projects: cloud.projects } : { enabled: false });

  let lastRetention = 0;
  async function retention() {
    if (!config.turnRetentionDays || Date.now() - lastRetention < RETENTION_EVERY_MS) return;
    lastRetention = Date.now();
    const pruned = await repo.pruneTurnText(new Date(Date.now() - config.turnRetentionDays * 86_400_000));
    if (pruned) log('retention: removed text of old unflagged turns', { pruned, days: config.turnRetentionDays });
  }

  /** Re-read the selection: it changes from Settings at any time, including during a long backfill. */
  async function refreshScope() {
    scope = await selection.scope(config);
    cycleDeps.onlyProjects = scope.projects;
    if (githubDeps && config.github) githubDeps.repos = reposInScope(config.github.repos, scope.folder);
    const note = selectionNote({ tracked: scope.projects });
    if (note !== lastNote) {
      if (note) log('nothing to read', { note });
      else log('reading projects', { projects: scope.projects });
      lastNote = note;
    }
  }

  /** Forget the reads of folders whose data was deleted, so selecting them again reads their history again. */
  async function forgetDeletedReads() {
    const memRoots = await memDeps.roots();
    const dropped = await forgetDeleted({
      selection,
      state,
      legacyKeys: (path, kind) => {
        if (kind === 'memory') {
          const k = memoryProjectKey(path, transcripts, memRoots);
          return k ? [k] : null;
        }
        const f = folderOf.get(path);
        return f == null ? null : typeof f === 'string' ? [f] : f;
      },
    });
    if (dropped) log('forgot reads of deleted projects, read again when selected', { files: dropped });
  }

  /** The candidate list for Settings, from file heads (cached), and each file's folder for the ingest prefilter. */
  async function refreshCandidates() {
    const codexFound = !!(await lstat(config.codexSessionsDir).catch(() => null))?.isDirectory();
    if (!codexFound && !codexMissingLogged) log('no Codex sessions folder; carrying on without Codex sessions', { dir: config.codexSessionsDir });
    codexMissingLogged = !codexFound;
    try {
      const built = await buildCandidates({
        roots,
        files: (await cycleDeps.listFiles()).map((f) => ({ ...f, source: f.source ?? 'claude' })),
        state,
        codexSessionsFound: codexFound,
        remote: cycleDeps.remote,
        cloneOf: async (f) => (await repo.canonicalProject({ key: f.key, name: f.key, repoPath: f.repoPath, remote: f.remote }, { dryRun: true })).project.key,
      });
      folderOf = built.folderOf;
      const { folderOf: _, ...snapshot } = built;
      await selection.saveCandidates(snapshot);
    } catch (err) {
      log('candidate list failed', { error: String(err) });
    }
  }

  while (!stopping) {
    try {
      await refreshScope();
      mapStage.kick();
      await refreshCandidates();
      await forgetDeletedReads();
      if (githubDeps) {
        const g = await syncGithub(githubDeps);
        if (g.prs) log('github synced', g);
      }
      const imported = await importMemories(memDeps);
      if (imported) log('memory lessons imported', { imported });
      await retention();
      // Keep going without sleeping while there is still work: backfill, post-mortems, scans.
      let progressed;
      do {
        await refreshScope();
        // Beside the loop, never awaited by it: a slow or retrying cloud must not hold up ingest (or a long backfill
        // hold up the sync).
        void cloudSchedule?.tick();
        await forgetDeletedReads();
        // Work you asked for (scans, confirmed feedback) runs before the history backfill.
        const scanned = await scanOne();
        const pm: Awaited<ReturnType<typeof runPostmortems>> = pmDeps ? await runPostmortems(pmDeps) : { done: 0, failed: 0 };
        const { classifierUnavailable, ...r } = await runCycle(cycleDeps);
        log('cycle', { ...r, postmortems: pm.done, postmortemFailures: pm.failed, scanned, classifierUnavailable, postmortemUnavailable: pm.unavailable });
        status.lastCycleAt = new Date().toISOString();
        status.lastCycle = { ...r, postmortems: pm.done, postmortemFailures: pm.failed, scanned };
        status.lastError = classifierUnavailable ? `classifier unavailable: ${classifierUnavailable}`
          : pm.unavailable ? `post-mortem model unavailable: ${pm.unavailable}` : null;
        // Failures back off on their own schedule; only real progress keeps the loop from sleeping.
        progressed = r.turnsClassified > 0 || pm.done > 0 || scanned;
      } while (progressed && !stopping);
    } catch (err) {
      status.lastError = redactSecrets(String(err)).slice(0, 500);
      log('cycle failed', { error: status.lastError });
    }
    if (stopping) break;
    await new Promise<void>((res) => {
      wake = res;
      setTimeout(res, config.pollSeconds * 1000);
    });
    wake = null;
  }
  state.close();
  await store.close();
  log('stopped');
  process.exit(0);
}

main().catch((err) => {
  log('fatal', { error: err instanceof ConfigError ? err.message : redactSecrets(String(err)) });
  process.exit(1);
});
