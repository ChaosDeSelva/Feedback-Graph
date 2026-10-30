import { githubBudgetFetch } from './integrations/githubBudget.ts';
import { setRedactionArchive, setRedactionArchivePurger } from '@fb/core';
import { encryptedRedactionArchive } from './redactionArchive.ts';
import { cloudLocalOnlyProjects, cloudSharedDemoProjects } from '@fb/core';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  runnerReadiness, RUNNER_READINESS_CURSOR, ConfigError, purgeAgentMirrors, fetchPullRequestContext, projectFolders, refreshLayout, killRunningCommands, loadConfig, makeProvider, ollamaEmbed, projectScope, providerUnavailableReason, ProviderUnavailableError, redactSecrets, runCloudSync, syncProjects,
  credentialFile, fetchLinearIssues, Integrations, searchLinearIssues, selectionNote, storedSyncMemory, touchedAround, VERSION, withHealth, type KnowledgeStore, type LlmProvider, type ModelJob, type ProjectScope, type ScanJob, type SyncMemory, type WorkerStatus,
} from '@fb/core';
import { openStore } from '@fb/store-postgres';
import { answerTurn } from './chat/answer.ts';
import { chatSpec, codexLoggedIn, defaultChatSpec, type ChatSpecOpts } from './chat/provider.ts';
import { ChatRunner, laneOf, sharesModel } from './chat/runner.ts';
import { CloudSyncSchedule } from './cloud/schedule.ts';
import { EDITED_PATHS_LIMIT, MapStage } from './codegraph/stage.ts';
import { runCycle, type FileInfo } from './cycle.ts';
import { classifyTurn } from './detect/classify.ts';
import { codexSessionFiles } from './ingest/codex.ts';
import { cachedRemote, commitsInWindow, projectRemote, worktreeGitArgs } from './ingest/git.ts';
import { readLines } from './ingest/lines.ts';
import { buildCandidates } from './projects/candidates.ts';
import { containerFolders } from './projects/folders.ts';
import { memoryWriteLookup, importMemories, memoryProjectKey } from './memory/memory.ts';
import { forgetDeleted } from './forget.ts';
import { loadStandingContext, memoryDirFor, runPostMortem } from './postmortem/postmortem.ts';
import { examplePool } from './postmortem/examples.ts';
import { backfillProposedAs } from './postmortem/proposedAs.ts';
import { huntContext } from './postmortem/hunt.ts';
import { syncGithub } from './integrations/githubSync.ts';
import { githubTarget, syncExternalFeedback, type SyncProject } from './integrations/feedbackSync.ts';
import { skipPendingOnRulesChange } from './integrations/pendingSkips.ts';
import { redactStoredOnRuleChange } from './redactStored.ts';
import { resolvePendingInstructions } from './detect/pendingInstructions.ts';
import { sortOldMisses } from './postmortem/subjects.ts';
import { attachWorkSession } from './postmortem/work.ts';
import { repoFileList, repoHas } from './postmortem/paths.ts';
import { recheckLessons, recordedWorkSession } from './postmortem/recheck.ts';
import { rematchOnRuleChange } from './postmortem/rematch.ts';
import { sessionEvidence } from './postmortem/standing.ts';
import { providerAnswers, runPostmortems } from './postmortem/step.ts';
import { migrateDeciderRule } from './postmortem/deciders.ts';
import { parkScanProvider, ScanRunner, type ScanTurn } from './scan/runner.ts';
import { recheckFacts } from './scan/recheck.ts';
import { forgetDataFiles } from './scan/data.ts';
import { hasCodeFiles, runScan, ScanPlans } from './scan/scan.ts';
import { scoreFacts, ScoringPacer } from './relevance/score.ts';
import { runLinkDetection } from './links/stage.ts';
import { readOneDoc } from './docs/read.ts';
import { SummarizeStage } from './summarize/stage.ts';
import { CODEX_COPY_RULE, FileState, INGEST_VERSION } from './state.ts';
import { SessionEvidenceGate } from './evidence.ts';
import { cycleProgressed, healthSince, StageTracker } from './progress.ts';

