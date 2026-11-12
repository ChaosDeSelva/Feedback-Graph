import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig, projectScope, RUNNER_READINESS_CURSOR, storedSyncMemory, VERSION, type Config, type ProjectSelection, type Store, type WorkerStatus } from '@fb/core';
import { afterEach, expect, test } from 'vitest';
import { createApiService, openApiStore, shutdownHandler } from './service.ts';

const temps: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'fg-api-service-')); temps.push(d); return d; };
const logger = () => { const lines: { msg: string; extra?: object }[] = []; return { lines, log: (msg: string, extra?: object) => { lines.push({ msg, extra }); } }; };

/** A part of the store a test does not expect to be used: any call fails the request that made it. */
const unused = (name: string): never => new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : () => { throw new Error(`${name}.${String(k)} was not expected`); }) }) as never;

/** The store parts a started api reads on its own: the selection, the worker's candidates, health and close. */
function fakeStore(o: { tracked?: string[]; candidates?: { key: string; path: string; remote: string | null }[] | null; embedded?: string; scopeFails?: boolean; worker?: WorkerStatus } = {}) {
  let selection: ProjectSelection = { tracked: o.tracked ?? [], initialized: true, updatedAt: null };
  const calls: string[] = [];
  const cursors = new Map<string, string>();
  const store = {
    kind: 'postgres',
    ensureSchema: async () => { calls.push('ensureSchema'); },
    ping: async () => true,
    close: async () => { calls.push('close'); },
    embeddings: { check: async (model: string) => ({ ok: !o.embedded || o.embedded === model, stored: o.embedded ?? model }) },
    selection: {
      ensure: async () => { calls.push('ensure'); return { selection, seeded: false }; },
      current: async () => selection,
      aliases: async () => new Map<string, string>(),
      scope: async (env: Pick<Config, 'excludeProjects'>) => { if (o.scopeFails) throw new Error('graph down'); return projectScope(selection, env); },
      // Null: the worker has not listed the candidates yet.
      candidates: async () => (o.candidates === null ? null : { candidates: (o.candidates ?? []).map((c) => ({ ...c, exists: true, git: true, claudeSessions: 1, codexSessions: 0, lastActivity: null })) }),
      keysWithData: async () => [],
      setTracked: async (tracked: string[]) => { const before = selection.tracked; selection = { ...selection, tracked }; return { before, selection }; },
    },
    facts: { listProjects: async () => [] },
    graph: { workerStatus: async () => o.worker ?? null, givenUpTurns: async () => 0, agentSeen: async () => null, projectByAlias: async () => null },
    activity: { record: async () => {}, list: async () => [] },
    links: { listLinks: async () => [] },
    docs: {
      getCursor: async (k: string) => cursors.get(k) ?? null,
      setCursor: async (k: string, v: string) => { cursors.set(k, v); },
      deleteCursor: async (k: string) => { cursors.delete(k); },
      cursorsWithPrefix: async (prefix: string) => [...cursors].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    },
    knowledge: unused('knowledge'), insights: unused('insights'), portability: unused('portability'),
    codegraph: unused('codegraph'), sessions: unused('sessions'), chats: unused('chats'), runs: unused('runs'),
  };
  return { store: store as unknown as Store, calls };
}

function configFor(root: string, extra: NodeJS.ProcessEnv = {}) {
  const env = { STORE: 'postgres', DATABASE_URL: 'postgres://fg:s3cretEXAMPLE@db:5432/fg', PROJECT_ROOTS: root, HOST_PROJECT_ROOTS: root, INTEGRATIONS_FILE: join(root, '..', 'settings', 'integrations.json'), REDACTION_ARCHIVE_DIR: join(root, '..', 'archive'), ...extra };
  return { env, config: loadConfig(env) };
}

test('the store must open, migrate and hold vectors from OLLAMA_EMBED_MODEL, or the api does not start', async () => {
  const { config } = configFor(temp());
  const refused = logger();
  expect(await openApiStore(config, async () => { throw new Error('connect ECONNREFUSED postgres://fg:s3cretEXAMPLE@db:5432/fg'); }, refused.log)).toBeNull();
  expect(refused.lines).toEqual([{ msg: 'fatal', extra: { store: 'postgres', error: 'Error: connect ECONNREFUSED postgres://fg:[REDACTED]@db:5432/fg' } }]);

  const failing = logger();
  const migrating = fakeStore();
  migrating.store.ensureSchema = async () => { throw new Error('migration 12 failed'); };
  expect(await openApiStore(config, async () => migrating.store, failing.log)).toBeNull();
  expect(failing.lines[0].msg).toBe('fatal');

  const other = logger();
  expect(await openApiStore(config, async () => fakeStore({ embedded: 'other-embed' }).store, other.log)).toBeNull();
  expect(other.lines.at(-1)).toEqual({ msg: 'fatal', extra: { error: expect.stringMatching(`^OLLAMA_EMBED_MODEL is ${config.ollama.embedModel} but the stored vectors were embedded with other-embed`) } });

  const ok = logger();
  const good = fakeStore();
  expect(await openApiStore(config, async () => good.store, ok.log)).toBe(good.store);
  expect(good.calls).toEqual(['ensureSchema']);
  expect(ok.lines).toEqual([{ msg: 'store', extra: { store: 'postgres' } }]);
});

