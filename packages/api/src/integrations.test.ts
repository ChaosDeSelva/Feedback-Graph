import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFile, IntegrationError, Integrations, prBacklogKey, type ActivityInput, type WorkerStatus } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { connectionsStatus, serviceConnection, type IntegrationsDeps } from './integrations.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;
// Built at runtime: push protection rejects token-shaped literals.
const TOKEN = ['github', 'pat', '11AAAA', 'x'.repeat(40)].join('_');
const ORIGIN = 'http://localhost';

function kv() {
  const m = new Map<string, string>();
  return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) };
}

function setup(o: { env?: Record<string, string>; file?: boolean; viewer?: IntegrationsDeps['viewer'] } = {}) {
  const store = kv();
  const path = join(mkdtempSync(join(tmpdir(), 'fg-api-int-')), 'integrations.json');
  const integrations = new Integrations(store, o.env ?? {}, o.file === false ? null : credentialFile(path));
  const activity: ActivityInput[] = [];
  const d: IntegrationsDeps = {
    integrations,
    projects: async () => [{ key: 'shop', remote: 'github.com/acme/shop' }, { key: 'notes', remote: 'local/notes' }],
    githubOverride: new Map(),
    syncMinutes: 10,
    activity: { record: async (a) => void activity.push(a) },
    viewer: o.viewer ?? { github: async () => 'octo', linear: async () => 'Pat (Acme)' },
    teams: async () => [{ id: 't1', key: 'WEB', name: 'Web' }],
  };
  const app = createApp(repo, { integrations: d });
  return { app, d, store, path, integrations, activity };
}

const json = (method: string, body?: unknown, origin: string | null = ORIGIN) => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(origin ? { origin, 'sec-fetch-site': 'same-origin' } : {}) },
});

describe('the skip rules in Settings > Integrations', () => {
  test('each rule is listed with how many comments it kept from the classifier, from the comments_skipped activity', async () => {
    const { d } = setup();
    const asked: unknown[] = [];
    const entries = [
      { kind: 'comments_skipped', ts: '2026-10-24T10:00:00Z', details: { rules: { 'pr-author-reply': 2, 'bot-author': 1 } } },
      { kind: 'comments_skipped', ts: '2026-10-23T10:00:00Z', details: { rules: { 'pr-author-reply': 1, 'unknown-old-rule': 4 } } },
    ];
    const app = createApp(repo, { integrations: { ...d, activity: { record: async () => {}, list: async (q) => { asked.push(q); return entries as never; } } } });
    const v = await (await app.request('/api/settings/integrations')).json();
    expect(asked).toEqual([{ kind: 'comments_skipped', limit: 1000 }]);
    expect(v.rules.map((r: { name: string; skipped: number }) => [r.name, r.skipped])).toEqual([
      ['bot-author', 1], ['pr-author-reply', 3], ['status-note', 0], ['review-trigger', 0],
      ['ai-review', 0], ['approval-summary', 0], ['status-table', 0], ['branch-timing', 0], ['review-folded', 0],
    ]);
    expect(v.rules[0].description).toMatch(/bots/i);
    expect(v.skippedSince).toBe('2026-10-23T10:00:00Z');
  });

  test('items skipped later, from what was already pending in the Inbox, are counted too and said apart', async () => {
    const { d } = setup();
    const entries = [
      { kind: 'comments_skipped', ts: '2026-10-25T10:00:00Z', details: { rules: { 'status-note': 3 }, pending: 3, rulesVersion: 2 } },
      { kind: 'comments_skipped', ts: '2026-10-24T10:00:00Z', details: { rules: { 'status-note': 1, 'bot-author': 2 } } },
    ];
    const app = createApp(repo, { integrations: { ...d, activity: { record: async () => {}, list: async () => entries as never } } });
    const v = await (await app.request('/api/settings/integrations')).json();
    const note = v.rules.find((r: { name: string }) => r.name === 'status-note');
    expect(note).toMatchObject({ skipped: 4, fromInbox: 3 });
    expect(v.rules.find((r: { name: string }) => r.name === 'bot-author')).toMatchObject({ skipped: 2, fromInbox: 0 });
  });

  test('without an activity log to count from, the rules are listed with no counts', async () => {
    const { app } = setup();
    const v = await (await app.request('/api/settings/integrations')).json();
    expect(v.rules.map((r: { skipped: number | null }) => r.skipped)).toEqual(Array(9).fill(null));
    expect(v.skippedSince).toBeNull();
  });
});

