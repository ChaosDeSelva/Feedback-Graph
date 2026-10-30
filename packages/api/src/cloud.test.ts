import { storedSyncMemory, EXPORT_FORMAT, type Activity, type ActivityInput, type CloudConfig, type ExportBundle, type WorkerStatus } from '@fb/core';
import { expect, test, vi } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { CloudDeps } from './cloud.ts';

const TOKEN = `fgc_pat_0123456789abcdef_${'Q'.repeat(43)}`;
const cloud: CloudConfig = { url: 'https://cloud.example.com', token: TOKEN, intervalMinutes: 60, projects: [], suggestions: false, machine: null };
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;

const bundle = (key: string): ExportBundle => ({
  format: EXPORT_FORMAT, schemaVersion: 1, toolVersion: '0.2.0', exportedAt: '2026-10-23T10:00:00Z', projectKey: key,
  projects: [{ key, remote: `github.com/acme/${key}` }],
  lessons: [{ id: `lesson:${key}`, projectKey: key, title: 'T', rule: 'R', appliesWhen: '', scope: 'project', paths: [], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' }],
  misses: [], facts: [], docs: [], codeFiles: [],
});

const syncOk = { syncId: 's1', org: 'acme', projects: [{ localKey: 'shop', key: 'github.com/acme/shop', remote: 'github.com/acme/shop', namespace: 'team' }], lessons: { team: 1, suggested: 0, skipped: 0 }, misses: 0, facts: { files: 0, unchanged: 0 }, docs: 0 };

function deps(o: Partial<CloudDeps> = {}) {
  const log: Activity[] = [];
  const fetchCalls: string[] = [];
  const d: CloudDeps = {
    cloud,
    portability: { exportData: async (q) => bundle(q?.projectKey ?? '') },
    activity: {
      record: async (a: ActivityInput) => { log.unshift({ ...a, details: a.details ?? {}, targets: a.targets ?? [], id: `a${log.length}`, ts: '2026-10-23T10:00:00.000Z' }); },
      list: async (q) => log.filter((a) => !q.kind || a.kind === q.kind).slice(0, q.limit ?? 100),
    },
    projects: async () => ['shop'],
    worker: async () => null,
    fetch: (async (url: string) => { if (url.endsWith('/sync-policy')) return new Response(null, { status: 404 }); fetchCalls.push(url); return Response.json(syncOk); }) as unknown as typeof fetch,
    ...o,
  };
  return { d, log, fetchCalls };
}

const post = (origin?: string) => ({ method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...(origin ? { origin, 'sec-fetch-site': 'same-origin' } : {}) } });

test('with cloud sync off, the card says so and Sync now refuses; nothing is sent', async () => {
  const { d, fetchCalls } = deps({ cloud: null });
  const app = createApp(repo, { cloud: d });
  const info = await (await app.request('/api/cloud')).json();
  expect(info).toMatchObject({ enabled: false, host: null, last: null, preview: null });
  expect(info.neverSent).toMatch(/transcripts/);
  const res = await app.request('/api/cloud/sync', post('http://localhost'));
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/CLOUD_URL/);
  expect(fetchCalls).toHaveLength(0);
});

test('the card shows the host, schedule, projects and what a sync would send; never the token', async () => {
  const { d } = deps();
  const app = createApp(repo, { cloud: d });
  const res = await app.request('/api/cloud');
  const text = await res.text();
  expect(text).not.toContain(TOKEN);
  const info = JSON.parse(text);
  expect(info).toMatchObject({ enabled: true, host: 'cloud.example.com', intervalMinutes: 60, suggestions: false, projects: ['shop'], last: null });
  expect(info.preview.total).toMatchObject({ projects: 1, lessons: 1 });
});

test('Sync now is yours only: a request without a browser Origin is refused', async () => {
  const { d, fetchCalls } = deps();
  const app = createApp(repo, { cloud: d });
  expect((await app.request('/api/cloud/sync', post())).status).toBe(403);
  expect(fetchCalls).toHaveLength(0);
});

test('Sync now from the UI sends, records Activity, and the card then shows the last sync', async () => {
  const { d, log, fetchCalls } = deps();
  const app = createApp(repo, { cloud: d });
  const res = await app.request('/api/cloud/sync', post('http://localhost'));
  expect(res.status).toBe(200);
  const r = await res.json();
  expect(r).toMatchObject({ ok: true, host: 'cloud.example.com', sent: { lessons: 1 } });
  expect(fetchCalls).toEqual(['https://cloud.example.com/api/v1/sync']);
  expect(log.map((a) => [a.kind, a.actor])).toEqual([['cloud_synced', 'you']]);
  const info = await (await app.request('/api/cloud')).json();
  expect(info.last).toMatchObject({ at: '2026-10-23T10:00:00.000Z', ok: true, trigger: 'manual', error: null, sent: { lessons: 1 }, projects: ['shop'] });
});

