import { githubBudgetFetch } from './integrations/githubBudget.ts';
import { loopExecutor, readAuthState, reconcileInFlight, setRedactionArchive, setRedactionArchivePurger } from '@fb/core';
import { encryptedRedactionArchive } from './redactionArchive.ts';
import { cloudLocalOnlyProjects, cloudSharedDemoProjects, folderSelectedNow } from '@fb/core';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  runnerReadiness, fetchPullRequestContext, projectFolders, refreshLayout, killRunningCommands, loadConfig, makeProvider, ollamaEmbed, projectScope, ProviderUnavailableError, redactSecrets, runCloudSync, syncProjects,
  credentialFile, fetchLinearIssues, Integrations, searchLinearIssues, selectionNote, storedSyncMemory, touchedAround, VERSION, withHealth, type Config, type KnowledgeStore, type LlmProvider, type Store, type ModelJob, type ProjectScope, type SyncMemory, type WorkerStatus,
} from '@fb/core';
import { answerTurn } from './chat/answer.ts';
import { chatSpec, codexLoggedIn, defaultChatSpec, type ChatSpecOpts } from './chat/provider.ts';
import { ChatRunner, laneOf, sharesModel } from './chat/runner.ts';
import { CloudSyncSchedule } from './cloud/schedule.ts';
import { EDITED_PATHS_LIMIT, MapStage } from './codegraph/stage.ts';
import { runCycle } from './cycle.ts';
import { classifyTurn } from './detect/classify.ts';
import { codexSessionFiles } from './ingest/codex.ts';
import { cachedRemote, commitsInWindow, projectRemote, worktreeGitArgs } from './ingest/git.ts';
import { readLines } from './ingest/lines.ts';
import { buildCandidates } from './projects/candidates.ts';
import { containerFolders } from './projects/folders.ts';
import { memoryWriteLookup, importMemories } from './memory/memory.ts';
import { Workspace } from './workspace.ts';
import { withdrawDuplicateMemory } from './memory/duplicates.ts';
import { claudeTranscriptFiles } from './ingest/claude.ts';
import { projectLinkedTickets } from './postmortem/tickets.ts';
import { Heartbeat } from './heartbeat.ts';
import { Shutdown } from './shutdown.ts';
import { runWorkerLoop } from './loop.ts';
import { openWorkerStore, runStartupPasses } from './startup.ts';
import { foldersWithRemotes, githubDocTargets, isAgenticSpec, providerFactory, readDocsRound, RetentionPacer, reviewedPaths, RunnerReport, RUNNER_DISABLED_FLAG, runnerDisabledFlag, runScanJob, Sometimes } from './jobs.ts';
import { loadStandingContext, memoryDirFor, runPostMortem } from './postmortem/postmortem.ts';
import { examplePool } from './postmortem/examples.ts';
import { backfillProposedAs } from './postmortem/proposedAs.ts';
import { huntContext } from './postmortem/hunt.ts';
import { syncGithub } from './integrations/githubSync.ts';
import { syncExternalFeedback, type SyncProject } from './integrations/feedbackSync.ts';
import { skipPendingOnRulesChange } from './integrations/pendingSkips.ts';
import { redactStoredOnRuleChange } from './redactStored.ts';
import { resolvePendingInstructions } from './detect/pendingInstructions.ts';
import { sortOldMisses } from './postmortem/subjects.ts';
import { attachWorkSession } from './postmortem/work.ts';
import { repoFileList, repoHas } from './postmortem/paths.ts';
import { recheckLessons, recordedWorkSession } from './postmortem/recheck.ts';
import { backfillLessonTriggers, rederiveLessonTriggers } from './postmortem/triggers.ts';
import { checkLessonsAgainstMap } from './postmortem/codeChanged.ts';
import { rematchOnRuleChange } from './postmortem/rematch.ts';
import { sessionEvidence } from './postmortem/standing.ts';
import { providerAnswers, runPostmortems } from './postmortem/step.ts';
import { migrateDeciderRule } from './postmortem/deciders.ts';
import { runRepairs } from './repairs.ts';
import { clearStaleParks, parkedOn, parkScanProvider, ScanRunner, type ScanTurn } from './scan/runner.ts';
import { recheckFacts } from './scan/recheck.ts';
import { forgetDataFiles } from './scan/data.ts';
import { hasCodeFiles, runScan, ScanPlans } from './scan/scan.ts';
import { scoreFacts, ScoringPacer } from './relevance/score.ts';
import { runLinkDetection } from './links/stage.ts';
import { readOneDoc } from './docs/read.ts';
import { budgetedLlm, CONFLICT_BUDGET_CURSOR, IntakeBudget } from './intake/budget.ts';
import { conflictSweepRound, conflictTriggerRound, logTally, type ConflictStageDeps } from './conflicts/stage.ts';
import { extractIntakeOne } from './intake/extract.ts';
import { intakeModelSpec } from './intake/model.ts';
import { SummarizeStage } from './summarize/stage.ts';
import { CODEX_COPY_RULE, FileState, INGEST_VERSION } from './state.ts';
import { SessionEvidenceGate } from './evidence.ts';
import { healthSince, StageTracker, withClassifyBacklog } from './progress.ts';
import { runLoopRound } from './loop/engine.ts';
import { LoopStage, loopIdle } from './loop/stage.ts';