describe('Settings > Integrations', () => {
  test('nothing connected: each service says how to connect; projects show the repository their remote names', async () => {
    const { app } = setup();
    const v = await (await app.request('/api/settings/integrations')).json();
    expect(v.canSave).toBe(true);
    expect(v.github.connection).toMatchObject({ state: 'not_connected', source: null });
    expect(v.github.connection.detail).toMatch(/paste a token in Settings or set GITHUB_TOKEN/);
    expect(v.projects).toEqual([
      expect.objectContaining({ key: 'shop', github: expect.objectContaining({ repo: 'acme/shop', from: 'remote', enabled: true }) }),
      expect.objectContaining({ key: 'notes', github: expect.objectContaining({ repo: null, from: null }) }),
    ]);
  });

  test('a PR sync that hit its cap shows what it has not read yet on the project, until the worker catches up', async () => {
    const { app, store } = setup();
    await store.setCursor(prBacklogKey('shop'), JSON.stringify({ since: '2026-10-01T00:00:00Z', until: '2026-10-21T00:00:00Z' }));
    const v = await (await app.request('/api/settings/integrations')).json();
    expect(v.projects[0].github.backlog).toEqual({ since: '2026-10-01T00:00:00Z', until: '2026-10-21T00:00:00Z' });
    expect(v.projects[1].github.backlog).toBeNull();
    await store.setCursor(prBacklogKey('shop'), '');
    expect((await (await app.request('/api/settings/integrations')).json()).projects[0].github.backlog).toBeNull();
  });

  test('saving a token checks it with one call, keeps it in the mode-600 file and never returns it', async () => {
    const { app, path, activity, store } = setup();
    const res = await app.request('/api/settings/integrations/github', json('PUT', { token: TOKEN }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const v = JSON.parse(text);
    expect(v.github).toMatchObject({ account: 'octo', savedInApp: true, envSet: false, connection: { state: 'connected', source: 'app' } });
    expect(JSON.parse(readFileSync(path, 'utf8')).github.token).toBe(TOKEN);
    expect([...store.m.values()].join()).not.toContain(TOKEN);
    expect(activity[0]).toMatchObject({ kind: 'integration_changed', actor: 'you', subject: 'connected GitHub as octo' });
    expect(await (await app.request('/api/status')).text()).not.toContain(TOKEN);
  });

  test('a token the service refuses is not saved, and the reason is shown without the token', async () => {
    const { app, path } = setup({ viewer: { github: async (t) => { throw new IntegrationError(`github 401: bad credentials for ${t}`, 'auth'); }, linear: async () => 'x' } });
    const res = await app.request('/api/settings/integrations/github', json('PUT', { token: TOKEN }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/did not accept this token, so it was not saved: github 401/);
    expect(body.error).not.toContain(TOKEN);
    expect(() => readFileSync(path)).toThrow();
  });

  test('a token saved in Settings wins over .env; disconnecting it falls back to .env, which Settings cannot remove', async () => {
    const { app } = setup({ env: { GITHUB_TOKEN: TOKEN } });
    const v = await (await app.request('/api/settings/integrations')).json();
    expect(v.github).toMatchObject({ envSet: true, envVar: 'GITHUB_TOKEN', savedInApp: false, connection: { source: 'env' } });
    expect((await app.request('/api/settings/integrations/github', json('DELETE', {}))).status).toBe(409);
    const saved = await app.request('/api/settings/integrations/github', json('PUT', { token: 'another-token-123' }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).github).toMatchObject({ envSet: true, savedInApp: true, connection: { source: 'app' } });
    const back = await (await app.request('/api/settings/integrations/github', json('DELETE', {}))).json();
    expect(back.github).toMatchObject({ envSet: true, savedInApp: false, connection: { source: 'env' } });
  });

  test('Test connection re-checks the current token; disconnect removes it', async () => {
    const { app } = setup();
    await app.request('/api/settings/integrations/linear', json('PUT', { token: 'lin_api_' + 'k'.repeat(20) }));
    const t = await (await app.request('/api/settings/integrations/linear/test', json('POST', {}))).json();
    expect(t).toMatchObject({ ok: true, account: 'Pat (Acme)' });
    const after = await (await app.request('/api/settings/integrations/linear', json('DELETE', {}))).json();
    expect(after.linear).toMatchObject({ savedInApp: false, connection: { state: 'not_connected' } });
    expect((await app.request('/api/settings/integrations/linear/test', json('POST', {}))).status).toBe(409);
  });

  test('without INTEGRATIONS_FILE, tokens can only come from .env', async () => {
    const { app } = setup({ file: false });
    expect((await (await app.request('/api/settings/integrations')).json()).canSave).toBe(false);
    expect((await app.request('/api/settings/integrations/github', json('PUT', { token: TOKEN }))).status).toBe(501);
  });

  test('writes are yours only: no Origin, no change', async () => {
    const { app } = setup();
    expect((await app.request('/api/settings/integrations/github', json('PUT', { token: TOKEN }, null))).status).toBe(403);
    expect((await app.request('/api/settings/integrations/projects/shop', json('PUT', { github: false }, null))).status).toBe(403);
  });

  test('per project: GitHub off and a Linear team; teams are listed with the saved key; unknown projects refused', async () => {
    const { app } = setup();
    expect((await app.request('/api/settings/integrations/linear/teams')).status).toBe(409);
    await app.request('/api/settings/integrations/linear', json('PUT', { token: 'lin_api_' + 'k'.repeat(20) }));
    expect(await (await app.request('/api/settings/integrations/linear/teams')).json()).toEqual([{ id: 't1', key: 'WEB', name: 'Web' }]);
    const v = await (await app.request('/api/settings/integrations/projects/shop', json('PUT', { github: false, linearTeamId: 't1', linearTeamName: 'Web' }))).json();
    expect(v.projects[0]).toMatchObject({ key: 'shop', github: { enabled: false }, linear: { teamId: 't1', teamName: 'Web' } });
    expect((await app.request('/api/settings/integrations/projects/other', json('PUT', { github: false }))).status).toBe(404);
  });
});

describe('a token nobody has checked yet', () => {
  const counting = () => {
    const calls = { github: 0, linear: 0 };
    return { calls, viewer: { github: async () => { calls.github++; return 'octo'; }, linear: async () => { calls.linear++; return 'Pat (Acme)'; } } };
  };

  test('a token from .env is checked on first use and the account is shown, in Settings and in /api/status; once', async () => {
    const { calls, viewer } = counting();
    const { d } = setup({ env: { GITHUB_TOKEN: TOKEN, LINEAR_API_KEY: 'k'.repeat(30) }, viewer });
    const app = createApp(repo, { integrations: d, system: { version: 't', ping: async () => true, worker: async () => null } });
    // The status bar asks first (it polls); Settings then shows the same check without asking again.
    const s = await (await app.request('/api/status')).json();
    expect(s.connections.github.detail).toMatch(/^Connected as octo \(set in \.env\)/);
    expect(s.connections.linear.detail).toMatch(/^Connected as Pat \(Acme\)/);
    const v = await (await app.request('/api/settings/integrations')).json();
    expect(v.github).toMatchObject({ account: 'octo', connection: { state: 'connected' } });
    expect(calls).toEqual({ github: 1, linear: 1 });
  });

  test('a check that failed before a later successful sync is made again', async () => {
    const { calls, viewer } = counting();
    const { app, integrations } = setup({ env: { GITHUB_TOKEN: TOKEN }, viewer });
    const cred = (await integrations.credential('github'))!;
    await integrations.saveCheck('github', { ok: false, account: null, error: 'github 502', errorKind: 'other', at: '2026-10-22T09:00:00Z', source: 'env', fingerprint: cred.fingerprint });
    await integrations.saveSync('github', { ...(await integrations.sync('github')), lastSyncAt: '2026-10-22T10:00:00Z' });
    const v = await (await app.request('/api/settings/integrations')).json();
    expect(v.github).toMatchObject({ account: 'octo', connection: { state: 'connected' } });
    expect(calls.github).toBe(1);
  });

  test('when the service cannot be reached the token is not called refused, and it is not asked again at once', async () => {
    let n = 0;
    const viewer = { github: async () => { n++; throw new IntegrationError('fetch failed', 'network'); }, linear: async () => 'x' };
    const { app } = setup({ env: { GITHUB_TOKEN: TOKEN }, viewer });
    const v = await (await app.request('/api/settings/integrations')).json();
    expect(v.github.connection).toMatchObject({ state: 'connected', detail: expect.stringMatching(/token not checked yet/) });
    await app.request('/api/settings/integrations');
    expect(n).toBe(1);
  });
});

describe('connection states', () => {
  const sync = { lastSyncAt: '2026-10-22T10:00:00Z', lastError: null, errorKind: null, rateLimitedUntil: null, authFailedFor: null, projects: {} };
  test('a token the worker found rejected is an error until replaced; a rate limit says when it resumes', () => {
    expect(serviceConnection('github', { source: 'app', fingerprint: 'f1', check: null, sync: { ...sync, authFailedFor: 'f1' }, canSave: true })).toMatchObject({ state: 'error', detail: expect.stringMatching(/rejected the token.*paused until you replace it/) });
    expect(serviceConnection('github', { source: 'app', fingerprint: 'f2', check: null, sync: { ...sync, authFailedFor: 'f1' }, canSave: true }).state).toBe('connected');
    expect(serviceConnection('linear', { source: 'env', fingerprint: 'f', check: null, sync: { ...sync, rateLimitedUntil: '2099-01-01T00:00:00Z' }, canSave: true })).toMatchObject({ state: 'error', source: 'env', detail: expect.stringMatching(/resumes on its own/) });
  });

  test('/api/status lists every connection, with Claude and Codex from the worker heartbeat', async () => {
    const worker = { providers: { classify: 'ollama:gemma4', postmortem: 'claude-cli', scan: 'codex-cli:gpt-5', summary: null }, health: { scan: { provider: 'codex-cli', ok: false, reason: 'not signed in', at: 't' } } } as unknown as WorkerStatus;
    const c = await connectionsStatus({ integrations: new Integrations(kv(), { GITHUB_TOKEN: 'x'.repeat(20) }), worker, ollama: { url: 'http://ollama:11434', ok: true, reason: null }, cloud: null });
    expect(Object.keys(c).sort()).toEqual(['claude', 'cloud', 'codex', 'github', 'linear', 'ollama']);
    expect(c.github).toMatchObject({ state: 'connected', source: 'env', href: '#settings/integrations-github' });
    expect(c.linear.state).toBe('not_connected');
    expect(c.claude).toMatchObject({ state: 'connected', detail: expect.stringContaining('postmortem') });
    expect(c.codex).toMatchObject({ state: 'error', detail: expect.stringContaining('not signed in') });
    expect(c.ollama.state).toBe('connected');
    expect(c.cloud).toMatchObject({ state: 'not_connected', detail: expect.stringMatching(/nothing is sent/) });
    expect(JSON.stringify(c)).not.toContain('x'.repeat(20));
  });

  test('a project the sync schedule is backing off from is named, though the last run was fine for the rest', async () => {
    const cloud = { url: 'https://cloud.example.com', token: 't', intervalMinutes: 60, projects: [], suggestions: false, machine: null };
    const cloudSync = {
      host: 'cloud.example.com', intervalMinutes: 60, lastAt: '2026-10-25T11:00:00.000Z', lastOk: true, lastError: null, lastSent: null, nextAt: null, failures: 0,
      waiting: [{ key: 'demo-shop', failures: 2, until: '2026-10-25T15:00:00.000Z', error: 'the cloud rejected the bundle (422)' }],
    };
    const c = await connectionsStatus({ integrations: null, worker: { providers: {}, health: {}, cloudSync } as unknown as WorkerStatus, ollama: null, cloud });
    expect(c.cloud).toMatchObject({ state: 'error', detail: expect.stringMatching(/demo-shop failed 2 times in a row.*422.*tried again 2026-10-25 15:00 UTC.*others sync as usual/) });
  });
});


test('per-project PR author is saved, exposed, validated and resets sync cursors', async () => {
  const { app, store, integrations } = setup();
  store.m.set('github:shop', 'old');
  store.m.set('feedback-github:shop', 'old');
  const res = await app.request('/api/settings/integrations/projects/shop', json('PUT', { githubAuthor: 'octo' }));
  expect(res.status).toBe(200);
  expect((await res.json()).projects.find((p: { key: string }) => p.key === 'shop').github.author).toBe('octo');
  expect((await integrations.link('shop')).githubAuthor).toBe('octo');
  expect(store.m.get('github:shop')).toBe('');
  expect(store.m.get('feedback-github:shop')).toBe('');
  expect((await app.request('/api/settings/integrations/projects/shop', json('PUT', { githubAuthor: 'bad/login' }))).status).toBe(400);
  expect((await app.request('/api/settings/integrations/projects/shop', json('PUT', { githubAuthor: null }))).status).toBe(200);
  expect((await integrations.link('shop')).githubAuthor).toBeNull();
});
