import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { OwnerSessions } from './auth.ts';

const repo: ApiRepo = {
  listCandidates: async () => [],
  candidateDetail: async (id) => (id === 'c1'
    ? { candidate: { id, projectKey: 'demo', classification: { label: 'pushback', confidence: 1 } }, turn: { text: 'x' }, before: [], after: [], commits: [] } as never
    : null),
  decide: async () => {},
  stats: async () => [],
};

const TOKEN = 'a-long-random-token-0123456789';
const OWNER = 'an-owner-only-token-0123456789012345';
const secured = () => createApp(repo, { auth: { token: TOKEN, ownerToken: OWNER, publicHosts: ['fg.corp.example'] } });
const bearer = { authorization: `Bearer ${TOKEN}` };

test('with a token configured, the API refuses requests without it', async () => {
  const app = secured();
  expect((await app.request('/api/candidates')).status).toBe(401);
  expect((await app.request('/api/candidates', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  expect((await app.request('/api/candidates', { headers: bearer })).status).toBe(200);
});

test('health stays open so container checks work without the token', async () => {
  expect((await secured().request('/api/health')).status).toBe(200);
});

test('readiness stays open too: the compose health check calls it without the token', async () => {
  const res = await secured().request('/api/ready');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('MCP needs the token too', async () => {
  const res = await secured().request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(res.status).toBe(401);
});

test('signing in from the UI sets an HttpOnly session cookie that authenticates later requests', async () => {
  const app = secured();
  const bad = await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }, body: JSON.stringify({ token: 'nope' }) });
  expect(bad.status).toBe(401);
  const res = await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }, body: JSON.stringify({ token: OWNER }) });
  expect(res.status).toBe(204);
  const cookie = res.headers.get('set-cookie')!;
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  expect(cookie).not.toContain(TOKEN);
  const session = cookie.split(';')[0];
  expect((await app.request('/api/candidates', { headers: { cookie: session } })).status).toBe(200);
  // The cookie is signed by the owner credential, so a routine API restart or
  // Compose upgrade does not log the browser out.
  expect((await secured().request('/api/candidates', { headers: { cookie: session } })).status).toBe(200);
  const second = await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) });
  expect(second.headers.get('set-cookie')!.split(';')[0]).not.toBe(session);
  expect((await app.request('/api/session', { method: 'DELETE', headers: { cookie: session, 'content-type': 'application/json' } })).status).toBe(204);
  expect((await app.request('/api/candidates', { headers: { cookie: session } })).status).toBe(401);
});

test('sign-out revocation survives an API restart and anonymous sign-out stores nothing', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'fg-session-')), 'revoked.json');
  const opts = { auth: { token: TOKEN, ownerToken: OWNER, sessionStateFile: stateFile } };
  const app = createApp(repo, opts);
  const login = await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) });
  const session = login.headers.get('set-cookie')!.split(';')[0];
  await app.request('/api/session', { method: 'DELETE', headers: { cookie: session, 'content-type': 'application/json' } });
  expect(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')))).toHaveLength(1);
  expect((await createApp(repo, opts).request('/api/candidates', { headers: { cookie: session } })).status).toBe(401);
  await createApp(repo, opts).request('/api/session', { method: 'DELETE', headers: { 'content-type': 'application/json' } });
  expect(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')))).toHaveLength(1);
});

test('owner cookies are isolated per install and non-finite expiry claims are refused', async () => {
  const one = createApp(repo, { auth: { token: TOKEN, ownerToken: OWNER } });
  const login = await one.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  expect(cookie).toMatch(/^fg_session_[0-9a-f]{12}=/);
  const other = createApp(repo, { auth: { token: TOKEN, ownerToken: `${OWNER}-other` } });
  expect((await other.request('/api/candidates', { headers: { cookie } })).status).toBe(401);
  const sessions = new OwnerSessions(OWNER);
  expect(sessions.has(`Infinity.value.${'x'.repeat(43)}`)).toBe(false);
});

