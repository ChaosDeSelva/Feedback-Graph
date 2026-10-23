import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo: ApiRepo = {
  listCandidates: async () => [],
  candidateDetail: async (id) => (id === 'c1'
    ? { candidate: { id, projectKey: 'demo', classification: { label: 'pushback', confidence: 1 } }, turn: { text: 'x' }, before: [], after: [], commits: [] } as never
    : null),
  decide: async () => {},
  stats: async () => [],
};

const TOKEN = 'a-long-random-token-0123456789';
const secured = () => createApp(repo, { auth: { token: TOKEN, publicHosts: ['fg.corp.example'] } });
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
  const bad = await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ token: 'nope' }) });
  expect(bad.status).toBe(401);
  const res = await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ token: TOKEN }) });
  expect(res.status).toBe(204);
  const cookie = res.headers.get('set-cookie')!;
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  expect(cookie).not.toContain(TOKEN);
  const session = cookie.split(';')[0];
  expect((await app.request('/api/candidates', { headers: { cookie: session } })).status).toBe(200);
});

test('the UI can ask whether it needs to sign in', async () => {
  expect(await (await secured().request('/api/session')).json()).toEqual({ authRequired: true, authenticated: false });
  expect(await (await secured().request('/api/session', { headers: bearer })).json()).toEqual({ authRequired: true, authenticated: true });
  expect(await (await createApp(repo).request('/api/session')).json()).toEqual({ authRequired: false, authenticated: true });
});

test('a public host name is accepted only when a token protects the API', async () => {
  const headers = { host: 'fg.corp.example', ...bearer };
  expect((await secured().request('http://fg.corp.example/api/candidates', { headers })).status).toBe(200);
  expect((await createApp(repo, { auth: { publicHosts: ['fg.corp.example'] } }).request('http://fg.corp.example/api/candidates', { headers })).status).toBe(403);
});

test('behind a TLS proxy, the https origin of the same host may write', async () => {
  const res = await secured().request('http://fg.corp.example/api/candidates/c1/decision', {
    method: 'POST',
    headers: { host: 'fg.corp.example', origin: 'https://fg.corp.example', 'content-type': 'application/json', ...bearer },
    body: JSON.stringify({ status: 'rejected' }),
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
