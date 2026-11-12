import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFile, emptySyncState, FEEDBACK_SKIP_RULES, Integrations, tokenFingerprint, type Activity, type ActivityInput, type CloudConfig, type WorkerStatus } from '@fb/core';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { connectionsStatus, integrationsView, type IntegrationsDeps } from './integrations.ts';

const repo = { undoDecision: async () => false, listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;
const OWNER = 'owner-test-token-01234567890123456789';
const GH = ['github', 'pat', '11AAAA', 'x'.repeat(40)].join('_');
const LINEAR = 'lin_api_' + 'k'.repeat(20);
const kv = () => { const m = new Map<string, string>(); return { getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) }; };
const owner = (method: string, body?: unknown) => ({ method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' } });

afterEach(() => { vi.unstubAllGlobals(); });

function setup(o: Partial<IntegrationsDeps> = {}, env: Record<string, string> = {}) {
  const integrations = new Integrations(kv(), env, credentialFile(join(mkdtempSync(join(tmpdir(), 'fg-int-routes-')), 'integrations.json')));
  const logged: ActivityInput[] = [];
  const d: IntegrationsDeps = {
    integrations, projects: async () => [{ key: 'shop', remote: 'github.com/acme/shop' }], githubOverride: new Map(), syncMinutes: 10,
    activity: { record: async (a) => void logged.push(a) },
    viewer: { github: async () => 'octo', linear: async () => 'Pat' },
    teams: async () => [],
    ...o,
  };
  return { d, integrations, logged, app: createApp(repo, { auth: { ownerToken: OWNER }, integrations: d }) };
}

test('skip-rule counts ignore entries without rules and counts that are not numbers', async () => {
  const name = FEEDBACK_SKIP_RULES[0].name;
  const entry = (details: object) => ({ id: 'a', ts: '2026-11-01T00:00:00Z', kind: 'comments_skipped', details } as unknown as Activity);
  const { d } = setup({ activity: { record: async () => {}, list: async () => [entry({}), entry({ rules: { [name]: 'many' } }), entry({ rules: { [name]: 2 } })] } });
  expect((await integrationsView(d)).rules.find((r) => r.name === name)).toMatchObject({ skipped: 2, fromInbox: 0 });
});

test('a saved check that refused the current token shows as an error naming why', async () => {
  const { integrations } = setup({}, { GITHUB_TOKEN: GH });
  await integrations.saveCheck('github', { ok: false, account: null, error: 'Bad credentials', errorKind: 'auth', at: '2026-11-01T00:00:00Z', source: 'env', fingerprint: tokenFingerprint(GH) });
  const c = await connectionsStatus({ integrations, worker: null, ollama: null, cloud: null });
  expect(c.github).toMatchObject({ state: 'error', detail: 'GitHub refused the token (set in .env): Bad credentials' });
});

test('a project shows its GITHUB_REPOS override and each service\'s last sync, items and error', async () => {
  const { d, integrations } = setup({ githubOverride: new Map([['shop', 'acme/storefront']]) });
  await integrations.saveSync('github', { ...emptySyncState(), projects: { shop: { lastSyncAt: '2026-11-01T00:00:00Z', items: 3, error: null } } } as never);
  await integrations.saveSync('linear', { ...emptySyncState(), projects: { shop: { lastSyncAt: '2026-11-02T00:00:00Z', items: 1, error: 'team gone' } } } as never);
  const [p] = (await integrationsView(d)).projects;
  expect(p.github).toMatchObject({ repo: 'acme/storefront', from: 'GITHUB_REPOS', lastSyncAt: '2026-11-01T00:00:00Z', items: 3, error: null });
  expect(p.linear).toMatchObject({ lastSyncAt: '2026-11-02T00:00:00Z', items: 1, error: 'team gone' });
});

test('without injected viewers a saved token is checked against GitHub and Linear themselves', async () => {
  const calls: string[] = [];
  let organization: { name: string } | null = { name: 'Acme' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return url.startsWith('https://api.github.com/') ? Response.json({ login: 'octo' }) : Response.json({ data: { viewer: { name: 'Pat' }, organization } });
  }));
  const { app, logged } = setup({ viewer: undefined });
  expect((await app.request('/api/settings/integrations/github', owner('PUT', { token: GH }))).status).toBe(200);
  expect((await app.request('/api/settings/integrations/linear', owner('PUT', { token: LINEAR }))).status).toBe(200);
  organization = null;
  const test = await (await app.request('/api/settings/integrations/linear/test', owner('POST'))).json();
  expect(logged.map((a) => a.subject)).toEqual(['connected GitHub as octo', 'connected Linear as Pat (Acme)']);
  expect(test.account).toBe('Pat');
  expect(calls).toContain('https://api.github.com/user');
});