test('a failed sync is reported with its reason, and the card shows the error', async () => {
  const { d } = deps({ fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch });
  const app = createApp(repo, { cloud: d });
  const r = await (await app.request('/api/cloud/sync', post('http://localhost'))).json();
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/refused the token/);
  expect((await (await app.request('/api/cloud')).json()).last).toMatchObject({ ok: false, error: expect.stringMatching(/refused the token/) });
});

test('one Sync now at a time', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { d } = deps({ fetch: (async () => { await gate; return Response.json(syncOk); }) as unknown as typeof fetch });
  const app = createApp(repo, { cloud: d });
  const first = app.request('/api/cloud/sync', post('http://localhost'));
  await new Promise((r) => setTimeout(r, 5));
  expect((await app.request('/api/cloud/sync', post('http://localhost'))).status).toBe(409);
  release();
  expect((await first).status).toBe(200);
});

test('the card shows when the worker syncs next', async () => {
  const worker = { cloudSync: { host: 'cloud.example.com', intervalMinutes: 60, lastAt: null, lastOk: null, lastError: null, lastSent: null, nextAt: '2026-10-23T11:00:00.000Z', failures: 0 } } as unknown as WorkerStatus;
  const { d } = deps({ worker: async () => worker });
  const info = await (await createApp(repo, { cloud: d }).request('/api/cloud')).json();
  expect(info.nextAt).toBe('2026-10-23T11:00:00.000Z');
});

test('/api/status says whether cloud sync is on, with the token redacted', async () => {
  const { d } = deps();
  const app = createApp(repo, { cloud: d, system: { version: '0.2.0', ping: async () => true, worker: async () => null } });
  const text = await (await app.request('/api/status')).text();
  expect(text).not.toContain(TOKEN);
  expect(JSON.parse(text).cloud).toEqual({ host: 'cloud.example.com', token: '[REDACTED]', intervalMinutes: 60, lastManual: null, syncing: null });
  const off = createApp(repo, { cloud: deps({ cloud: null }).d, system: { version: '0.2.0', ping: async () => true, worker: async () => null } });
  expect((await (await off.request('/api/status')).json()).cloud).toBeNull();
});

test('Sync now sends only what changed since the last sync, and resends everything with force', async () => {
  const { d, fetchCalls, log } = deps({ memory: new Map() });
  const app = createApp(repo, { cloud: d });
  await app.request('/api/cloud/sync', post('http://localhost'));
  const again = await (await app.request('/api/cloud/sync', post('http://localhost'))).json();
  expect(again.projects).toEqual([expect.objectContaining({ key: 'shop', status: 'unchanged' })]);
  expect(fetchCalls).toHaveLength(1);
  expect(log[0].subject).toMatch(/^nothing to send/);
  const forced = await app.request('/api/cloud/sync', { ...post('http://localhost'), body: JSON.stringify({ force: true }) });
  expect(forced.status).toBe(200);
  expect(fetchCalls).toHaveLength(2);
  expect((await app.request('/api/cloud/sync', { ...post('http://localhost'), body: JSON.stringify({ force: 'yes' }) })).status).toBe(400);
});

test('a running Sync now reports its progress; afterwards /api/status shows when it ran and what it sent', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { d } = deps({ projects: async () => ['shop', 'blog'], fetch: (async () => { await gate; return Response.json(syncOk); }) as unknown as typeof fetch });
  const app = createApp(repo, { cloud: d, system: { version: '0.5.0', ping: async () => true, worker: async () => null } });
  expect(await (await app.request('/api/cloud/progress')).json()).toEqual({ running: null, lastManual: null });
  const run = app.request('/api/cloud/sync', post('http://localhost'));
  await new Promise((r) => setTimeout(r, 5));
  const during = await (await app.request('/api/cloud/progress')).json();
  expect(during.running).toMatchObject({ done: 0, total: 2, current: 'shop', startedAt: expect.any(String) });
  expect((await (await app.request('/api/status')).json()).cloud.syncing).toMatchObject({ done: 0, total: 2 });
  release();
  await run;
  const after = await (await app.request('/api/cloud/progress')).json();
  expect(after.running).toBeNull();
  expect(after.lastManual).toMatchObject({ ok: true, sent: { lessons: 2 }, unchanged: 0, error: null, at: expect.any(String) });
  const status = await (await app.request('/api/status')).json();
  expect(status.cloud.lastManual).toMatchObject({ ok: true });
  // The connection line counts a manual sync too, not only the worker's schedule.
  expect(status.connections.cloud.detail).toMatch(/last sync/);
});

test('preview errors do not break the card', async () => {
  const { d } = deps({ portability: { exportData: vi.fn(async () => { throw new Error('store down'); }) } });
  const res = await createApp(repo, { cloud: d }).request('/api/cloud');
  expect(res.status).toBe(200);
  expect((await res.json()).preview).toBeNull();
});