const REMOTE_TTL_MS = 10 * 60_000;

/** What the worker runs in: main.ts passes the process; a test passes its own store, signals and exit. */
export type WorkerIo = {
  env: NodeJS.ProcessEnv;
  openStore: (config: Config) => Promise<Store>;
  log: (msg: string, extra?: object) => void;
  /** Where SIGTERM and SIGINT arrive (and 'exit'). */
  signals: Pick<NodeJS.Process, 'once'>;
  exit: (code: number) => void;
};

/**
 * The worker: opens the store, runs the start-up passes, then the loop until SIGTERM or SIGINT, then closes the stages
 * and the store and exits 0. A start that fails rejects (main.ts logs it and exits 1).
 */
export async function runWorker(io: WorkerIo): Promise<void> {
  const { env, log } = io;
  const provider = providerFactory((spec) => makeProvider(spec, env), log);
  const config = loadConfig(env);
  const store = await openWorkerStore(config, () => io.openStore(config), log);
  const { graph: repo, knowledge, facts, activity, docs, selection } = store;
  // Lessons whose checks are older than the current ones (or that `fg lessons recheck` marked) get today's checks: flags
  // only, logged in Activity. At start and each round once the session evidence they read is current (evidence.ts: not
  // before an ingest version bump's re-read), a cheap query when there is nothing to do; a failure waits.
  // Lesson paths and triggers are checked against the repository as mounted here, under the container side of the roots
  // (the stored repoPath is the host's, not there in Docker); a project under no root is not judged (repoHas).
  const repoPaths = async () => new Map((await containerFolders((await facts.listProjects()).map((p) => p.key), config.roots)).map((p) => [p.key, p.repoPath]));
  const recheckOld = () =>
    recheckLessons({
      k: knowledge, decisions: store.decisions, activity, log,
      repoPaths,
      // What the session's transcript showed its agent had: a miss blaming a file it "did not load" is checked against it.
      instructionFiles: (id) => repo.sessionInstructionFiles(id),
      // The session a comment's post-mortem used (none, or matched by branch or files): its miss is not read for wrong-session.
      workSession: recordedWorkSession(activity),
      // A ticket is the project's when it holds it or its PRs name it, or it is from a team whose tickets it holds.
      linkedTickets: (key, ids) => projectLinkedTickets(docs, key, ids),
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
    requestLessonRecheck: () => knowledge.requestLessonRecheck(),
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
  const withJobHealth = (job: ModelJob, p: LlmProvider) => withHealth(p, (h) => { health[job] = healthSince(health[job], h); });
  const tracked = (job: ModelJob, p: LlmProvider | null) => p && withJobHealth(job, p);
  const classifier = tracked('classify', provider('classify', config.llm.classify ?? localModel));
  // The local model always builds (it needs no key), so post-mortems always have a model.
  const postmortemLlm = withJobHealth(
    'postmortem',
    provider('postmortem', config.llm.postmortem ?? (env.CLAUDE_CODE_OAUTH_TOKEN ? 'claude-cli' : localModel)) ??
      provider('postmortem (fallback)', localModel)!,
  );
  const defaultScan = config.llm.scan ?? localModel;
  // Reads your uploads (documents and images) into facts; images need a model with vision.
  const docsLlm = tracked('docs', provider('docs', config.llm.docs ?? defaultScan));
  // Knowledge intake (INTAKE_ENABLED): reads what people said into claims for review, with a model the allow list takes
  // (INTAKE_PROVIDER_ALLOW: no company API key by default), each call metered by INTAKE_LLM_CALLS_PER_DAY.
  const intakeModel = config.intake.enabled ? intakeModelSpec(config, localModel) : null;
  if (intakeModel?.skipped.length) log('intake skips models INTAKE_PROVIDER_ALLOW refuses', { skipped: intakeModel.skipped, allow: config.intake.providerAllow, using: intakeModel.spec });
  const intakeLlm = intakeModel?.spec ? tracked('intake', provider('intake', intakeModel.spec)) : null;
  const intakeBudget = new IntakeBudget({ cursors: store.docs, perDay: config.intake.llmCallsPerDay, now: Date.now });
  // Contradiction detection's judge: CONFLICT_LLM (held to the same allow list at startup), else intake's model, with
  // its own daily calls (CONFLICT_LLM_CALLS_PER_DAY).
  const conflictLlm = !config.intake.enabled ? null : config.conflicts.llm ? tracked('intake', provider('intake', config.conflicts.llm)) : intakeLlm;
  const conflictBudget = new IntakeBudget({
    cursors: store.docs, perDay: config.conflicts.llmCallsPerDay, now: Date.now, cursor: CONFLICT_BUDGET_CURSOR,
    spent: 'conflict judge calls are used (CONFLICT_LLM_CALLS_PER_DAY): detection goes on tomorrow',
  });
  // An unavailable summary model only pauses summaries; /api/status and the badge say so. SUMMARY_LLM=off is reported as off.
  const summaryLlm = config.summary.enabled ? tracked('summary', provider('summary', config.summary.llm ?? localModel)) : null;
  // Ask: CHAT_LLM, else claude-cli with a Claude token, else codex-cli with a Codex login, else the local model. A chat
  // may pick another provider; the Codex login is looked at again per answer (it can be added without a restart).
  const chatOpts = (): ChatSpecOpts => ({ chatLlm: config.llm.chat, localModel, env, codexLogin: codexLoggedIn(env) });
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
  const ws = new Workspace({
    selection,
    scopeNow: () => selection.scope(config),
    excludeProjects: config.excludeProjects,
    state,
    transcriptsDir: transcripts,
    codexSessionsDir: config.codexSessionsDir,
    isDirectory: async (path) => !!(await lstat(path).catch(() => null))?.isDirectory(),
    listFiles: () => cycleDeps.listFiles(),
    candidates: (files, codexSessionsFound) =>
      buildCandidates({
        roots, files, state, codexSessionsFound,
        hostHome: config.hostHome ?? undefined,
        remote: cycleDeps.remote,
        cloneOf: async (f) => (await repo.canonicalProject({ key: f.key, name: f.key, repoPath: f.repoPath, remote: f.remote }, { dryRun: true })).project.key,
      }),
    memoryRoots: () => memDeps.roots(),
    // In place, so ingest, memory import and the map stage (which hold these roots) see the same layout.
    refreshLayout: (keepWhole) => refreshLayout(roots, { keepWhole }),
    log,
  }, projectScope(seeded.selection, config));

  const status: WorkerStatus = {
    version: VERSION,
    startedAt: new Date().toISOString(),
    lastBeat: new Date().toISOString(),
    lastCycleAt: null,
    lastCycle: null,
    lastError: null,
    providers: { classify: classifier?.id ?? null, postmortem: postmortemLlm.id, scan: defaultScan, summary: summaryLlm?.id ?? null, docs: docsLlm?.id ?? null, chat: defaultChat, intake: intakeLlm?.id ?? null },
    health,
    off: [...(config.summary.enabled ? [] : ['summary' as const]), ...(config.intake.enabled ? [] : ['intake' as const])],
  };
  const heartbeat = new Heartbeat({ status, file: env.HEARTBEAT_FILE ?? '/tmp/fg-heartbeat', writeFile, repo, log });
  heartbeat.start();
  // The step running now (/api/status stage and progress): a change beats within a few seconds, not at the next beat.
  const stage = new StageTracker(status, () => heartbeat.soon());

  const shutdown = new Shutdown({ log, killRunningCommands, exit: io.exit });
  shutdown.onStop(() => heartbeat.stop());
  shutdown.install(io.signals);

  // The classify step's size: the turns waiting (as fetched, so capped), and the model calls this cycle may make.
  const stagedRepo = withClassifyBacklog(repo, status, stage, config.classifyBatch);

  const cycleDeps = {
    listFiles: async () => {
      stage.enter('ingest');
      return [...(await claudeTranscriptFiles(transcripts)), ...(await codexSessionFiles(config.codexSessionsDir)).map((f) => ({ ...f, source: 'codex' as const }))];
    },
    readFile: (p: string) => {
      stage.step(basename(p));
      return readFile(p, 'utf8');
    },
    readLines: (p: string) => {
      stage.step(basename(p));
      return readLines(p);
    },
    folderOf: (p: string) => ws.folderOf.get(p),
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
    includeProject: (k: string) => ws.scope.folder(k),
    // Each transcript is written under the store's lock, against the selection as stored then (cleanup can run mid-cycle).
    scopeNow: () => selection.scope(config),
    exclusive: <T>(fn: () => Promise<T>) => selection.exclusive(fn),
    get onlyProjects() { return ws.scope.projects; },
    excludeProjects: config.excludeProjects.length ? config.excludeProjects : undefined,
    activity,
    storedTurns: async (id: string) => (await store.sessions.detail(id))?.turnCount ?? null,
    storedTurnIds: async (id: string) => (await store.sessions.turns(id, -1, 100_000)).map((t) => ({ uuid: t.uuid, ts: t.ts, text: t.text })),
    remote: cachedRemote(projectRemote, REMOTE_TTL_MS),
    projects: repo,
    // Records a scan or a code map made have no folder: the backfill reads it (and its remote) from the selection.
    folders: () => selectedFolders(),
    codegraph: store.codegraph,
  };

  // GitHub and Linear: a token in .env, else one pasted in Settings (re-read every cycle, so connecting needs no restart).
  const integrations = new Integrations(docs, env, config.integrationsFile ? credentialFile(config.integrationsFile) : null);
  let linearKey: string | null = null;

  const pmDeps = {
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
          const [embedding] = await embed([i.feedback.text.slice(0, 2000)]);
          return examplePool((q) => knowledge.decidedLessons(q), { projectKeys: [i.projectKey], since: new Date(0).toISOString(), embedding });
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

  // The trigger backfill's failed model calls by lesson, across rounds (postmortem/triggers.ts).
  const triggerTries = new Map<string, number>();
  const memoryWrites = memoryWriteLookup(repo);
  const memDeps = {
    transcriptsDir: transcripts,
    roots: async () => {
      const folders = await projectFolders(roots);
      return roots.map((r) => ({ host: r.host, keys: folders.filter((f) => f.root === r).map((f) => f.rel) }));
    },
    includeProject: (k: string) => ws.scope.folder(k),
    state,
    embed,
    upsertLesson: (l: Parameters<KnowledgeStore['upsertLesson']>[0]) => knowledge.upsertLesson(l),
    activity,
    autoApprove: config.memoryAutoApprove,
    beginCorrelation: () => memoryWrites.reset(),
    runForWrite: (projectKey: string, path: string) => repo.memoryWriteRun(projectKey, path),
    writtenAfterFeedback: (projectKey: string, path: string) => memoryWrites.find(projectKey, path),
    withdrawDuplicate: (id: string, feedbackId: string | null) => withdrawDuplicateMemory({ knowledge, activity }, id, feedbackId),
  };

  /** The folders of the selected projects, under the first root that has them (plain directories only, nested repos too). */
  function selectedFolders(): Promise<{ key: string; repoPath: string }[]> {
    return containerFolders(ws.scope.projects, roots);
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
    sourceMaxBytes: config.codeMapMaxBytes,
    // Files your sessions edited are kept first when the map is capped: they are where the next miss happens.
    editedPaths: (key) => store.codegraph.editedPaths(key, EDITED_PATHS_LIMIT),
    // A worktree's .git names its git dir by the host path: reach it through the roots mapping.
    gitArgs: (repoPath) => worktreeGitArgs(repoPath, roots),
    log,
    exclusive: <T>(fn: () => Promise<T>) => selection.exclusive(fn),
    inScope: async (key: string) => (await selection.scope(config)).project(key),
    // Approved lessons about code the rebuild changed or removed are flagged for you (never revoked).
    onMapped: async (p, before, after) => { await checkLessonsAgainstMap({ k: knowledge, repoFiles: repoFileList, activity, log }, p, before, after); },
  });
  // Abandons a map being parsed now; the loop waits for one being written before the store closes.
  shutdown.onStop(() => mapStage.stop());

  // Running summaries of the selected projects' sessions, beside ingest (never awaited by it).
  const summarizeStage = config.summary.enabled
    ? new SummarizeStage({
        sessions: store.sessions,
        llm: summaryLlm,
        activity,
        projects: () => ws.scope.projects,
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
          return await scoreFacts({ facts, llm: scorer, projects: () => ws.scope.projects, activity, log });
        } catch (err) {
          log('relevance scoring failed', { error: redactSecrets(String(err)) });
          throw err;
        }
      }, 10 * 60_000)
    : null;
  const scoreSome = () => scoring?.tick() ?? Promise.resolve(0);

  // Links between the selected projects, from evidence in them (no model), every LINK_SCAN_MINUTES, beside the loop.
  const links = new Sometimes({
    everyMs: config.linkScanMinutes * 60_000,
    what: 'link detection',
    log,
    run: async () => {
      const r = await runLinkDetection({
        links: store.links,
        projects: async () => foldersWithRemotes(await facts.listProjects(), await selectedFolders(), cycleDeps.remote),
        activity,
      });
      log('links detected', r);
    },
  });

  // Contradiction detection (knowledge intake): each minute the Activity entries that change what is known, and every
  // CONFLICT_SWEEP_MINUTES a capped page of the sweep, one after the other so a pair is never judged twice at once.
  let sweptAt = 0;
  const conflictDeps: ConflictStageDeps = {
    store, embed, llm: conflictLlm && budgetedLlm(conflictLlm, conflictBudget), log,
    projects: async () => (await selectedFolders()).map((f) => f.key),
  };
  const conflicts = config.intake.enabled
    ? new Sometimes({
      everyMs: 60_000,
      what: 'contradiction detection',
      log,
      run: async () => {
        logTally(conflictDeps, 'conflicts checked after changes', await conflictTriggerRound(conflictDeps));
        if (Date.now() - sweptAt < config.conflicts.sweepMinutes * 60_000) return;
        sweptAt = Date.now();
        logTally(conflictDeps, 'conflict sweep', await conflictSweepRound(conflictDeps));
      },
    })
    : null;

  async function readDocOne(): Promise<boolean> {
    let read = false;
    if (docsLlm) {
      stage.enter('docs');
      read = await readDocsRound(() => readOneDoc({ docs, llm: docsLlm, embed, inScope: async (key) => ws.scope.project(key), activity, log }), log);
    }
    if (intakeLlm) {
      stage.enter('docs');
      // One pass (a window) of an intake source a round, so a long call never holds up the rest of the loop.
      const extracted = await readDocsRound(() => extractIntakeOne({
        docs, intake: store.intake, llm: budgetedLlm(intakeLlm, intakeBudget), budgetSpent: () => intakeBudget.spent(), perDay: config.intake.llmCallsPerDay,
        embed, inScope: async (key) => ws.scope.project(key), activity, log,
        knownFiles: async (key) => {
          const map = await store.codegraph.codeMap(key);
          return map ? new Set(map.files.map((f) => f.path)) : null;
        },
      }), log);
      read ||= extracted;
    }
    return read;
  }

  /** A sharded scan's listing, shard plan and mirror, kept while it waits its turn again (same HEAD). */
  const scanPlans = new ScanPlans();
  const scanJobDeps = {
    // A scan requested right after selecting its project may come before this cycle's refreshScope.
    inScope: (key: string) => folderSelectedNow(ws.scope, key, async () => { await ws.refreshScope(); return ws.scope; }),
    facts,
    provider: (spec: string, why: (r: string) => void) => tracked('scan', provider('scan', spec, why)),
    defaultSpec: defaultScan,
    // A failure here is logged and the scan goes on.
    mapProject: (p: { key: string; repoPath: string }) => mapStage.mapProject(p, 'a scan was requested'),
    scan: (job: Parameters<typeof runScan>[0], llm: LlmProvider, turn?: ScanTurn) =>
      runScan(job, {
        facts, llm, embed, maxBytes: config.scanMaxBytes, maxFiles: config.scanMaxFiles, log, activity, plans: scanPlans,
        touched: (key) => store.codegraph.editedPaths(key, EDITED_PATHS_LIMIT),
        prPaths: (key) => reviewedPaths(repo, key),
        ...(turn && { yieldTurn: () => turn.waiting() }),
      }),
    log,
  };

  // Scans run beside the cycle, SCAN_CONCURRENCY at once (agentic ones one at a time), not one per cycle.
  const scanRunner = new ScanRunner({
    next: (exclude) => facts.nextScanJob(new Date(), exclude),
    agentic: (job) => isAgenticSpec(job.provider || defaultScan),
    providerKey: (job) => job.provider?.trim() || defaultScan,
    ready: async (job) => {
      const llm = tracked('scan', provider('scan readiness', job.provider?.trim() || defaultScan));
      await llm?.ready?.();
    },
    parkProvider: (key, reason, retryAt) => parkScanProvider(facts, key, defaultScan, reason, retryAt),
    unpark: (job) => facts.updateScanJob(job.id, { parkedAt: null, ...(parkedOn(job) && { error: null, retryAt: null }) }),
    empty: async (job) => !(await hasCodeFiles(job.repoPath)),
    run: async (job, turn) => await facts.claimQueuedScan(job.id) ? runScanJob(job, scanJobDeps, turn) : true,
    concurrency: config.scanConcurrency,
    log,
  });
  // Publish readiness without giving the API network access to the runner.
  const runnerReport = new RunnerReport({ url: env.CODEX_RUNNER_URL, readiness: (url) => runnerReadiness(url), disabled: () => runnerDisabledFlag(RUNNER_DISABLED_FLAG), cursors: docs, log });
  const runnerReports = env.CODEX_RUNNER_URL ? setInterval(() => { void runnerReport.report(); }, 15_000) : undefined;
  runnerReports?.unref();
  void runnerReport.report();
  // Kept mirrors are removed once the running scans have ended.
  shutdown.onStop(() => { clearInterval(runnerReports); return Promise.all([scanRunner.stop(), runnerReport.pending()]).then(() => { scanPlans.clear(); }); });

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
  shutdown.onStop(() => chatRunner.stop());
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
    const { repos, authors } = await githubDocTargets(await syncProjectsList(), (key) => integrations.link(key), config.github.repos);
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
  const cloudSchedule = cloud && memory
    ? new CloudSyncSchedule({
        last: await memory.last?.('schedule'),
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
            projects: async () => syncProjects({ configured: cloud.projects, selected: ws.scope.projects, excluded: [...config.excludeProjects, ...await cloudLocalOnlyProjects(store.docs, config.cloud?.localOnlyProjects)] }),
            trigger: 'schedule',
            memory,
          }),
      })
    : null;
  status.cloudSync = cloudSchedule?.status ?? null;
  log('cloud sync', cloud ? { enabled: true, host: new URL(cloud.url).host, intervalMinutes: cloud.intervalMinutes, projects: cloud.projects } : { enabled: false });

  const retention = new RetentionPacer({
    days: config.turnRetentionDays ?? 0,
    keepUnsummarized: config.summary.enabled,
    prune: (before, o) => repo.pruneTurnText(before, undefined, o),
    log,
  });

  // Changed redaction rules run once over the facts, documents, lessons, misses, Inbox items, session summaries, Ask and
  // Activity stored under older ones, before any of it is served again; the counts are in Activity. A failure is
  // logged and tried again at the next start.
  const redactionArchive = await encryptedRedactionArchive(env.REDACTION_ARCHIVE_DIR ?? join(dirname(config.stateDb), 'settings', 'redaction-archive'), { keyDirectory: env.REDACTION_ARCHIVE_KEY_DIR ?? join(dirname(config.stateDb), 'redaction-key'), retentionDays: Number(env.REDACTION_ARCHIVE_RETENTION_DAYS ?? 30) });
  setRedactionArchive(redactionArchive.save);
  setRedactionArchivePurger(redactionArchive.remove);
  setInterval(() => { void redactionArchive.purge().catch(error => log('redaction archive retention failed', { error: String(error) })); }, 3600_000).unref();
  await runStartupPasses({
    log,
    redactStored: () => redactStoredOnRuleChange({ cursors: docs, facts, docs, knowledge, graph: repo, sessions: store.sessions, chats: store.chats, decisions: store.decisions, activity, log, repair: { facts, docs, knowledge, projects: selectedFolders, activity } }),
    startChats: () => chatRunner.start(),
    skipPending: () => skipPendingOnRulesChange({ graph: repo, cursors: docs, activity, botLogins: config.github.botLogins, agentLogins: config.github.agentLogins, log }),
    sortOldMisses: () => sortOldMisses({ knowledge, cursors: docs, activity, log }),
    migrateDeciders: () => migrateDeciderRule({ knowledge, cursors: docs, activity, log }),
    backfillProposedAs: () => backfillProposedAs({ knowledge, activity, cursors: docs, log }),
    repairs: () => runRepairs({ knowledge, graph: repo, activity, cursors: docs, log }),
    evidence,
    reconcileDecisions: () => reconcileInFlight(store, { embed }),
  });

  // The learning loop: rounds beside the worker loop at idle priority (loop/stage.ts), in the mode stored in loop-settings.
  // LOOP_LLM (else the local model) is metered by LOOP_LLM_CALLS_PER_DAY; tokenless installs observe at most.
  const loopLlm = provider('loop', config.loop.llm ?? localModel);
  const learning = new LoopStage({
    stopping: () => shutdown.stopping,
    idle: loopIdle({ postmortemBacklog: pmDeps && knowledge.postmortemBacklog ? () => knowledge.postmortemBacklog!() : null, scansRunning: () => scanRunner.running().length }),
    log,
    run: async () => {
      // A decision left applying since the start-up pass (a crash of the API part way through an approve) is settled
      // before the loop reads its targets again.
      const settled = await reconcileInFlight(store, { embed });
      if (settled.applied + settled.proposed + settled.overridden) log('learning loop decisions left applying settled', settled);
      // Whether the owner can review and roll back what it does: the API's own answer each round (authState.ts).
      return runLoopRound({
        store, cursors: docs, config: config.loop, tokenless: !(config.authConfigured || (config.authStateFile !== null && await readAuthState(config.authStateFile))),
        inScope: (key) => key === null || ws.scope.project(key), executor: loopExecutor(store, { embed }), llm: loopLlm, now: Date.now, log,
      });
    },
  });

  // A scan parked on the model SCAN_LLM named before this start runs now on the current one, without the old reason.
  const unparked = await clearStaleParks(facts, (job) => job.provider?.trim() || defaultScan).catch((err) => { log('stale scan parks not cleared', { error: String(err) }); return 0; });
  if (unparked) log('scans parked on an earlier scan model queued again on the current one', { scans: unparked, provider: defaultScan });
  scanRunner.startPolling();
  await runWorkerLoop({
    status, stage, log,
    stopping: () => shutdown.stopping,
    sleep: (ms) => shutdown.sleep(ms),
    pollMs: config.pollSeconds * 1000,
    refreshScope: () => ws.refreshScope(),
    refreshProjectLayout: () => ws.refreshLayout(),
    refreshCandidates: () => ws.refreshCandidates(),
    forgetDeletedReads: () => ws.forgetDeletedReads(),
    syncGithubDocs, syncFeedback,
    kickMapStage: () => mapStage.kick(),
    detectLinks: () => { void links.tick(); },
    detectConflicts: () => { void conflicts?.tick(); },
    retention: () => retention.tick(),
    evidence,
    cloudTick: () => { void cloudSchedule?.tick(); },
    kickScans: () => scanRunner.kick(),
    scansRunning: () => scanRunner.running().length,
    readDocOne,
    postmortems: () => runPostmortems(pmDeps),
    lessonTriggers: async () => {
      // Triggers derived by older rules first (no model, once per version), then those never derived.
      const again = await rederiveLessonTriggers({ k: knowledge, repoPaths, activity, log });
      const r = await backfillLessonTriggers({ k: knowledge, llm: postmortemLlm, repoPaths, tries: triggerTries, activity, log });
      return again.lessons + r.derived + r.suggested;
    },
    cycle: () => runCycle(cycleDeps),
    kickSummaries: () => summarizeStage?.kick(),
    scoreSome,
    importMemories: () => importMemories(memDeps),
    learningLoop: () => { void learning.tick(); },
  });
  await scanRunner.stop();
  await chatRunner.stop();
  await mapStage.stop();
  state.close();
  await store.close();
  log('stopped');
  io.exit(0);
}
