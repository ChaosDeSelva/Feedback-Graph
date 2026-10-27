import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { ConfigError, credentialFile, githubRepoOfRemote, Integrations, loadConfig, makeProviderOr, redactSecrets, ollamaEmbed, ollamaPing, projectFolders, refreshLayout, shownProjects, storedSyncMemory, syncProjects, VERSION, worktreeGitArgs, type Project } from '@fb/core';
import { openStore } from '@fb/store-postgres';
import { Admission } from './admission.ts';
import { createApp } from './app.ts';
import { chatPackBuilder } from './chat.ts';
import { hashRepoFile, makeJudge, repoFileSize, resolveProject, type ContextDeps } from './context.ts';
import { readRepoDiff, readRepoPrNumbers, githubCommitPrLookup } from './diff.ts';
import { rootsFile } from './roots.ts';
import { stopServer, tuneServer } from './server.ts';

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (err) {
  log('fatal', { error: err instanceof ConfigError ? err.message : String(err) });
  process.exit(1);
}

let store: Awaited<ReturnType<typeof openStore>>;
try {
  store = await openStore(config);
  await store.ensureSchema();
} catch (err) {
  log('fatal', { store: config.store, error: redactSecrets(String(err)) });
  process.exit(1);
}
log('store', { store: store.kind });
const emb = await store.embeddings.check(config.ollama.embedModel);
if (!emb.ok) {
  log('fatal', { error: `OLLAMA_EMBED_MODEL is ${config.ollama.embedModel} but the stored vectors were embedded with ${emb.stored}; set it back or run the re-embed command (see README)` });
  process.exit(1);
}
const { knowledge, facts, activity, docs, selection } = store;
const embed = (input: string[]) => ollamaEmbed({ url: config.ollama.url, model: config.ollama.embedModel, input });

const localModel = `ollama:${config.ollama.model}`;
// A CLI CHECK_LLM never gets here: loadConfig refuses it (the api has no agent CLIs). A missing key still falls back.
const checkSpec = config.llm.check ?? localModel;
const { provider: judgeLlm, fellBack } = makeProviderOr(checkSpec, localModel, process.env);
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
const integrations = new Integrations(store.docs, process.env, config.integrationsFile ? credentialFile(config.integrationsFile) : null);
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
  judgeQueue: new Admission({ concurrency: config.check.concurrency, timeoutMs: Math.min(50_000, config.check.waitSeconds * 1000) }),
  activity,
  docs,
  inScope: async (key: string) => (await scope()).folder(key),
  // Global lessons reach any folder under a root that is not excluded; reading its sessions stays opt-in.
  servesGlobal: (key: string) => !config.excludeProjects.includes(key),
  exists: existsSync,
  fileHash: hashRepoFile,
  // Why a named file is not in the code map: over SCAN_MAX_BYTES (the worker does not parse it).
  fileSize: repoFileSize,
  mapMaxBytes: config.scanMaxBytes,
  // check_before_done with no diff: the change to files_changed, read-only from the mounted folder.
  ownPrNumbers: async (repoPath, task, projectKey) => {
    const [gitArgs, credential, linked, projects] = await Promise.all([
      worktreeGitArgs(repoPath, roots), integrations.credential('github'),
      projectKey ? integrations.link(projectKey) : null, integrationProjects(),
    ]);
    const repo = projectKey && (config.github.repos.get(projectKey) ?? githubRepoOfRemote(projects.find((p) => p.key === projectKey)?.remote ?? null));
    return readRepoPrNumbers(repoPath, task, { gitArgs,
      ...(repo && credential && linked?.github ? { associatedPulls: (sha: string) => commitPrs(repo, sha, credential.token) } : {}),
    });
  },
  repoDiff: async (repoPath: string, files: string[]) => readRepoDiff(repoPath, files, { gitArgs: await worktreeGitArgs(repoPath, roots) }),
  // Files an agent named that have no facts yet go to the front of the project's next scan.
  requestScan: (key: string, paths: string[]) => facts.requestFilesScan(key, paths),
  aliasOf: (key: string) => store.graph.projectByAlias(key),
  codegraph: store.codegraph,
  sessions: store.sessions,
  shown,
  links: store.links,
};

/** Aborted on SIGTERM: the event streams end at once instead of holding the restart for 10 s (stopServer). */
const closing = new AbortController();
const app = createApp(store.graph, {
  closing: closing.signal,
  staticDir: process.env.STATIC_DIR,
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
    memory: config.cloud ? storedSyncMemory(store.docs, config.cloud) : undefined,
    portability: store.portability,
    activity,
    projects: async () => syncProjects({ configured: config.cloud?.projects ?? [], selected: (await scope()).projects, excluded: config.excludeProjects }),
    worker: () => store.graph.workerStatus(),
  },
  inScope: async (key: string) => (await scope()).project(key),
  shown,
  importer: { knowledge, facts, embed, activity, excluded: config.excludeProjects },
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
  auth: { token: config.apiToken ?? undefined, publicHosts: config.publicHosts, operator: config.operator ?? undefined },
  system: { version: VERSION, store: store.kind, roots: roots.length, ping: () => store.ping(), worker: () => store.graph.workerStatus(), selection: () => selection.current(), givenUpTurns: () => store.graph.givenUpTurns(),
    // The embedding model always; the local chat model too when the api's check_before_done judge uses it.
    ollama: () => ollamaPing({ url: config.ollama.url, models: [config.ollama.embedModel, ...(judgeLlm.id.startsWith('ollama:') ? [judgeLlm.id.slice(7)] : [])], timeoutMs: 2000 }),
  },
  classifyQueue: store.graph,
  settings: {
    selection,
    folders: async () => (await allFolders()).map((f) => ({ key: f.key, path: f.path })),
    excluded: config.excludeProjects,
    roots: roots.map((r) => (r.host || r.container).replace(/\/+$/, '')),
    savedRoots: config.rootsFile ? rootsFile(config.rootsFile) : undefined,
    hostHome: config.hostHome,
  },
  context: contextDeps,
  chat: {
    store: store.chats,
    // As the asking request sees the stores (runScoped): a sandbox run's records reach only its own turns.
    build: chatPackBuilder({ context: contextDeps, codeMap: (k) => store.codegraph.codeMap(k), sessionFiles: (id) => store.codegraph.sessionFiles(id) }),
  },
  log,
});

// API_LISTEN is 0.0.0.0 inside the container (compose publishes it on API_BIND); otherwise API_BIND, loopback by default.
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.apiListen }) as Server;
tuneServer(server);
log('api listening', { port: config.port, version: VERSION, bind: config.apiBind, auth: config.apiToken ? 'token' : 'none (loopback only)', operator: config.operator ? config.operator.allow.join(',') : 'off', publicHosts: config.publicHosts, cloudSync: config.cloud ? new URL(config.cloud.url).host : 'off' });
if (!config.apiToken) log(`no API_TOKEN set: reachable on ${config.apiBind} only; setting API_BIND to anything but loopback requires API_TOKEN`);

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log('shutting down', { signal });
  setTimeout(() => process.exit(0), 10_000).unref();
  // Requests in flight get 5 s to finish; event streams end now (the browser reconnects to the new process).
  void stopServer(server, closing, { graceMs: 5000 }).then(async () => {
    await store.close();
    log('stopped');
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