async function started(store: Store, root: string, extra: NodeJS.ProcessEnv = {}) {
  const { env, config } = configFor(root, extra);
  const { lines, log } = logger();
  const { app, closing } = await createApiService(config, store, env, log);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  servers.push(server);
  await new Promise((ok) => server.once('listening', ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lines, closing, env };
}

test('a started api serves its health and lists the selected folders under its roots with the remotes the worker read', async () => {
  const root = join(temp(), 'code');
  for (const dir of ['alpha', 'beta', '.hidden']) mkdirSync(join(root, dir), { recursive: true });
  // The worker's last candidate list knows alpha's remote; beta is new since.
  const { store, calls } = fakeStore({ tracked: ['alpha'], candidates: [{ key: 'alpha', path: join(root, 'alpha'), remote: 'github.com/org/alpha' }] });
  const api = await started(store, root);
  expect(calls).toContain('ensure');
  expect(await (await fetch(`${api.url}/api/health`)).json()).toEqual({ ok: true });
  const status = await (await fetch(`${api.url}/api/status`)).json();
  expect(status).toMatchObject({ version: VERSION, store: 'postgres', selection: { tracked: 1, roots: 1 } });
  const projects = await (await fetch(`${api.url}/api/projects`)).json();
  expect(projects).toEqual([expect.objectContaining({ key: 'alpha', repoPath: join(root, 'alpha'), remote: 'github.com/org/alpha', sessions: 0 })]);
  // The hooks' and MCP's project lookup resolves a cwd to the selected folder it is in.
  expect(await (await fetch(`${api.url}/api/agent/project?cwd=${encodeURIComponent(join(root, 'alpha', 'src'))}`)).json()).toMatchObject({ tracked: true, project: 'alpha' });
  expect(await (await fetch(`${api.url}/api/agent/project?cwd=${encodeURIComponent(join(root, 'beta'))}`)).json()).toMatchObject({ tracked: false });
  // Settings lists every folder, selected or not, with its host path.
  const settings = await (await fetch(`${api.url}/api/settings/projects`)).json();
  expect(settings.candidates.map((c: { key: string; path: string; tracked: boolean }) => [c.key, c.path, c.tracked])).toEqual([['alpha', join(root, 'alpha'), true], ['beta', join(root, 'beta'), false]]);
  // GitHub reads each selected project's repository from the remote the worker read.
  const integrations = await (await fetch(`${api.url}/api/settings/integrations`)).json();
  expect(integrations.projects).toEqual([expect.objectContaining({ key: 'alpha', github: expect.objectContaining({ repo: 'org/alpha' }) })]);
  expect(existsSync(api.env.REDACTION_ARCHIVE_DIR!)).toBe(true);
  expect(api.closing.signal.aborted).toBe(false);
});

test('a project layout the selection cannot be read for is logged and the api still starts', async () => {
  const root = join(temp(), 'code');
  mkdirSync(join(root, 'alpha'), { recursive: true });
  const api = await started(fakeStore({ scopeFails: true }).store, root);
  expect(api.lines).toContainEqual({ msg: 'project layout failed', extra: { error: 'Error: graph down' } });
  expect((await fetch(`${api.url}/api/health`)).status).toBe(200);
});

test('a check model that cannot be built falls back to the local model, and says so', async () => {
  const root = join(temp(), 'code');
  mkdirSync(root, { recursive: true });
  const api = await started(fakeStore().store, root, { CHECK_LLM: 'anthropic:claude-sonnet-4-5', ANTHROPIC_API_KEY: '' });
  expect(api.lines).toContainEqual({ msg: 'check provider unavailable, using fallback', extra: { fellBack: expect.stringContaining('anthropic:claude-sonnet-4-5'), using: expect.stringMatching(/^ollama:/) } });
});

test('owner-session revocations are kept in the api settings folder, so a restart outside Docker does not reset the sessions', async () => {
  const base = temp();
  const root = join(base, 'code');
  mkdirSync(root, { recursive: true });
  const settings = join(base, 'my-settings');
  const extra = { ROOTS_FILE: join(settings, 'project-roots.json'), OWNER_TOKEN: 'o'.repeat(40) };
  const first = await started(fakeStore().store, root, extra);
  const file = join(settings, 'owner-session-revocations.json');
  // A first start writes the file (there is no earlier session to refuse) and says so once.
  expect(first.lines).toContainEqual({ msg: 'owner sessions reset', extra: { reason: expect.stringContaining(`${file} was missing and is now written`) } });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ revoked: {} });
  const again = await started(fakeStore().store, root, extra);
  expect(again.lines.map((l) => l.msg)).not.toContain('owner sessions reset');
  // The run-key salt sits beside it.
  expect(existsSync(join(settings, '.run-key-salt'))).toBe(true);
});

