import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { getConnInfo } from '@hono/node-server/conninfo';
import { cloudLocalOnlyProjects, credentialFile, decisionExecutor, githubRepoOfRemote, Integrations, intakeEnabled, makeProviderOr, ollamaEmbed, ollamaPing, projectFolders, publicRedactionArchive, redactSecrets, refreshLayout, reportedRunnerReadiness, RUNNER_READINESS_CURSOR, setRedactionArchive, setRedactionArchivePurger, shownProjects, storedSyncMemory, syncProjects, VERSION, worktreeGitArgs, writeAuthState, type Config, type Project, type Store } from '@fb/core';
import { Admission } from './admission.ts';
import { symbolsOnDemand } from './symbolsOnDemand.ts';
import { agentDocsFor } from './agentDocs.ts';
import { createApp } from './app.ts';
import { lessonRepeats } from './decisions.ts';
import { chatPackBuilder } from './chat.ts';
import { hashRepoFile, makeJudge, repoFileSize, resolveProject, type ContextDeps } from './context.ts';
import { readRepoDiff, readRepoPrNumbers, githubCommitPrLookup } from './diff.ts';
import { rootsFile } from './roots.ts';
import { loadRunKeySalt } from './runKeySalt.ts';
import { stopServer } from './server.ts';
import type { AgentNotes } from './disputes.ts';
import { prepareIntakeSource, storeIntakeSource } from './intake.ts';

/** INTAKE_ARCHIVE=off: no original intake text is kept in the redaction archive. */
const intakeArchive = (env: Record<string, string | undefined>) => env.INTAKE_ARCHIVE?.trim().toLowerCase() !== 'off';

export type Log = (msg: string, extra?: object) => void;

/**
 * Opens the store, brings its schema up to date and checks its vectors were embedded with OLLAMA_EMBED_MODEL. Null,
 * after logging why, when the api cannot start on it (the password of a connection string never reaches the log).
 */
export async function openApiStore(config: Config, open: (config: Config) => Promise<Store>, log: Log): Promise<Store | null> {
  let store: Store;
  try {
    store = await open(config);
    await store.ensureSchema({ log });
  } catch (err) {
    log('fatal', { store: config.store, error: redactSecrets(String(err)) });
    return null;
  }
  log('store', { store: store.kind });
  const emb = await store.embeddings.check(config.ollama.embedModel);
  if (!emb.ok) {
    log('fatal', { error: `OLLAMA_EMBED_MODEL is ${config.ollama.embedModel} but the stored vectors were embedded with ${emb.stored}; set it back or run the re-embed command (see README)` });
    return null;
  }
  return store;
}

/**
 * check_before_done with no diff: the PRs of the commits a task names, from their messages, and from GitHub's commit
 * association when the project's repository is known (GITHUB_REPOS, else its remote), a GitHub token is set and the
 * project is linked to GitHub in Settings.
 */
export function ownPrNumberReader(o: {
  roots: Config['roots'];
  integrations: Pick<Integrations, 'credential' | 'link'>;
  projects: () => Promise<{ key: string; remote: string | null }[]>;
  githubRepos: Map<string, string>;
  commitPrs: (repo: string, sha: string, token: string) => Promise<number[]>;
}) {
  return async (repoPath: string, task: string, projectKey?: string): Promise<number[]> => {
    const [gitArgs, credential, linked, projects] = await Promise.all([
      worktreeGitArgs(repoPath, o.roots), o.integrations.credential('github'),
      projectKey ? o.integrations.link(projectKey) : null, o.projects(),
    ]);
    const repo = projectKey && (o.githubRepos.get(projectKey) ?? githubRepoOfRemote(projects.find((p) => p.key === projectKey)?.remote ?? null));
    return readRepoPrNumbers(repoPath, task, { gitArgs,
      ...(repo && credential && linked?.github ? { associatedPulls: (sha: string) => o.commitPrs(repo, sha, credential.token) } : {}),
    });
  };
}