test('local-only settings are owner protected, durable, and prevent forced manual export', async () => {
  const saved = new Map<string, string>();
  const localOnlyStore = { getCursor: async (key: string) => saved.get(key) ?? null, setCursor: async (key: string, value: string) => { saved.set(key, value); } };
  const { d, fetchCalls } = deps({ localOnlyStore });
  const app = createApp(repo, { cloud: d });
  const request = (origin?: string) => ({ method: 'PUT', body: JSON.stringify({ projects: ['shop'] }), headers: { 'content-type': 'application/json', ...(origin ? { origin, 'sec-fetch-site': 'same-origin' } : {}) } });
  expect((await app.request('/api/cloud/local-only', request())).status).toBe(403);
  expect((await app.request('/api/cloud/local-only', request('http://localhost'))).status).toBe(200);
  expect((await (await app.request('/api/cloud')).json()).projects).toEqual([]);
  const result = await app.request('/api/cloud/sync', { ...post('http://localhost'), body: JSON.stringify({ force: true }) });
  expect(result.status).toBe(200);
  expect(fetchCalls).toEqual([]);
  const restarted = createApp(repo, { cloud: { ...d, localOnlyStore } });
  expect((await (await restarted.request('/api/cloud')).json()).localOnlyProjects).toEqual(['shop']);
});


test('only an explicit owner sharing setting converts a demo-created project, and internal provenance never goes on the wire', async () => {
  const saved = new Map<string, string>();
  const localOnlyStore = { getCursor: async (key: string) => saved.get(key) ?? null, setCursor: async (key: string, value: string) => { saved.set(key, value); } };
  const posts: string[] = [];
  const { d } = deps({ localOnlyStore, portability: { exportData: async () => ({ ...bundle('shop'), projects: [{ key: 'shop', remote: 'github.com/acme/shop', demoCreated: true }] }) },
    fetch: (async (url: string, init: RequestInit) => { if (url.endsWith('/sync-policy')) return new Response(null, { status: 404 }); posts.push(init.body as string); return Response.json(syncOk); }) as unknown as typeof fetch });
  const app = createApp(repo, { cloud: d });
  await app.request('/api/cloud/sync', { ...post('http://localhost'), body: JSON.stringify({ force: true }) });
  expect(posts).toEqual([]);
  const preview = await (await app.request('/api/cloud')).json();
  expect(preview.preview.projects[0].reason).toContain('Created by demo seed');
  const write = (origin?: string) => ({ method: 'PUT', body: JSON.stringify({ projects: [], shareDemoProjects: ['shop'] }), headers: { 'content-type': 'application/json', ...(origin ? { origin, 'sec-fetch-site': 'same-origin' } : {}) } });
  expect((await app.request('/api/cloud/local-only', write())).status).toBe(403);
  expect(saved.size).toBe(0);
  expect((await app.request('/api/cloud/local-only', write('http://localhost'))).status).toBe(200);
  await app.request('/api/cloud/sync', { ...post('http://localhost'), body: JSON.stringify({ force: true }) });
  expect(posts).toHaveLength(1);
  expect(posts[0]).not.toContain('demoCreated');
  expect(JSON.parse(posts[0]).projects).toEqual([{ key: 'shop', remote: 'github.com/acme/shop' }]);
});


test('cloud preview explains an unselected project without selecting or sending it', async () => {
  const { d } = deps(); const app = createApp(repo, { cloud: { ...d, projects: async () => [] } });
  const res = await app.request('/api/cloud?project=demo-shop');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.projects).toEqual([]);
  expect(body.preview.projects).toContainEqual({ key: 'demo-shop', counts: null, reason: expect.stringMatching(/not selected/) });
});


test('API restart restores last sync and manual status after Activity retention removes its entry', async () => {
  const values = new Map<string, string>();
  const docs = { getCursor: async (key: string) => values.get(key) ?? null, setCursor: async (key: string, value: string) => { values.set(key, value); },
    deleteCursor: async (key: string) => { values.delete(key); }, cursorsWithPrefix: async (prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
  const { d, log } = deps({ memory: storedSyncMemory(docs, cloud) });
  const first = createApp(repo, { cloud: d });
  expect((await first.request('/api/cloud/sync', post('http://localhost'))).status).toBe(200);
  log.splice(0);
  const restarted = createApp(repo, { cloud: { ...d, memory: storedSyncMemory(docs, cloud) } });
  expect((await (await restarted.request('/api/cloud')).json()).last).toMatchObject({ ok: true, trigger: 'manual', sent: { lessons: 1 } });
  expect((await (await restarted.request('/api/cloud/progress')).json()).lastManual).toMatchObject({ ok: true, sent: { lessons: 1 } });
  expect((await (await restarted.request('/api/status')).json()).cloud.lastManual).toMatchObject({ ok: true, sent: { lessons: 1 } });
});
