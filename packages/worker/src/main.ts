import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  ConfigError, fetchPullRequestContext, projectFolders, refreshLayout, relOfKey, killRunningCommands, loadConfig, makeProvider, ollamaEmbed, projectScope, providerUnavailableReason, ProviderUnavailableError, redactSecrets, runCloudSync, syncProjects,
  credentialFile, fetchLinearComments, Integrations, searchLinearIssues, selectionNote, storedSyncMemory, touchedAround, VERSION, withHealth, type KnowledgeStore, type LlmProvider, type ModelJob, type ProjectScope, type ScanJob, type SyncMemory, type WorkerStatus,
} from '@fb/core';
import { openStore } from '@fb/store-postgres';
import { answerTurn } from './chat/answer.ts';
import { chatSpec, codexLoggedIn, defaultChatSpec, type ChatSpecOpts } from './chat/provider.ts';
import { ChatRunner, sharesModel } from './chat/runner.ts';
import { CloudSyncSchedule } from './cloud/schedule.ts';
import { EDITED_PATHS_LIMIT, MapStage } from './codegraph/stage.ts';
import { runCycle, type FileInfo } from './cycle.ts';
import { classifyTurn } from './detect/classify.ts';
import { codexSessionFiles } from './ingest/codex.ts';
import { cachedRemote, commitsInWindow, projectRemote, worktreeGitArgs } from './ingest/git.ts';
import { readLines } from './ingest/lines.ts';
import { buildCandidates } from './projects/candidates.ts';
import { importMemories, memoryProjectKey } from './memory/memory.ts';
import { forgetDeleted } from './forget.ts';
import { loadStandingContext, memoryDirFor, runPostMortem } from './postmortem/postmortem.ts';
import { huntContext } from './postmortem/hunt.ts';
import { syncGithub } from './integrations/githubSync.ts';
import { githubTarget, syncExternalFeedback, type SyncProject } from './integrations/feedbackSync.ts';
import { attachWorkSession } from './postmortem/work.ts';
import { repoHas } from './postmortem/paths.ts';
import { recheckProposedLessons } from './postmortem/recheck.ts';
import { runPostmortems } from './postmortem/step.ts';
import { ScanRunner } from './scan/runner.ts';
import { hasCodeFiles, runScan } from './scan/scan.ts';
import { scoreFacts, ScoringPacer } from './relevance/score.ts';
import { runLinkDetection } from './links/stage.ts';
import { readOneDoc } from './docs/read.ts';
import { SummarizeStage } from './summarize/stage.ts';
import { FileState } from './state.ts';
import { healthSince, StageTracker } from './progress.ts';

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