/** The api's app, wired from its config and open store. `closing` ends the event streams on shutdown. */
export async function createApiService(config: Config, store: Store, env: NodeJS.ProcessEnv, log: Log) {
  const { knowledge, facts, activity, docs, selection } = store;
  const archiveDirectory = env.REDACTION_ARCHIVE_DIR ?? join(dirname(config.integrationsFile ?? join(process.cwd(), 'state/settings/integrations.json')), 'redaction-archive');
  const archive = await publicRedactionArchive(archiveDirectory, { retentionDays: Number(env.REDACTION_ARCHIVE_RETENTION_DAYS ?? 30) });
  setRedactionArchive(archive.save);
  setRedactionArchivePurger(archive.remove);
  const embed = (input: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}) => ollamaEmbed({ url: config.ollama.url, model: config.ollama.embedModel, input, ...options });

  const localModel = `ollama:${config.ollama.model}`;
  // A CLI CHECK_LLM never gets here: loadConfig refuses it (the api has no agent CLIs). A missing key still falls back.
  const checkSpec = config.llm.check ?? localModel;
  const { provider: judgeLlm, fellBack } = makeProviderOr(checkSpec, localModel, env);
  if (fellBack) log('check provider unavailable, using fallback', { fellBack, using: judgeLlm.id });
  const roots = config.roots;
  // The worker normally seeds the selection first; whichever service starts first does it, and only once.
  await selection.ensure(config, activity);
  /** Read per request: the selection changes from Settings at any time. */
  const scope = () => selection.scope(config);
  /** What every page but Settings shows, and what agents may be served: the selected projects and their clones. */
  const shown = async () => {
    const [sel, aliases] = await Promise.all([selection.current(), selection.aliases()]);
    return shownProjects(sel, config, aliases);
  };

  /**
   * Which folders are projects, by the worker's rule: top-level folders, and the git repos nested in one that is not a
   * repo (a top-level folder already selected or excluded as a whole stays one project). Set on the roots in place, so
   * MCP context resolves a cwd to the same project the worker recorded its sessions under.
   */
  async function refreshProjectLayout() {
    try {
      const whole = new Set([...(await scope()).projects, ...config.excludeProjects]);
      await refreshLayout(roots, { keepWhole: (k) => whole.has(k) });
    } catch (err) {
      log('project layout failed', { error: String(err) });
    }
  }
  await refreshProjectLayout();
  setInterval(refreshProjectLayout, 60_000).unref();

  /** Every project folder under each root (no dot-folders, no symlinks), with its host path. */
  async function allFolders(): Promise<(Project & { path: string })[]> {
    await refreshProjectLayout();
    return (await projectFolders(roots)).map((f) => ({ key: f.key, name: f.rel, repoPath: f.container, path: f.host }));
  }

  /** The folders that are in scope: selected in Settings and not in EXCLUDE_PROJECTS, with their remotes as the worker last read them. */
  async function projectDirs(): Promise<Project[]> {
    const [s, snap] = await Promise.all([scope(), selection.candidates()]);
    const remotes = new Map((snap?.candidates ?? []).map((c) => [c.key, c.remote]));
    return (await allFolders()).filter((f) => s.folder(f.key)).map(({ path: _, ...p }) => ({ ...p, remote: remotes.get(p.key) ?? null }));
  }

  // GitHub and Linear: .env wins; otherwise the token pasted in Settings, kept in INTEGRATIONS_FILE (mode 600).
  const integrations = new Integrations(store.docs, env, config.integrationsFile ? credentialFile(config.integrationsFile) : null);
  /** The selected projects with their remotes as the worker last read them (its candidate list). */
  async function integrationProjects(): Promise<{ key: string; remote: string | null }[]> {
    const [s, snap] = await Promise.all([scope(), selection.candidates()]);
    const remotes = new Map((snap?.candidates ?? []).map((c) => [c.key, c.remote]));
    return s.projects.map((key) => ({ key, remote: remotes.get(key) ?? null }));
  }

  const commitPrs = githubCommitPrLookup();

  /** What get_task_context and the other MCP tools read; Ask builds its context packs from the same. */
  const contextDeps: ContextDeps = {
    roots,
    mapMaxFiles: config.scanMaxFiles,
    facts,
    embed,
    k: knowledge,
    judge: makeJudge(judgeLlm),
    judgeId: judgeLlm.id,
    // A response waits at most 50 s; a kept-alive judge call may run CHECK_WAIT_SECONDS while its retries come back.
    judgeQueue: new Admission({ concurrency: config.check.concurrency, timeoutMs: Math.min(50_000, config.check.waitSeconds * 1000), maxServiceMs: config.check.waitSeconds * 1000 }),
    missClose: config.missMinSimilarity,
    activity,
    log,
    docs,
    inScope: async (key: string) => (await scope()).folder(key),
    // Global lessons reach any folder under a root that is not excluded; reading its sessions stays opt-in.
    servesGlobal: (key: string) => !config.excludeProjects.includes(key),
    exists: existsSync,
    fileHash: hashRepoFile,
    // Why a named file is not in the code map: over its size limit (the worker does not parse it).
    fileSize: repoFileSize,
    mapMaxBytes: config.scanMaxBytes,
    mapSourceMaxBytes: config.codeMapMaxBytes,
    // A named file past the map's cap: its symbols, read when asked.
    parseSymbols: symbolsOnDemand({ maxBytes: config.scanMaxBytes, sourceMaxBytes: config.codeMapMaxBytes }),
    // The AGENTS.md / CLAUDE.md files on a named file's path, which an agent may not load by itself.
    agentDocs: agentDocsFor,
    // check_before_done with no diff: the change to files_changed, read-only from the mounted folder.
    ownPrNumbers: ownPrNumberReader({ roots, integrations, projects: integrationProjects, githubRepos: config.github.repos, commitPrs }),
    repoDiff: async (repoPath: string, files: string[]) => readRepoDiff(repoPath, files, { gitArgs: await worktreeGitArgs(repoPath, roots) }),
    // Files an agent named that have no facts yet go to the front of the project's next scan.
    // Context reads are side-effect free. Scans require the explicit scan route/admin verb; an unauthenticated MCP read
    // on a tokenless local install must not enqueue repository work.
    requestScan: undefined,
    aliasOf: (key: string) => store.graph.projectByAlias(key),
    codegraph: store.codegraph,
    sessions: store.sessions,
    shown,
    links: store.links,
    ...(intakeEnabled(env) && {
      intake: {
        store: store.intake,
        fact: (id: string) => store.facts.fact(id),
        lesson: async (id: string) => (await knowledge.lessonDetail(id))?.lesson ?? null,
        // submit_notes: the agent's notes as a notes source, private (never synced), read into claims for the owner.
        submit: async (project: Project, n: AgentNotes) => {
          const prepared = prepareIntakeSource(project, { projectKey: project.key, kind: 'notes', format: 'md', title: n.title, text: n.text, occurredAt: n.occurredAt, origin: n.origin, private: true });
          if ('error' in prepared) throw new Error(prepared.error);
          const id = await storeIntakeSource({ store: store.intake, archive: intakeArchive(env), docs, embed, activity }, prepared, {
            actor: n.origin, why: 'an agent submitted notes (submit_notes): their claims wait for your review and are never accepted for you',
          });
          return { id, utterances: prepared.utterances.length };
        },
      },
    }),
  };

  /** Aborted on SIGTERM: the event streams end at once instead of holding the restart for 10 s (stopServer). */
  const closing = new AbortController();
  // The api's private settings folder (/api-settings in the container): the run-key salt and the owner-session
  // revocations live beside the saved roots and integrations, wherever this api was told to keep those.
  const settingsDir = dirname(config.rootsFile ?? config.integrationsFile ?? join(process.cwd(), 'state/settings/project-roots.json'));
  const runKeySalt = await loadRunKeySalt(join(settingsDir, '.run-key-salt'));
  const app = createApp(store.graph, {
    closing: closing.signal,
    peerAddress: (c) => getConnInfo(c).remote.address,
    staticDir: env.STATIC_DIR,
    knowledge,
    embed,
    facts,
    projectDirs,
    insights: store.insights,
    activity,
    docs,
    links: store.links,
    portability: store.portability,
    codegraph: store.codegraph,
    mapMaxFiles: config.scanMaxFiles,
    cloud: {
      cloud: config.cloud,
      localOnlyStore: store.docs,
      memory: config.cloud ? storedSyncMemory(store.docs, config.cloud) : undefined,
      portability: store.portability,
      activity,
      projects: async () => syncProjects({ configured: config.cloud?.projects ?? [], selected: (await scope()).projects, excluded: [...config.excludeProjects, ...await cloudLocalOnlyProjects(store.docs, config.cloud?.localOnlyProjects)] }),
      worker: () => store.graph.workerStatus(),
    },
    inScope: async (key: string) => (await scope()).project(key),
    shown,
    importer: { knowledge, facts, embed, activity, portability: store.portability, excluded: config.excludeProjects },
    demo: {
      knowledge,
      facts,
      codegraph: store.codegraph,
      embed,
      activity,
      project: (key: string) => resolveProject({ project: key }, roots, { exists: existsSync }),
      selected: async (key: string) => (await selection.current()).tracked.includes(key),
    },
    integrations: {
      integrations,
      projects: integrationProjects,
      githubOverride: config.github.repos,
      syncMinutes: config.integrationSyncMinutes,
      activity,
    },
    sessions: {
      store: store.sessions,
      projects: async () => (await shown()).keys,
      inScope: async (key: string) => (await shown()).has(key),
    },
    runs: store.runs,
    evidence: {
      sessions: store.sessions,
      inScope: async (key: string) => (await shown()).has(key),
      candidateDetail: (id) => store.graph.candidateDetail(id),
      lessonDetail: (id) => knowledge.lessonDetail(id),
      sessionFiles: (id) => store.codegraph.sessionFiles(id),
      activity,
    },
    loop: {
      decisions: store.decisions,
      cursors: docs,
      activity,
      config: config.loop,
      lessonDetail: (id) => knowledge.lessonDetail(id),
      sessionDetail: (id) => store.sessions.detail(id),
      insights: store.insights,
      repeats: (id) => lessonRepeats(id, { loopMisses: (ids) => store.decisions.loopMisses(ids), relatedMisses: (q) => knowledge.relatedMisses(q) }),
      exec: decisionExecutor(store, { embed }),
    },
    auth: { runKeySalt, token: config.apiToken ?? undefined, ownerToken: config.ownerToken ?? undefined, publicHosts: config.publicHosts, operator: config.operator ?? undefined, sessionStateFile: join(settingsDir, 'owner-session-revocations.json') },
    system: { version: VERSION, store: store.kind, roots: roots.length, ping: () => store.ping(), worker: () => store.graph.workerStatus(), selection: () => selection.current(), givenUpTurns: () => store.graph.givenUpTurns(),
      agentSeen: () => store.graph.agentSeen(), markAgentSeen: (client, at) => store.graph.markAgentSeen(client, at),
      ...(env.CODEX_RUNNER_URL ? { runner: async () => reportedRunnerReadiness(await store.docs.getCursor(RUNNER_READINESS_CURSOR)) } : {}),
      // The embedding model always; the local chat model too when the api's check_before_done judge uses it.
      ollama: () => ollamaPing({ url: config.ollama.url, models: [config.ollama.embedModel, ...(judgeLlm.id.startsWith('ollama:') ? [judgeLlm.id.slice(7)] : [])], timeoutMs: 2000 }),
    },
    classifyQueue: store.graph,
    settings: {
      selection,
      folders: async () => (await allFolders()).map((f) => ({ key: f.key, path: f.path })),
      excluded: config.excludeProjects,
      roots: roots.map((r) => r.host.replace(/\/+$/, '')),
      savedRoots: config.rootsFile ? rootsFile(config.rootsFile) : undefined,
      hostHome: config.hostHome,
    },
    context: contextDeps,
    ...(intakeEnabled(env) && { intakeReview: { intake: store.intake, facts, embed, activity, conflicts: { store, exec: decisionExecutor(store, { embed }) } } }),
    chat: {
      store: store.chats,
      // As the asking request sees the stores (runScoped): a sandbox run's records reach only its own turns.
      build: chatPackBuilder({ context: contextDeps, codeMap: (k) => store.codegraph.codeMap(k), sessionFiles: (id) => store.codegraph.sessionFiles(id) }),
    },
    // Knowledge intake: dark until INTAKE_ENABLED. INTAKE_ARCHIVE=off keeps no original transcript anywhere.
    ...(intakeEnabled(env) ? { intake: { store: store.intake, archive: intakeArchive(env), decide: { store, exec: decisionExecutor(store, { embed }) } } } : {}),
    log,
  });
  return { app, closing };
}