await purgeAgentMirrors();

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
/** GitHub review comments read per scan for the files they are on (scan order hotspots). */
const PR_PATHS_LIMIT = 500;

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
  // Lessons whose checks are older than the current ones (or that `fg lessons recheck` marked) get today's checks: flags
  // only, logged in Activity. At start and each round once the session evidence they read is current (evidence.ts: not
  // before an ingest version bump's re-read), a cheap query when there is nothing to do; a failure waits.
  const recheckOld = () =>
    recheckLessons({
      k: knowledge, activity, log,
      // Lesson paths are checked against the repository as mounted here, under the container side of the roots (the
      // stored repoPath is the host's, not there in Docker); a project under no root is not judged (repoHas).
      repoPaths: async () => new Map((await containerFolders((await facts.listProjects()).map((p) => p.key), config.roots)).map((p) => [p.key, p.repoPath])),
      // What the session's transcript showed its agent had: a miss blaming a file it "did not load" is checked against it.
      instructionFiles: (id) => repo.sessionInstructionFiles(id),
      // The session a comment's post-mortem used (none, or matched by branch or files): its miss is not read for wrong-session.
      workSession: recordedWorkSession(activity),
      // A ticket is the project's when it holds it or its PRs name it, or it is from a team whose tickets it holds.
      linkedTickets: async (key, ids) => {
        const held = new Set(await docs.projectTickets({ projectKey: key, ids }));
        const teams = new Set((await docs.listDocs(key)).filter((x) => x.source === 'linear').map((x) => x.ref.replace(/^linear:/, '').split('-')[0]));
        return ids.filter((id) => held.has(id) || teams.has(id.split('-')[0]));
      },
    });
  // What reads session evidence (the instruction rule, the lesson re-check, the session re-match, post-mortems) runs
  // after the transcripts are read at the current INGEST_VERSION, never on the evidence of the one before (evidence.ts).
  const evidence = new SessionEvidenceGate({
    ingestVersion: INGEST_VERSION,
    cursors: docs,
    // The instruction rule ("don't push a PR yet" is not pushback) once per version over what was stored before it, and
    // again once the calls after each instruction are read again.
    instructions: () =>
      resolvePendingInstructions({ graph: repo, cursors: docs, activity, log, ingestVersion: INGEST_VERSION })
        .then((n) => { if (n !== null) log('instruction rule applied to pending Inbox items', n); }),
    requestLessonRecheck: knowledge.requestLessonRecheck?.bind(knowledge),
    recheck: recheckOld,
    // The session-matching rule (a comment's session ran on its PR's branch or edited the files it changed, never the
    // nearest in time): pending comments are matched again and proposed lessons built on a session it would not match
    // are flagged, once per version, after the lesson re-check so its flags are kept.
    rematch: () =>
      rematchOnRuleChange({ graph: repo, knowledge, files: (id) => store.codegraph.sessionFiles(id), cursors: docs, activity, log })
        .then((n) => { if (n !== null) log('session-matching rule applied to stored comments', n); }),
    log: (msg, extra) => log(msg, extra && 'error' in extra ? { ...extra, error: redactSecrets(String(extra.error)) } : extra),
  });

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
  // The Codex copy rule changed: its rollouts are read once more, and a session the old rule froze is logged as resumed.
  const codexRequeued = state.migrateCodexCopyRule(config.codexSessionsDir);
  if (codexRequeued) log('codex copy rule changed: Codex sessions are read again', { files: codexRequeued, rule: CODEX_COPY_RULE });

  // The owner picks the folders to read (Settings). Until a choice is made, INGEST_PROJECTS seeds it, or nothing does.
  const seeded = await selection.ensure(config, activity);
  log('project selection', { tracked: seeded.selection.tracked, initialized: seeded.selection.initialized, seededNow: seeded.seeded, excluded: config.excludeProjects, localOnlyForCloud: await cloudLocalOnlyProjects(store.docs, config.cloud?.localOnlyProjects) });
  if (!seeded.seeded && config.ingestProjects.length && config.ingestProjects.join(',') !== seeded.selection.tracked.join(',')) {
    log('INGEST_PROJECTS only seeds a selection not made yet; the projects read are the ones chosen in Settings', { ingestProjects: config.ingestProjects });
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
          status.backlog = { classify: turns.length, classifyCapped: turns.length >= args[0], at: new Date().toISOString(), oldestAt: turns.at(-1)?.ts ?? null };
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
    modelBusy: () => scanRunner.running().length > 0 || chatRunner.running().some((p) => sharesModel(p, classifier?.id)),
    log,
    classifierId: classifier?.id,
    includeProject: (k: string) => scope.folder(k),
    // Each transcript is written under the store's lock, against the selection as stored then (cleanup can run mid-cycle).
    scopeNow: () => selection.scope(config),
    exclusive: <T>(fn: () => Promise<T>) => selection.exclusive(fn),
    onlyProjects: scope.projects,
    excludeProjects: config.excludeProjects.length ? config.excludeProjects : undefined,
    activity,
    storedTurns: async (id: string) => (await store.sessions.detail(id))?.turnCount ?? null,
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
    // Kept across cycles: one feedback that reads as "model unavailable" every time is charged after a few (step.ts).
    unavailableStreak: { feedbackId: null as string | null, count: 0 },
    // A cycle counts toward that only when the provider answers a neutral ask: an outage never uses up attempts.
    providerHealthy: () => providerAnswers(postmortemLlm),
    modelBusy: () => scanRunner.running().length > 0 || chatRunner.running().some((p) => sharesModel(p, postmortemLlm.id)),
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
        // The owner's latest decisions on this project's lessons only (never another project's, never a sandbox run's),
        // each outcome from its own newest, scored against this feedback so the closest are shown (postmortem/examples.ts).
        examples: async (i) => {
          if (!knowledge.decidedLessons) return [];
          const [embedding] = await embed([i.feedback.text.slice(0, 2000)]);
          return examplePool((q) => knowledge.decidedLessons!(q), { projectKeys: [i.projectKey], since: new Date(0).toISOString(), embedding });
        },
        // Lesson paths must exist in the repository (postmortem/paths.ts).
        exists: (i, p) => repoHas(i.repoPath, p),
        // A bare file name in a lesson resolves to its one match in the repository (postmortem/paths.ts).
        repoFiles: (i) => repoFileList(i.repoPath),
        // Instruction files from the repo up to its project root (the mount: nothing above it is visible here), each
        // loaded as the agent loads it or as its transcript shows it had (ingest/instructions.ts).
        standing: async (i) =>
          loadStandingContext({
            repoPath: i.repoPath,
            stopAt: roots.find((r) => i.repoPath.startsWith(`${r.container}/`))?.container ?? dirname(i.repoPath),
            memoryDir: memoryDirFor(transcripts, i.cwd),
            before: i.feedback.ts,
            source: i.source,
            evidence: sessionEvidence(i, await repo.sessionInstructionFiles(i.work?.sessionId ?? i.sessionId).catch(() => null)),
            roots,
          }),
        log,
        facts: async (i) =>
          huntContext(i, {
            embed,
            facts,
            docs,
            // Workspace-wide search, kept to the tickets of the team mapped to this project or named by its PRs (hunt.ts).
            linear: linearKey ? { apiKey: linearKey, teamId: (await integrations.link(i.projectKey).catch(() => null))?.linearTeamId ?? null, search: searchLinearIssues } : undefined,
            log,
          }),
      });
    },
    embed,
    batch: 1,
    log,
    activity,
  };

  const memoryWrites = memoryWriteLookup(repo);
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
    beginCorrelation: () => memoryWrites.reset(),
    runForWrite: (projectKey: string, path: string) => repo.memoryWriteRun?.(projectKey, path) ?? Promise.resolve(null),
    writtenAfterFeedback: (projectKey: string, path: string) => memoryWrites.find(projectKey, path),
    withdrawDuplicate: async (id: string, feedbackId: string | null) => {
      const detail = await knowledge.lessonDetail(id);
      const lesson = detail?.lesson;
      if (!lesson || lesson.source !== 'memory' || lesson.status === 'rejected' || lesson.status === 'superseded' || lesson.status === 'revoked') return;
      if (lesson.status === 'proposed' && !lesson.decidedAt && !lesson.proposedAs) {
        await knowledge.updateLesson(id, { status: 'rejected' }, { by: 'memory-deduplication', note: 'the agent wrote this memory after feedback already represented in the Inbox' });
      } else if (!(lesson.checks ?? []).some((check) => check.name === 'duplicate-of')) {
        await knowledge.setLessonChecks(id, [...(lesson.checks ?? []), { name: 'duplicate-of', why: 'This memory was written after the same feedback event; review this existing lesson rather than learning it twice.', ...(feedbackId && { of: `lesson:${feedbackId}` }) }]);
      } else return;
      await activity.record({ kind: 'lesson_decided', actor: 'memory-deduplication', projectKey: lesson.projectKey,
        subject: `duplicate feedback memory: ${lesson.title}`, why: 'the persisted agent session wrote this memory after an Inbox feedback event', targets: [id, ...(feedbackId ? [feedbackId] : [])] });
    },
  };

  /** The folders of the selected projects, under the first root that has them (plain directories only, nested repos too). */
  function selectedFolders(): Promise<{ key: string; repoPath: string }[]> {
    return containerFolders(scope.projects, roots);
  }

  // Facts checked by an older rule (AGENTS.md citations, wrong lines, full dependency lists, generous relevance) are
  // checked again once against their repo, beside startup (never awaited); what changed is in Activity. A failure waits for the next start.
  // Files scans read in what are now data folders (transcripts, logs: scan/data.ts) are forgotten, so they no longer
  // count as read by an older scanner and fg status stops asking for a rescan of them. Beside startup, logged.
  void forgetDataFiles({ facts, projects: selectedFolders, activity, log })
    .then((r) => r.files && log('data files forgotten', r))
    .catch((err) => log('forgetting data files failed', { error: redactSecrets(String(err)) }));
  void recheckFacts({ facts, embed, projects: selectedFolders, maxBytes: config.scanMaxBytes, activity, log })
    .then((r) => r.checked && log('facts rechecked', r))
    .catch((err) => log('fact recheck failed', { error: redactSecrets(String(err)) }));

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

  /**
   * Run one claimed scan job to its end, or to a shard boundary where it gives way to a scan waiting for its slot (turn);
   * true when it finished (done or failed) or gave way, false when it went back to wait out a retry.
   */
  /** A sharded scan's listing, shard plan and mirror, kept while it waits its turn again (same HEAD). */
  const scanPlans = new ScanPlans();
  async function scanJob(job: ScanJob, turn?: ScanTurn): Promise<boolean> {
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
    // The map first, so the scan's project has a current one; a failure here is logged and the scan goes on. A scan
    // going on after giving way had its map made when it started.
    if (!job.shards?.processed) await mapStage.mapProject({ key: job.projectKey, repoPath: job.repoPath }, 'a scan was requested');
    log('scan started', { project: job.projectKey, provider: llm.id });
    let unavailable: string | null = null;
    const touched = (key: string) => store.codegraph.editedPaths(key, EDITED_PATHS_LIMIT);
    // The files review comments are on: where reviewers found something to say, so scanned early.
    const prPaths = async (key: string) =>
      [...new Set((await repo.listCandidates({ projectKey: key, source: 'github', limit: PR_PATHS_LIMIT })).map((c) => c.external?.path).filter((p): p is string => !!p))];
    const r = await runScan(job, { facts, llm, embed, maxBytes: config.scanMaxBytes, maxFiles: config.scanMaxFiles, touched, prPaths, log, activity, plans: scanPlans, ...(turn && { yieldTurn: () => turn.waiting() }) }).catch((err) => {
      unavailable = providerUnavailableReason(err);
      if (unavailable) log('scan model unavailable, the scan stays queued', { project: job.projectKey, reason: unavailable });
      else log('scan failed', { project: job.projectKey, error: redactSecrets(String(err)) });
      return null;
    });
    if (r && !r.paused) log('scan done', { project: job.projectKey, ...r });
    // Back in the queue waiting out its retryAt (a failure or an unreachable model): not progress, so the loop sleeps.
    return !!r;
  }

  // Scans run beside the cycle, SCAN_CONCURRENCY at once (agentic ones one at a time), not one per cycle.
  const scanRunner = new ScanRunner({
    next: (exclude) => facts.nextScanJob(new Date(), exclude),
    agentic: (job) => AGENTIC_SPEC.test(job.provider || defaultScan),
    providerKey: (job) => job.provider?.trim() || defaultScan,
    ready: async (job) => {
      const llm = tracked('scan', provider('scan readiness', job.provider?.trim() || defaultScan));
      await llm?.ready?.();
    },
    parkProvider: (key, reason, retryAt) => parkScanProvider(facts, key, defaultScan, reason, retryAt),
    empty: async (job) => !(await hasCodeFiles(job.repoPath)),
    run: async (job, turn) => await facts.claimQueuedScan(job.id) ? scanJob(job, turn) : true,
    concurrency: config.scanConcurrency,
    log,
  });
  // Publish readiness without giving the API network access to the runner.
  let runnerReport: Promise<void> | undefined;
  const reportRunner = (): Promise<void> => {
    if (!process.env.CODEX_RUNNER_URL) return Promise.resolve();
    return runnerReport ??= (async () => {
      try {
        const result = await runnerReadiness(process.env.CODEX_RUNNER_URL!);
        await docs.setCursor(RUNNER_READINESS_CURSOR, JSON.stringify({ ...result, reason: result.reason ? redactSecrets(result.reason) : null, at: Date.now() }));
      } catch (err) { log('runner readiness report failed', { error: redactSecrets(String(err)) }); }
    })().finally(() => { runnerReport = undefined; });
  };
  const runnerReports = process.env.CODEX_RUNNER_URL ? setInterval(() => { void reportRunner(); }, 15_000) : undefined;
  runnerReports?.unref();
  void reportRunner();
  // Kept mirrors are removed once the running scans have ended.
  stopScans = () => { clearInterval(runnerReports); return Promise.all([scanRunner.stop(), runnerReport]).then(() => { scanPlans.clear(); }); };

  // Ask answers, beside the cycle: every 2 s the oldest waiting question of each model's line, with its chat's model
  // (questions to different models at once, to one model one at a time).
  const chatRunner = new ChatRunner({
    lane: (p) => laneOf(chatSpec(p, chatOpts())),
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
  // Started after the redaction pass over stored data (below): an answer is never written while that pass rewrites turns.
  log('scans', { concurrency: config.scanConcurrency, maxFiles: config.scanMaxFiles ?? 'scales with the repo' });

  /** The selected projects with their remotes: the only ones whose PRs and issues are read. */
  async function syncProjectsList(): Promise<SyncProject[]> {
    return Promise.all((await selectedFolders()).map(async (f) => ({ key: f.key, name: f.key, repoPath: f.repoPath, remote: await cycleDeps.remote(f.repoPath) })));
  }

  const sharedGithubFetch = githubBudgetFetch(docs);
  const fetchGithubPrs: typeof fetchPullRequestContext = options => fetchPullRequestContext({ ...options, fetchImpl: sharedGithubFetch });

  /** PR discussions as project context (docs), every GITHUB_SYNC_HOURS, for every selected project linked to a repository. */
  async function syncGithubDocs() {
    const cred = await integrations.credential('github');
    if (!cred) return;
    const repos = new Map<string, string>();
    const authors = new Map<string, string>();
    for (const p of await syncProjectsList()) {
      const link = await integrations.link(p.key);
      if (link.githubAuthor) authors.set(p.key, link.githubAuthor);
      const target = link.github ? githubTarget(p, config.github.repos) : null;
      if (target) repos.set(p.key, target);
    }
    const g = await syncGithub({ repos, authors, token: cred.token, fetchPrs: fetchGithubPrs, docs, embed, activity, minIntervalMs: config.github.syncHours * 3600_000, log });
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
      fetchPrs: fetchGithubPrs,
      fetchLinearIssues,
      docs,
      embed,
      activity,
      minIntervalMs: config.integrationSyncMinutes * 60_000,
      log,
    });
    if (r.github || r.linear) log('comments synced', r);
  }
  // Where each token is read from now (one saved in Settings wins over .env); it is read again every cycle.
  const tokenFrom = async (k: 'github' | 'linear') => (await integrations.credential(k))?.source ?? 'none';
  log('integrations', { github: await tokenFrom('github'), linear: await tokenFrom('linear'), overrides: [...config.github.repos.keys()], everyMinutes: config.integrationSyncMinutes });

  // Feedback Graph Cloud: off (and nothing is sent) unless CLOUD_URL and CLOUD_TOKEN are set.
  const cloud = config.cloud;
  // In the store, so it survives a restart and is the same record the api's Sync now uses.
  const memory: SyncMemory | null = cloud && storedSyncMemory(store.docs, cloud);
  const cloudSchedule = cloud
    ? new CloudSyncSchedule({
        last: await memory?.last?.('schedule'),
        host: new URL(cloud.url).host,
        intervalMinutes: cloud.intervalMinutes,
        log,
        // A project that failed waits alone (its own backoff); the others keep the interval.
        run: async (waiting) =>
          runCloudSync({
            cloud: { ...cloud, shareDemoProjects: await cloudSharedDemoProjects(store.docs) },
            waiting,
            portability: store.portability,
            activity,
            projects: async () => syncProjects({ configured: cloud.projects, selected: scope.projects, excluded: [...config.excludeProjects, ...await cloudLocalOnlyProjects(store.docs, config.cloud?.localOnlyProjects)] }),
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

  // Changed redaction rules run once over the facts, documents, lessons, misses, Inbox items, session summaries, Ask and
  // Activity stored under older ones, before any of it is served again; the counts are in Activity. A failure is
  // logged and tried again at the next start.
  const redactionArchive = await encryptedRedactionArchive(process.env.REDACTION_ARCHIVE_DIR ?? join(dirname(config.stateDb), 'settings', 'redaction-archive'), { keyDirectory: process.env.REDACTION_ARCHIVE_KEY_DIR ?? join(dirname(config.stateDb), 'redaction-key'), retentionDays: Number(process.env.REDACTION_ARCHIVE_RETENTION_DAYS ?? 30) });
  setRedactionArchive(redactionArchive.save);
  setRedactionArchivePurger(redactionArchive.remove);
  setInterval(() => { void redactionArchive.purge().catch(error => log('redaction archive retention failed', { error: String(error) })); }, 3600_000).unref();
  await redactStoredOnRuleChange({ cursors: docs, facts, docs, knowledge, graph: repo, sessions: store.sessions, chats: store.chats, activity, log, repair: { facts, docs, knowledge, projects: selectedFolders, activity } })
    .catch((err) => log('redaction over stored data failed', { error: redactSecrets(String(err)) }));
  await chatRunner.start();
  // A skip rule that changed (an upgrade, or new GITHUB_BOT_LOGINS / GITHUB_AGENT_LOGINS) runs once over what is already
  // pending in the Inbox. A failure is logged and tried again at the next start.
  await skipPendingOnRulesChange({ graph: repo, cursors: docs, activity, botLogins: config.github.botLogins, agentLogins: config.github.agentLogins, log })
    .then((n) => { if (n !== null) log('skip rules applied to pending Inbox items', { skipped: n }); })
    .catch((err) => log('skip rules over pending Inbox items failed', { error: redactSecrets(String(err)) }));
  // The same for the process-miss rule (a miss about branches or pull requests is on no file): once per version over
  // what was stored before it. The instruction rule and the session re-match read session evidence: they run after the
  // first ingest (the evidence gate, below).
  await sortOldMisses({ knowledge, cursors: docs, activity, log })
    .then((n) => { if (n !== null) log('process-miss rule applied to past misses', n); })
    .catch((err) => log('process-miss rule over past misses failed', { error: redactSecrets(String(err)) }));
  // Only the owner's decisions mark a lesson as yours: one a machine decided under the older rule loses the mark, once.
  await migrateDeciderRule({ knowledge, cursors: docs, activity, log })
    .catch((err) => log('lesson decider rule failed', { error: redactSecrets(String(err)) }));
  // Lessons edited before the writer's draft was kept get it from the edits Activity recorded, once, so "approved as
  // written" and the writer's examples stop counting a rewritten lesson as approved as written.
  await backfillProposedAs({ knowledge, activity, cursors: docs, log })
    .catch((err) => log("writer's draft backfill failed", { error: redactSecrets(String(err)) }));
  // The lesson re-check now, if the session evidence is current; else after the first cycle has read the transcripts.
  await evidence.load();
  await evidence.atStart();

  scanRunner.startPolling();
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
      await retention();
      if (evidence.ready()) await evidence.recheck();
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
        // Post-mortems read the session evidence too: they wait for this start's first ingest and the passes after it.
        const settling = !evidence.settled();
        const pm: Awaited<ReturnType<typeof runPostmortems>> = pmDeps && !settling ? await runPostmortems(pmDeps) : { done: 0, failed: 0 };
        const { classifierUnavailable, ...r } = await runCycle(cycleDeps);
        // The transcripts were read through: what judges stored data against them can run now (once per start).
        await evidence.afterIngest();
        summarizeStage?.kick();
        log('cycle', { ...r, postmortems: pm.done, postmortemFailures: pm.failed, scanned, classifierUnavailable, postmortemUnavailable: pm.unavailable });
        status.lastCycleAt = new Date().toISOString();
        status.lastCycle = { ...r, postmortems: pm.done, postmortemFailures: pm.failed, scanned };
        status.lastError = classifierUnavailable ? `classifier unavailable: ${classifierUnavailable}`
          : pm.unavailable ? `post-mortem model unavailable: ${pm.unavailable}` : null;
        // Last in line: only when this round had nothing else to do.
        const scored = r.turnsClassified > 0 || pm.done > 0 || docRead ? 0 : await scoreSome();
        // Failures back off on their own schedule; only real progress keeps the loop from sleeping. Scans are not
        // counted: they run beside the loop and refill their own slots as they finish. Nor is the relevance backfill.
        // The round that let post-mortems through goes straight on to them.
        progressed = cycleProgressed({ turnsClassified: r.turnsClassified, postmortems: pm.done, docRead: !!docRead, scored }) || (settling && !!pmDeps);
        if (scored) log('relevance backfill', { scored });
      } while (progressed && !stopping);
      // Classify transcript feedback before importing notes written in response to that feedback.
      const imported = await importMemories(memDeps);
      if (imported) log('memory lessons imported', { imported });
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