/** Providers that explore the repo themselves (LlmProvider.agentic): their scans run one at a time. */
const AGENTIC_SPEC = /^(claude-cli|codex-cli)(:|$)/;

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
const STAGE_BEAT_MS = 3_000;
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
  await docs.requeueStaleDocs();
  // Lessons proposed before their checks were stored get them once (flags only; a failure waits for the next start).
  await recheckProposedLessons({ k: knowledge, activity, log }).catch((err) => log('lesson re-check failed', { error: String(err) }));

  const transcripts = config.transcriptsDir;
  const roots = config.roots;
  const localModel = `ollama:${config.ollama.model}`;
  const embed = (input: string[]) => ollamaEmbed({ url: config.ollama.url, model: config.ollama.embedModel, input });

  // Each job's model reports whether it answers, so /api/status (and the sidebar badge) can say which one is down.
  const health: NonNullable<WorkerStatus['health']> = {};
  const tracked = (job: ModelJob, p: LlmProvider | null) => p && withHealth(p, (h) => { health[job] = healthSince(health[job], h); });
  const classifier = tracked('classify', provider('classify', config.llm.classify ?? localModel));
  const postmortemLlm = tracked(
    'postmortem',
    provider('postmortem', config.llm.postmortem ?? (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'claude-cli' : localModel)) ??
      provider('postmortem (fallback)', localModel),
  );
  const defaultScan = config.llm.scan ?? localModel;
  // Reads your uploads (documents and images) into facts; images need a model with vision.
  const docsLlm = tracked('docs', provider('docs', config.llm.docs ?? defaultScan));
  // An unavailable summary model only pauses summaries; /api/status and the badge say so. SUMMARY_LLM=off is reported as off.
  const summaryLlm = config.summary.enabled ? tracked('summary', provider('summary', config.summary.llm ?? localModel)) : null;
  // Ask: CHAT_LLM, else claude-cli with a Claude token, else codex-cli with a Codex login, else the local model. A chat
  // may pick another provider; the Codex login is looked at again per answer (it can be added without a restart).
  const chatOpts = (): ChatSpecOpts => ({ chatLlm: config.llm.chat, localModel, env: process.env, codexLogin: codexLoggedIn(process.env) });
  const defaultChat = defaultChatSpec(chatOpts());
  log('chat', { default: defaultChat });
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
    providers: { classify: classifier?.id ?? null, postmortem: postmortemLlm?.id ?? null, scan: defaultScan, summary: summaryLlm?.id ?? null, docs: docsLlm?.id ?? null, chat: defaultChat },
    health,
    off: config.summary.enabled ? [] : ['summary'],
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
  // The step running now (/api/status stage and progress): a change beats within a few seconds, not at the next beat.
  let soon: NodeJS.Timeout | null = null;
  const stage = new StageTracker(status, () => {
    soon ??= setTimeout(() => { soon = null; beat(); }, STAGE_BEAT_MS);
  });

  let stopping = false;
  let wake: (() => void) | null = null;
  /** MapStage.stop, once the stage exists (a signal can come before that). */
  let stopMapStage: (() => Promise<void>) | null = null;
  /** ScanRunner.stop, likewise: nothing new starts once shutdown begins. */
  let stopScans: (() => Promise<void>) | null = null;
  /** ChatRunner.stop, likewise. */
  let stopChats: (() => Promise<void>) | null = null;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('shutting down', { signal });
    clearInterval(beater);
    if (soon) clearTimeout(soon);
    killRunningCommands(); // detached CLI agents would otherwise outlive the worker
    // Abandons a map being parsed now; the loop below waits for one being written before the store closes.
    void stopMapStage?.();
    void stopScans?.();
    void stopChats?.();
    wake?.();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('exit', killRunningCommands);

  // The classify step's size: the turns waiting (as fetched, so capped), and the model calls this cycle may make.
  const stagedRepo = new Proxy(repo, {
    get(target, key) {
      if (key === 'unclassifiedTurns') {
        return async (...args: Parameters<typeof repo.unclassifiedTurns>) => {
          const turns = await target.unclassifiedTurns(...args);
          status.backlog = { classify: turns.length, classifyCapped: turns.length >= args[0], at: new Date().toISOString() };
          stage.enter('classify', { total: Math.min(turns.length, config.classifyBatch) });
          return turns;
        };
      }
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  const cycleDeps = {
    listFiles: async () => {
      stage.enter('ingest');
      return [...(await listTranscripts(transcripts)), ...(await codexSessionFiles(config.codexSessionsDir)).map((f) => ({ ...f, source: 'codex' as const }))];
    },
    readFile: (p: string) => {
      stage.step(basename(p));
      return readFile(p, 'utf8');
    },
    readLines: (p: string) => {
      stage.step(basename(p));
      return readLines(p);
    },
    folderOf: (p: string) => folderOf.get(p),
    state,
    repo: stagedRepo,
    roots,
    commits: commitsInWindow,
    // No classifier (it could not be built) is unavailability too: turns wait for one instead of being charged.
    classify: async (t: Parameters<typeof classifyTurn>[0]) => {
      if (!classifier) throw new ProviderUnavailableError('no classifier could be built (see the provider log line at startup)');
      stage.step(t.uuid);
      return classifyTurn(t, classifier, (error) => log('classification failed', { turn: t.uuid, error }));
    },
    classifyBatch: config.classifyBatch,
    // Scans and Ask answers run beside the cycle and may hold the same model; a classify timeout meanwhile is a queue, not the turn.
    modelBusy: () => scanRunner.running().length > 0 || sharesModel(chatRunner.running(), classifier?.id),
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
    // Records a scan or a code map made have no folder: the backfill reads it (and its remote) from the selection.
    folders: () => selectedFolders(),
    codegraph: store.codegraph,
  };

  // GitHub and Linear: a token in .env, else one pasted in Settings (re-read every cycle, so connecting needs no restart).
  const integrations = new Integrations(docs, process.env, config.integrationsFile ? credentialFile(config.integrationsFile) : null);
  let linearKey: string | null = null;

  const pmDeps = postmortemLlm && {
    k: knowledge,
    modelBusy: () => scanRunner.running().length > 0 || sharesModel(chatRunner.running(), postmortemLlm.id),
    // A comment from GitHub or Linear is worked out against the agent session that did the work, when one is found.
    postmortem: async (raw: Parameters<typeof runPostMortem>[0]) => {
      stage.enter('postmortem', { current: raw.feedbackId });
      const input = await attachWorkSession(raw, {
        graph: repo,
        sessions: store.sessions,
        files: (id) => store.codegraph.sessionFiles(id),
      });
      return runPostMortem(input, {
        llm: postmortemLlm,
        touched: async (i) => touchedAround(await store.codegraph.sessionFiles(i.sessionId), i.feedback.ts),
        sessionSummary: async (i) => (await store.sessions.detail(i.sessionId))?.summary?.markdown ?? null,
        // Lesson paths must exist in the repository (postmortem/paths.ts).
        exists: (i, p) => repoHas(i.repoPath, p),
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
            linear: linearKey ? { apiKey: linearKey, search: searchLinearIssues } : undefined,
            log,
          }),
      });
    },
    embed,
    batch: 1,
    log,
    activity,
  };

  const memDeps = {
    transcriptsDir: transcripts,
    roots: async () => {
      const folders = await projectFolders(roots);
      return roots.map((r) => ({ host: r.host, keys: folders.filter((f) => f.root === r).map((f) => f.rel) }));
    },
    includeProject: (k: string) => scope.folder(k),
    state,
    embed,
    upsertLesson: (l: Parameters<KnowledgeStore['upsertLesson']>[0]) => knowledge.upsertLesson(l),
    activity,
    autoApprove: config.memoryAutoApprove,
  };

  /** The folders of the selected projects, under the first root that has them (plain directories only, nested repos too). */
  async function selectedFolders(): Promise<{ key: string; repoPath: string }[]> {
    const out: { key: string; repoPath: string }[] = [];
    for (const key of scope.projects) {
      for (const r of roots) {
        const repoPath = join(r.container, relOfKey(key, r));
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
    // Files your sessions edited are kept first when the map is capped: they are where the next miss happens.
    editedPaths: (key) => store.codegraph.editedPaths(key, EDITED_PATHS_LIMIT),
    // A worktree's .git names its git dir by the host path: reach it through the roots mapping.
    gitArgs: (repoPath) => worktreeGitArgs(repoPath, roots),
    log,
    exclusive: <T>(fn: () => Promise<T>) => selection.exclusive(fn),
    inScope: async (key: string) => (await selection.scope(config)).project(key),
  });
  stopMapStage = () => mapStage.stop();

  // Running summaries of the selected projects' sessions, beside ingest (never awaited by it).
  const summarizeStage = config.summary.enabled
    ? new SummarizeStage({
        sessions: store.sessions,
        llm: summaryLlm,
        activity,
        projects: () => scope.projects,
        excludeProjects: config.excludeProjects,
        quietMinutes: config.summary.quietMinutes,
        idleMinutes: config.summary.idleMinutes,
        maxDeltaTurns: config.summary.maxDeltaTurns,
        backfillPerCycle: config.summary.backfillPerCycle,
        log,
      })
    : null;
  const { llm: _summarySpec, ...summarySettings } = config.summary;
  log('session summaries', config.summary.enabled ? { ...summarySettings, provider: summaryLlm?.id ?? null } : { enabled: false });

  // Facts stored before relevance existed are scored by the scan model, a batch at a time, when nothing else is waiting.
  // Not health-tracked: a scoring hiccup must not mark the scan model down.
  const scorer = provider('relevance', defaultScan);
  const scoring = scorer
    ? new ScoringPacer(async () => {
        try {
          return await scoreFacts({ facts, llm: scorer, projects: () => scope.projects, activity, log });
        } catch (err) {
          log('relevance scoring failed', { error: redactSecrets(String(err)) });
          throw err;
        }
      }, 10 * 60_000)
    : null;
  const scoreSome = () => scoring?.tick() ?? Promise.resolve(0);

  // Links between the selected projects, from evidence in them (no model), every LINK_SCAN_MINUTES.
  let linksAt = 0;
  let linksRunning = false;
  /** Beside the loop, never awaited by it: a round over many projects must not hold up ingest, scans or uploads. */
  function detectLinksSometimes() {
    if (linksRunning || Date.now() - linksAt < config.linkScanMinutes * 60_000) return;
    linksAt = Date.now();
    linksRunning = true;
    void detectLinksRound()
      .catch((err) => log('link detection failed', { error: redactSecrets(String(err)) }))
      .finally(() => { linksRunning = false; });
  }
  async function detectLinksRound() {
    const remotes = new Map((await facts.listProjects()).map((p) => [p.key, p.remote]));
    const r = await runLinkDetection({
      links: store.links,
      // A record a scan or code map made has no remote until the next cycle fills it: read the folder's own then.
      projects: async () => Promise.all((await selectedFolders()).map(async (p) => ({ ...p, remote: remotes.get(p.key) ?? (await cycleDeps.remote(p.repoPath)) }))),
      activity,
    });
    log('links detected', r);
  }

  /**
   * One upload read into facts; true when one was read (so the loop keeps going). Uploads skipped (a project not
   * selected, replaced while picked, failed) are passed over in the same cycle, a few at most, unless the model is down.
   */
  async function readDocOne(): Promise<boolean> {
    if (!docsLlm) return false;
    stage.enter('docs');
    for (let i = 0; i < 5; i++) {
      const r = await readOneDoc({ docs, llm: docsLlm, embed, inScope: async (key) => scope.project(key), activity, log }).catch((err) => {
        log('document reading failed', { error: redactSecrets(String(err)) });
        return null;
      });
      if (!r || r.read || r.unavailable) return !!r?.read;
    }
    return false;
  }

  /** Run one claimed scan job to its end; true when it finished (done or failed), false when it went back to wait. */
  async function scanJob(job: ScanJob): Promise<boolean> {
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
    const touched = (key: string) => store.codegraph.editedPaths(key, EDITED_PATHS_LIMIT);
    const r = await runScan(job, { facts, llm, embed, maxBytes: config.scanMaxBytes, maxFiles: config.scanMaxFiles, touched, log, activity }).catch((err) => {
      unavailable = providerUnavailableReason(err);
      if (unavailable) log('scan model unavailable, the scan stays queued', { project: job.projectKey, reason: unavailable });
      else log('scan failed', { project: job.projectKey, error: redactSecrets(String(err)) });
      return null;
    });
    if (r) log('scan done', { project: job.projectKey, ...r });
    // Back in the queue waiting out its retryAt (a failure or an unreachable model): not progress, so the loop sleeps.
    return !!r;
  }

  // Scans run beside the cycle, SCAN_CONCURRENCY at once (agentic ones one at a time), not one per cycle.
  const scanRunner = new ScanRunner({
    next: (exclude) => facts.nextScanJob(new Date(), exclude),
    agentic: (job) => AGENTIC_SPEC.test(job.provider || defaultScan),
    empty: async (job) => !(await hasCodeFiles(job.repoPath)),
    run: scanJob,
    concurrency: config.scanConcurrency,
    log,
  });
  stopScans = () => scanRunner.stop();

  // Ask answers, beside the cycle: the oldest pending question every 2 s, one at a time, with its chat's model.
  const chatRunner = new ChatRunner({
    store: store.chats,
    provider: (conversation) => {
      const spec = chatSpec(conversation.provider, chatOpts());
      let reason = '';
      const p = provider('chat', spec, (r) => (reason = r));
      // Only the default model reports to /api/status: a chat's own pick failing is shown on its turn.
      return { llm: spec === defaultChat ? tracked('chat', p) : p, spec, reason: reason || undefined };
    },
    answer: answerTurn,
    log,
  });
  stopChats = () => chatRunner.stop();
  await chatRunner.start();
  log('scans', { concurrency: config.scanConcurrency, maxFiles: config.scanMaxFiles ?? 'scales with the repo' });

  /** The selected projects with their remotes: the only ones whose PRs and issues are read. */
  async function syncProjectsList(): Promise<SyncProject[]> {
    return Promise.all((await selectedFolders()).map(async (f) => ({ key: f.key, name: f.key, repoPath: f.repoPath, remote: await cycleDeps.remote(f.repoPath) })));
  }

  /** PR discussions as project context (docs), every GITHUB_SYNC_HOURS, for every selected project linked to a repository. */
  async function syncGithubDocs() {
    const cred = await integrations.credential('github');
    if (!cred) return;
    const repos = new Map<string, string>();
    for (const p of await syncProjectsList()) {
      const target = (await integrations.link(p.key)).github ? githubTarget(p, config.github.repos) : null;
      if (target) repos.set(p.key, target);
    }
    const g = await syncGithub({ repos, token: cred.token, fetchPrs: fetchPullRequestContext, docs, embed, activity, minIntervalMs: config.github.syncHours * 3600_000, log });
    if (g.prs) log('github synced', g);
  }

  /** Review comments and Linear comments into the Inbox (see feedbackSync.ts). */
  async function syncFeedback() {
    linearKey = (await integrations.credential('linear'))?.token ?? null;
    const r = await syncExternalFeedback({
      integrations,
      graph: repo,
      cursors: docs,
      projects: syncProjectsList,
      githubOverride: config.github.repos,
      botLogins: config.github.botLogins,
      agentLogins: config.github.agentLogins,
      fetchPrs: fetchPullRequestContext,
      fetchLinear: fetchLinearComments,
      activity,
      minIntervalMs: config.integrationSyncMinutes * 60_000,
      log,
    });
    if (r.github || r.linear) log('comments synced', r);
  }
  log('integrations', { github: integrations.envSet('github') ? 'env' : 'settings', linear: integrations.envSet('linear') ? 'env' : 'settings', overrides: [...config.github.repos.keys()], everyMinutes: config.integrationSyncMinutes });

  // Feedback Graph Cloud: off (and nothing is sent) unless CLOUD_URL and CLOUD_TOKEN are set.
  const cloud = config.cloud;
  // In the store, so it survives a restart and is the same record the api's Sync now uses.
  const memory: SyncMemory | null = cloud && storedSyncMemory(store.docs, cloud);
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
            memory: memory ?? undefined,
          }),
      })
    : null;
  status.cloudSync = cloudSchedule?.status ?? null;
  log('cloud sync', cloud ? { enabled: true, host: new URL(cloud.url).host, intervalMinutes: cloud.intervalMinutes, projects: cloud.projects } : { enabled: false });

  let lastRetention = 0;
  async function retention() {
    if (!config.turnRetentionDays || Date.now() - lastRetention < RETENTION_EVERY_MS) return;
    lastRetention = Date.now();
    // While summaries are on, a turn keeps its text until a summary covers it (summaries themselves are never pruned).
    const pruned = await repo.pruneTurnText(new Date(Date.now() - config.turnRetentionDays * 86_400_000), undefined, { keepUnsummarized: config.summary.enabled });
    if (pruned) log('retention: removed text of old unflagged turns', { pruned, days: config.turnRetentionDays });
  }

  /** Re-read the selection: it changes from Settings at any time, including during a long backfill. */
  async function refreshScope() {
    scope = await selection.scope(config);
    cycleDeps.onlyProjects = scope.projects;
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

  /**
   * Which folders are projects: top-level folders, and the git repos nested in a folder that is not one. A top-level
   * folder already selected or excluded as a whole stays one project. In place, so ingest, memory import and the map
   * stage (which hold these roots) see the same layout.
   */
  async function refreshProjectLayout() {
    const whole = new Set([...scope.projects, ...config.excludeProjects]);
    try {
      await refreshLayout(roots, { keepWhole: (k) => whole.has(k) });
    } catch (err) {
      log('project layout failed', { error: String(err) });
    }
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
        hostHome: config.hostHome ?? undefined,
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
      await refreshProjectLayout();
      mapStage.kick();
      await refreshCandidates();
      await forgetDeletedReads();
      // Each fails on its own: GitHub or Linear being down never holds up reading transcripts.
      stage.enter('sync');
      await syncGithubDocs().catch((err) => log('github sync failed', { error: redactSecrets(String(err)) }));
      await syncFeedback().catch((err) => log('comment sync failed', { error: redactSecrets(String(err)) }));
      detectLinksSometimes();
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
        // Work you asked for (scans, confirmed feedback) runs before the history backfill; scans run beside it.
        scanRunner.kick();
        const scanned = scanRunner.running().length;
        // Your uploads, like scans, are work you asked for.
        const docRead = await readDocOne();
        const pm: Awaited<ReturnType<typeof runPostmortems>> = pmDeps ? await runPostmortems(pmDeps) : { done: 0, failed: 0 };
        const { classifierUnavailable, ...r } = await runCycle(cycleDeps);
        summarizeStage?.kick();
        log('cycle', { ...r, postmortems: pm.done, postmortemFailures: pm.failed, scanned, classifierUnavailable, postmortemUnavailable: pm.unavailable });
        status.lastCycleAt = new Date().toISOString();
        status.lastCycle = { ...r, postmortems: pm.done, postmortemFailures: pm.failed, scanned };
        status.lastError = classifierUnavailable ? `classifier unavailable: ${classifierUnavailable}`
          : pm.unavailable ? `post-mortem model unavailable: ${pm.unavailable}` : null;
        // Last in line: only when this round had nothing else to do.
        const scored = r.turnsClassified > 0 || pm.done > 0 || docRead ? 0 : await scoreSome();
        // Failures back off on their own schedule; only real progress keeps the loop from sleeping. Scans are not
        // counted: they run beside the loop and refill their own slots as they finish.
        progressed = r.turnsClassified > 0 || pm.done > 0 || docRead || scored > 0;
      } while (progressed && !stopping);
    } catch (err) {
      status.lastError = redactSecrets(String(err)).slice(0, 500);
      log('cycle failed', { error: status.lastError });
    }
    if (stopping) break;
    stage.enter('waiting');
    await new Promise<void>((res) => {
      wake = res;
      setTimeout(res, config.pollSeconds * 1000);
    });
    wake = null;
  }
  await scanRunner.stop();
  await chatRunner.stop();
  await mapStage.stop();
  state.close();
  await store.close();
  log('stopped');
  process.exit(0);
}

main().catch((err) => {
  log('fatal', { error: err instanceof ConfigError ? err.message : redactSecrets(String(err)) });
  process.exit(1);
});