test('without ROOTS_FILE the settings folder is the integrations file\'s, and the redaction archive defaults to beside it', async () => {
  const base = temp();
  const root = join(base, 'code');
  mkdirSync(root, { recursive: true });
  const api = await started(fakeStore().store, root, { REDACTION_ARCHIVE_DIR: undefined });
  const settings = join(base, 'settings');
  expect(existsSync(join(settings, 'owner-session-revocations.json'))).toBe(true);
  expect(existsSync(join(settings, '.run-key-salt'))).toBe(true);
  expect(existsSync(join(settings, 'redaction-archive'))).toBe(true);
  // Settings cannot save roots without ROOTS_FILE.
  expect((await (await fetch(`${api.url}/api/settings/projects`)).json()).rootsEditable).toBe(false);
});

test('with neither ROOTS_FILE nor INTEGRATIONS_FILE the api keeps its settings under ./state/settings', async () => {
  const base = temp();
  const root = join(base, 'code');
  mkdirSync(root, { recursive: true });
  const cwd = process.cwd();
  process.chdir(base);
  try {
    await started(fakeStore().store, root, { INTEGRATIONS_FILE: undefined, REDACTION_ARCHIVE_DIR: undefined });
  } finally {
    process.chdir(cwd);
  }
  for (const f of ['owner-session-revocations.json', '.run-key-salt', 'redaction-archive']) expect(existsSync(join(base, 'state', 'settings', f)), f).toBe(true);
});

test('Settings can save roots when ROOTS_FILE is set', async () => {
  const base = temp();
  const root = join(base, 'code');
  mkdirSync(root, { recursive: true });
  const api = await started(fakeStore().store, root, { ROOTS_FILE: join(base, 'settings', 'project-roots.json') });
  expect((await (await fetch(`${api.url}/api/settings/projects`)).json()).rootsEditable).toBe(true);
});

test('selected folders the worker has not read a remote for (or no candidate list yet) have no remote', async () => {
  const root = join(temp(), 'code');
  for (const dir of ['alpha', 'beta']) mkdirSync(join(root, dir), { recursive: true });
  const some = await started(fakeStore({ tracked: ['alpha', 'beta'], candidates: [{ key: 'alpha', path: join(root, 'alpha'), remote: 'github.com/org/alpha' }] }).store, root);
  expect((await (await fetch(`${some.url}/api/projects`)).json()).map((p: { key: string; remote: string | null }) => [p.key, p.remote])).toEqual([['alpha', 'github.com/org/alpha'], ['beta', null]]);
  expect((await (await fetch(`${some.url}/api/settings/integrations`)).json()).projects).toEqual([
    expect.objectContaining({ key: 'alpha', github: expect.objectContaining({ repo: 'org/alpha' }) }),
    expect.objectContaining({ key: 'beta', github: expect.objectContaining({ repo: null }) }),
  ]);
  const none = await started(fakeStore({ tracked: ['alpha'], candidates: null }).store, root);
  expect((await (await fetch(`${none.url}/api/projects`)).json()).map((p: { key: string; remote: string | null }) => [p.key, p.remote])).toEqual([['alpha', null]]);
  expect((await (await fetch(`${none.url}/api/settings/integrations`)).json()).projects).toEqual([expect.objectContaining({ key: 'alpha', github: expect.objectContaining({ repo: null }) })]);
});

