import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { ConfigError, loadConfig, makeProvider, makeProviderOr, redactSecrets, ollamaEmbed, ollamaPing, syncProjects, VERSION, type Project } from '@fb/core';
import { openStore } from '@fb/store-postgres';
import { createApp } from './app.ts';
import { makeJudge } from './context.ts';

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
// The api image has no claude/codex CLIs: a CLI CHECK_LLM falls back to the local model instead of crashing.
const isCli = (spec: string) => /^(claude|codex)-cli/.test(spec);
const checkSpec = config.llm.check ?? localModel;
const { provider: judgeLlm, fellBack } = isCli(checkSpec)
  ? { provider: makeProvider(localModel, process.env), fellBack: `${checkSpec}: CLI providers run in the worker, not the api` }
  : makeProviderOr(checkSpec, localModel, process.env);
if (fellBack) log('check provider unavailable, using fallback', { fellBack, using: judgeLlm.id });
const roots = config.roots;
// The worker normally seeds the selection first; whichever service starts first does it, and only once.
await selection.ensure(config, activity);
/** Read per request: the selection changes from Settings at any time. */
const scope = () => selection.scope(config);

/** Every top-level folder under each root (no dot-folders, no symlinks), with its host path. */
async function allFolders(): Promise<(Project & { path: string })[]> {
  const out: (Project & { path: string })[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    for (const d of await readdir(r.container, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory() || d.name.startsWith('.') || seen.has(d.name)) continue;
      seen.add(d.name);
      out.push({ key: d.name, name: d.name, repoPath: `${r.container}/${d.name}`, path: `${(r.host || r.container).replace(/\/+$/, '')}/${d.name}` });
    }
  }
  return out;
}

/** The folders that are in scope: selected in Settings and not in EXCLUDE_PROJECTS. */
async function projectDirs(): Promise<Project[]> {
  const s = await scope();
  return (await allFolders()).filter((f) => s.folder(f.key)).map(({ path: _, ...p }) => p);
}

const app = createApp(store.graph, {
  staticDir: process.env.STATIC_DIR,
  knowledge,
  embed,
  facts,
  projectDirs,
  insights: store.insights,
  activity,
  docs,
  portability: store.portability,
  codegraph: store.codegraph,
  cloud: {
    cloud: config.cloud,
    portability: store.portability,
    activity,
    projects: async () => syncProjects({ configured: config.cloud?.projects ?? [], selected: (await scope()).projects, excluded: config.excludeProjects }),
    worker: () => store.graph.workerStatus(),
  },
  inScope: async (key: string) => (await scope()).project(key),
  importer: { knowledge, facts, embed, activity, excluded: config.excludeProjects },
  auth: { token: config.apiToken ?? undefined, publicHosts: config.publicHosts },
  system: { version: VERSION, store: store.kind, ping: () => store.ping(), worker: () => store.graph.workerStatus(), selection: () => selection.current(), givenUpTurns: () => store.graph.givenUpTurns(),
    // The embedding model always; the local chat model too when the api's check_before_done judge uses it.
    ollama: () => ollamaPing({ url: config.ollama.url, models: [config.ollama.embedModel, ...(judgeLlm.id.startsWith('ollama:') ? [judgeLlm.id.slice(7)] : [])], timeoutMs: 2000 }),
  },
  classifyQueue: store.graph,
  settings: {
    selection,
    folders: async () => (await allFolders()).map((f) => ({ key: f.key, path: f.path })),
    excluded: config.excludeProjects,
    roots: roots.map((r) => (r.host || r.container).replace(/\/+$/, '')),
  },
  context: {
    roots,
    facts,
    embed,
    k: knowledge,
    judge: makeJudge(judgeLlm),
    judgeId: judgeLlm.id,
    activity,
    docs,
    inScope: async (key: string) => (await scope()).folder(key),
    // Global lessons reach any folder under a root that is not excluded; reading its sessions stays opt-in.
    servesGlobal: (key: string) => !config.excludeProjects.includes(key),
    exists: existsSync,
    aliasOf: (key: string) => store.graph.projectByAlias(key),
    codegraph: store.codegraph,
  },
  log,
});

// API_LISTEN is 0.0.0.0 inside the container (compose publishes it on API_BIND); otherwise API_BIND, loopback by default.
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.apiListen });
log('api listening', { port: config.port, version: VERSION, bind: config.apiBind, auth: config.apiToken ? 'token' : 'none (loopback only)', publicHosts: config.publicHosts, cloudSync: config.cloud ? new URL(config.cloud.url).host : 'off' });
if (!config.apiToken) log(`no API_TOKEN set: reachable on ${config.apiBind} only; setting API_BIND to anything but loopback requires API_TOKEN`);

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log('shutting down', { signal });
  setTimeout(() => process.exit(0), 10_000).unref();
  server.close(async () => {
    await store.close();
    log('stopped');
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