test('the UI can ask whether it needs to sign in', async () => {
  expect(await (await secured().request('/api/session')).json()).toEqual({ authRequired: true, authenticated: false, ownerSession: false, ownerSetupRequired: false });
  expect(await (await secured().request('/api/session', { headers: bearer })).json()).toEqual({ authRequired: true, authenticated: false, ownerSession: false, ownerSetupRequired: false });
  expect(await (await createApp(repo).request('/api/session')).json()).toEqual({ authRequired: false, authenticated: false, ownerSession: false, ownerSetupRequired: false });
  expect((await createApp(repo).request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'anything' }) })).status).toBe(403);
});

test('an upgraded install without FG_OWNER_TOKEN is usable only from its real loopback same-origin UI', async () => {
  const local = createApp(repo, { peerAddress: () => '127.0.0.1' });
  const body = JSON.stringify({ status: 'rejected' });
  const sameOrigin = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' };
  expect((await local.request('http://localhost/api/candidates/c1/decision', { method: 'POST', headers: sameOrigin, body })).status).toBe(204);
  expect((await local.request('http://localhost/api/candidates/c1/decision', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body })).status).toBe(403);
  expect((await local.request('http://localhost/api/candidates/c1/decision', { method: 'POST', headers: { ...sameOrigin, authorization: 'Bearer forged' }, body })).status).toBe(403);

  const protectedUpgrade = createApp(repo, { auth: { token: TOKEN } });
  expect(await (await protectedUpgrade.request('/api/session')).json()).toEqual({ authRequired: true, authenticated: false, ownerSession: false, ownerSetupRequired: true });
});

test('a public host name is accepted only when a token protects the API', async () => {
  const headers = { host: 'fg.corp.example', ...bearer };
  expect((await secured().request('http://fg.corp.example/api/candidates', { headers })).status).toBe(200);
  expect((await createApp(repo, { auth: { publicHosts: ['fg.corp.example'] } }).request('http://fg.corp.example/api/candidates', { headers })).status).toBe(403);
});

test('behind a TLS proxy, the signed-in browser session may write but its API bearer cannot impersonate it', async () => {
  const app = secured();
  const login = await app.request('http://fg.corp.example/api/session', {
    method: 'POST',
    headers: { host: 'fg.corp.example', 'sec-fetch-site': 'same-origin', origin: 'https://fg.corp.example', 'content-type': 'application/json' },
    body: JSON.stringify({ token: OWNER }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const headers = { host: 'fg.corp.example', 'sec-fetch-site': 'same-origin', origin: 'https://fg.corp.example', 'content-type': 'application/json' };
  const forged = await app.request('http://fg.corp.example/api/candidates/c1/decision', {
    method: 'POST',
    headers: { ...headers, ...bearer, 'x-fg-owner': 'true' },
    body: JSON.stringify({ status: 'rejected' }),
  });
  expect(forged.status).toBe(403);
  const res = await app.request('http://fg.corp.example/api/candidates/c1/decision', {
    method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'rejected' }),
  });
  expect(res.status).toBe(204);
});

test('responses carry security headers', async () => {
  const res = await createApp(repo).request('/api/health');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
});


test('Origin alone is insufficient owner proof; browser fetch metadata is required', async () => {
  const app = createApp(repo);
  const res = await app.request('/api/candidates/c1/decision', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'rejected' }) });
  expect(res.status).toBe(403);
});


test('headless owner decisions need the separate owner token and explicit owner intent', async () => {
  const apiToken = 'api-test-token-123456789012345678901';
  const ownerToken = 'owner-test-token-12345678901234567890';
  const app = createApp(repo, { auth: { token: apiToken, ownerToken } });
  const request = (headers: Record<string, string>) => app.request('/api/candidates/c1/decision', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ status: 'rejected' }) });
  expect((await request({ authorization: `Bearer ${apiToken}`, 'x-fg-owner': 'true' })).status).toBe(403);
  expect((await request({ authorization: `Bearer ${ownerToken}` })).status).toBe(403);
  expect((await request({ authorization: `Bearer ${ownerToken}`, 'x-fg-owner': 'true' })).status).toBe(204);
});