test('a token check that fails with a bare value says so without the token', async () => {
  const { app } = setup({ viewer: { github: async () => { throw `refused ${GH}`; }, linear: async () => 'Pat' } });
  const res = await app.request('/api/settings/integrations/github', owner('PUT', { token: GH }));
  expect(res.status).toBe(400);
  const { error } = await res.json();
  expect(error).toMatch(/^GitHub did not accept this token, so it was not saved: refused /);
  expect(error).not.toContain(GH);
});

test('an unknown service is a 404 on every route, and a token that is too short is refused with why', async () => {
  const { app } = setup();
  expect((await app.request('/api/settings/integrations/jira', owner('PUT', { token: GH }))).status).toBe(404);
  expect((await app.request('/api/settings/integrations/jira/test', owner('POST'))).status).toBe(404);
  expect((await app.request('/api/settings/integrations/jira', owner('DELETE'))).status).toBe(404);
  const short = await app.request('/api/settings/integrations/github', owner('PUT', { token: 'abc' }));
  expect(short.status).toBe(400);
  expect(await short.json()).toEqual({ error: 'paste the whole token' });
});

test('Linear teams are listed from Linear itself without an injected lister; a bare failure is a 502 with why', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { viewer: { name: 'Pat' }, teams: { nodes: [{ id: 't2', key: 'Z', name: 'Zeta' }, { id: 't1', key: 'A', name: 'Alpha' }] } } })));
  const { app } = setup({ teams: undefined });
  await app.request('/api/settings/integrations/linear', owner('PUT', { token: LINEAR }));
  expect((await (await app.request('/api/settings/integrations/linear/teams')).json()).map((t: { name: string }) => t.name)).toEqual(['Alpha', 'Zeta']);
  const failing = setup({ teams: async () => { throw 'linear down'; } });
  await failing.app.request('/api/settings/integrations/linear', owner('PUT', { token: LINEAR }));
  const res = await failing.app.request('/api/settings/integrations/linear/teams');
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: 'could not list Linear teams: linear down' });
});

test('project links: GitHub off, a team named by id only, and clearing the team clears its name', async () => {
  const { app, logged } = setup();
  await app.request('/api/settings/integrations/projects/shop', owner('PUT', { github: false, linearTeamId: 't1' }));
  await app.request('/api/settings/integrations/projects/shop', owner('PUT', { linearTeamId: 't2', linearTeamName: 'Web' }));
  const cleared = await (await app.request('/api/settings/integrations/projects/shop', owner('PUT', { linearTeamId: null }))).json();
  await app.request('/api/settings/integrations/projects/shop', owner('PUT', { github: true }));
  expect(logged.map((a) => a.subject)).toEqual(['shop: GitHub off, Linear team t1', 'shop: Linear team Web', 'shop: no Linear team', 'shop: GitHub on']);
  expect(cleared.projects[0].linear).toMatchObject({ teamId: null, teamName: null });
});

const cloud: CloudConfig = { url: 'https://cloud.example.com', token: 't', intervalMinutes: 60, projects: [], suggestions: false, machine: null };
const worker = (cloudSync: WorkerStatus['cloudSync']) => ({ providers: {}, cloudSync } as unknown as WorkerStatus);

test('cloud connection: a newer failed Sync now without a reason, and projects backing off, are errors that say so', async () => {
  const at = (h: number) => `2026-11-01T0${h}:00:00.000Z`;
  const manual = { at: at(5), ok: false, error: null, sent: {} as never, unchanged: 0, failed: 1 };
  const failed = await connectionsStatus({ integrations: null, worker: worker({ lastAt: at(4), lastOk: true } as never), ollama: null, cloud, manualSync: manual });
  expect(failed.cloud.detail).toBe('Sync to cloud.example.com failed (Sync now): unknown error');
  const waiting = await connectionsStatus({ integrations: null, worker: worker({ lastAt: at(4), lastOk: true, waiting: [
    { key: 'a', failures: 1, until: at(6), error: 'too big' }, { key: 'b', failures: 3, until: at(7), error: null },
  ] } as never), ollama: null, cloud });
  expect(waiting.cloud.detail).toBe('Syncing to cloud.example.com, but a failed 1 time (too big), tried again 2026-11-01 06:00 UTC; b failed 3 times in a row, tried again 2026-11-01 07:00 UTC; the others sync as usual.');
  const synced = await connectionsStatus({ integrations: null, worker: worker({ lastAt: at(4), lastOk: true } as never), ollama: null, cloud });
  expect(synced.cloud).toMatchObject({ state: 'connected', detail: 'Syncing to cloud.example.com; last sync 2026-11-01 04:00 UTC.' });
  const fresh = await connectionsStatus({ integrations: null, worker: worker(undefined), ollama: null, cloud });
  expect(fresh.cloud.detail).toBe('Set up for cloud.example.com; not synced yet.');
});