test('with Cloud configured, the last Sync now the worker or another api recorded is the one the api reports', async () => {
  const root = join(temp(), 'code');
  mkdirSync(root, { recursive: true });
  const cloudEnv = { CLOUD_URL: 'http://localhost:9', CLOUD_TOKEN: `fgc_pat_${'0'.repeat(16)}_${'a'.repeat(43)}` };
  const { store } = fakeStore();
  const api = await started(store, root, cloudEnv);
  const sent = { projects: 1, lessons: 2, misses: 0, facts: 0, docs: 0, codeFiles: 0 };
  await storedSyncMemory(store.docs, loadConfig({ ...api.env }).cloud!).recordLast!({
    at: '2026-11-01T10:00:00.000Z', trigger: 'manual', host: 'localhost:9', ok: true, sent, error: null, stopped: false,
    projects: [{ key: 'alpha', status: 'sent', counts: sent }],
  });
  expect(await (await fetch(`${api.url}/api/cloud/progress`)).json()).toEqual({ running: null, lastManual: expect.objectContaining({ at: '2026-11-01T10:00:00.000Z', ok: true, sent }) });
});

test('a codex-cli job is reported down while the runner readiness the worker stored says so, only with CODEX_RUNNER_URL set', async () => {
  const root = join(temp(), 'code');
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  const worker: WorkerStatus = { version: VERSION, startedAt: now, lastBeat: now, lastCycleAt: null, lastCycle: null, lastError: null, providers: { classify: 'ollama:m', scan: 'codex-cli:gpt-5' } };
  const scanHealth = async (extra: NodeJS.ProcessEnv) => {
    const { store } = fakeStore({ worker });
    await store.docs.setCursor(RUNNER_READINESS_CURSOR, JSON.stringify({ ok: false, reason: 'codex is not logged in', at: Date.now() }));
    const api = await started(store, root, { OLLAMA_URL: 'http://127.0.0.1:9', ...extra });
    return (await (await fetch(`${api.url}/api/status`)).json()).models.scan;
  };
  expect(await scanHealth({})).toEqual({ provider: 'codex-cli:gpt-5', ok: true, reason: null });
  expect(await scanHealth({ CODEX_RUNNER_URL: 'http://127.0.0.1:9' })).toEqual({ provider: 'codex-cli:gpt-5', ok: false, reason: 'codex is not logged in' });
});

test('status needs the local chat model pulled only when the check judge runs on it', async () => {
  const root = join(temp(), 'code');
  mkdirSync(root, { recursive: true });
  const embedModel = configFor(root).config.ollama.embedModel;
  // An Ollama with only the embedding model pulled.
  const ollama = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ name: embedModel }] })); });
  servers.push(ollama);
  await new Promise<void>((ok) => ollama.listen(0, '127.0.0.1', ok));
  const OLLAMA_URL = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
  const local = await started(fakeStore().store, root, { OLLAMA_URL });
  expect((await (await fetch(`${local.url}/api/status`)).json()).ollama).toMatchObject({ ok: false, reason: expect.stringContaining('is not pulled') });
  const remote = await started(fakeStore().store, root, { OLLAMA_URL, CHECK_LLM: 'anthropic:claude-sonnet-4-5', ANTHROPIC_API_KEY: 'sk-ant-test' });
  expect((await (await fetch(`${remote.url}/api/status`)).json()).ollama).toMatchObject({ ok: true });
});

async function slowServer(ms: number) {
  const server = createServer((_req, res) => { setTimeout(() => res.end('done'), ms); });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('the first signal lets requests in flight finish, ends event streams, closes the store and exits 0; later ones are ignored', async () => {
  const { server, url } = await slowServer(200);
  const { lines, log } = logger();
  const closing = new AbortController();
  const exits: number[] = [];
  const order: string[] = [];
  let exited!: () => void;
  const done = new Promise<void>((ok) => { exited = ok; });
  const shutdown = shutdownHandler({ server, closing, store: { close: async () => { order.push('store closed'); } }, log, exit: (code) => { exits.push(code); order.push('exit'); exited(); } });
  const inFlight = fetch(url).then((r) => r.text());
  await new Promise((ok) => setTimeout(ok, 50));
  shutdown('SIGTERM');
  shutdown('SIGINT');
  expect(closing.signal.aborted).toBe(true);
  expect(await inFlight).toBe('done');
  await done;
  expect(order).toEqual(['store closed', 'exit']);
  expect(exits).toEqual([0]);
  expect(lines).toEqual([{ msg: 'shutting down', extra: { signal: 'SIGTERM' } }, { msg: 'stopped', extra: undefined }]);
});

test('a store that never closes cannot hold the exit past the force deadline', async () => {
  const { server } = await slowServer(0);
  const exits: number[] = [];
  let exited!: () => void;
  const done = new Promise<void>((ok) => { exited = ok; });
  shutdownHandler({ server, closing: new AbortController(), store: { close: () => new Promise<void>(() => {}) }, log: () => {}, exit: (code) => { exits.push(code); exited(); }, forceMs: 100 })('SIGTERM');
  await done;
  expect(exits).toEqual([0]);
});