/**
 * Renews the API's answer in its auth-state file (authState.ts), which the worker reads instead of the tokens: a token
 * counts only while the store answers, since an API without its store cannot take the owner's pause or rollback.
 */
export function authStateBeat(o: { file: string; configured: boolean; ping: () => Promise<boolean>; log: Log }) {
  return async () => {
    const ok = await o.ping().catch(() => false);
    await writeAuthState(o.file, o.configured && ok).catch((error: unknown) => o.log('auth state not written', { error: String(error) }));
  };
}

/**
 * The api's SIGTERM/SIGINT handler: the first signal stops it (requests in flight get `graceMs`, event streams end at
 * once, the browser reconnects to the new process), closes the store and exits 0; a later one is ignored. `forceMs`
 * after the first signal it exits 0 whatever is still open.
 */
export function shutdownHandler(o: { server: Server; closing: AbortController; store: Pick<Store, 'close'>; log: Log; exit: (code: number) => void; graceMs?: number; forceMs?: number }) {
  let stopping = false;
  return (signal: string) => {
    if (stopping) return;
    stopping = true;
    o.log('shutting down', { signal });
    setTimeout(() => o.exit(0), o.forceMs ?? 10_000).unref();
    void stopServer(o.server, o.closing, { graceMs: o.graceMs ?? 5000 }).then(async () => {
      await o.store.close();
      o.log('stopped');
      o.exit(0);
    });
  };
}
