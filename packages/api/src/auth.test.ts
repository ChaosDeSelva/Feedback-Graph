import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { bearerToken, OwnerSessions } from './auth.ts';

const repo: ApiRepo = { undoDecision: async () => false,
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
  expect(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).revoked)).toHaveLength(1);
  expect((await createApp(repo, opts).request('/api/candidates', { headers: { cookie: session } })).status).toBe(401);
  await createApp(repo, opts).request('/api/session', { method: 'DELETE', headers: { 'content-type': 'application/json' } });
  expect(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).revoked)).toHaveLength(1);
});

test('owner cookies are named per install port without deriving from a credential, and non-finite expiry claims are refused', async () => {
  const signIn = { method: 'POST', headers: { host: 'localhost:8797', 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) };
  const one = createApp(repo, { auth: { token: TOKEN, ownerToken: OWNER } });
  const cookie = (await one.request('http://localhost:8797/api/session', signIn)).headers.get('set-cookie')!.split(';')[0];
  expect(cookie).toMatch(/^fg_session_8797=/);
  expect((await one.request('http://localhost:8797/api/candidates', { headers: { host: 'localhost:8797', cookie } })).status).toBe(200);
  // Another install's port has its own name, so the browser never sends this cookie as that install's session.
  expect((await one.request('http://localhost:8787/api/candidates', { headers: { host: 'localhost:8787', cookie } })).status).toBe(401);
  const other = createApp(repo, { auth: { token: TOKEN, ownerToken: `${OWNER}-other` } });
  expect((await other.request('http://localhost:8797/api/candidates', { headers: { host: 'localhost:8797', cookie } })).status).toBe(401);
  const sessions = new OwnerSessions(OWNER);
  expect(sessions.has(`Infinity.value.${'x'.repeat(43)}`)).toBe(false);
});

test('a revocation that cannot be saved fails the sign-out and leaves the session valid everywhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-session-'));
  const opts = { auth: { token: TOKEN, ownerToken: OWNER, sessionStateFile: join(dir, 'revoked.json') } };
  const app = createApp(repo, opts);
  chmodSync(dir, 0o500);
  const session = (await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) })).headers.get('set-cookie')!.split(';')[0];
  const out = await app.request('/api/session', { method: 'DELETE', headers: { cookie: session, 'content-type': 'application/json' } });
  expect(out.status).toBe(500);
  expect((await out.json()).error).toMatch(/could not be saved.*not revoked/);
  expect(out.headers.get('set-cookie')).toBeNull();
  // "Still signed in" is true in this process and after a restart: nothing was revoked in memory only.
  expect((await app.request('/api/candidates', { headers: { cookie: session } })).status).toBe(200);
  expect((await createApp(repo, opts).request('/api/candidates', { headers: { cookie: session } })).status).toBe(200);
  chmodSync(dir, 0o700);
  // The half-written file is not left behind.
  expect(readdirSync(dir)).toEqual(['revoked.json']);
});

test('a revocation file deleted after a sign-out does not bring the signed-out session back', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'fg-session-')), 'revoked.json');
  const opts = { auth: { token: TOKEN, ownerToken: OWNER, sessionStateFile: stateFile } };
  const login = async (app: ReturnType<typeof createApp>) => (await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) })).headers.get('set-cookie')!.split(';')[0];
  // A brand-new install writes its file at the first start and signing in works.
  const first = createApp(repo, opts);
  expect(existsSync(stateFile)).toBe(true);
  const revoked = await login(first);
  expect((await first.request('/api/candidates', { headers: { cookie: revoked } })).status).toBe(200);
  await first.request('/api/session', { method: 'DELETE', headers: { cookie: revoked, 'content-type': 'application/json' } });
  rmSync(stateFile);
  const restarted = createApp(repo, opts);
  expect((await restarted.request('/api/candidates', { headers: { cookie: revoked } })).status).toBe(401);
  // The new cut-off is saved at once, so a session made after it survives the next restart.
  const fresh = await login(restarted);
  expect((await createApp(repo, opts).request('/api/candidates', { headers: { cookie: fresh } })).status).toBe(200);
  expect((await createApp(repo, opts).request('/api/candidates', { headers: { cookie: revoked } })).status).toBe(401);
});

test('a corrupt revocation file is rewritten at once, so the next restart does not sign the owner out again', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'fg-session-')), 'revoked.json');
  const opts = { auth: { token: TOKEN, ownerToken: OWNER, sessionStateFile: stateFile } };
  writeFileSync(stateFile, '{"truncated');
  const logs: string[] = [];
  const restarted = createApp(repo, { ...opts, log: (msg) => logs.push(msg) });
  expect(logs).toContain('owner sessions reset');
  const session = (await restarted.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) })).headers.get('set-cookie')!.split(';')[0];
  const again: string[] = [];
  const next = createApp(repo, { ...opts, log: (msg) => again.push(msg) });
  expect(again).not.toContain('owner sessions reset');
  expect((await next.request('/api/candidates', { headers: { cookie: session } })).status).toBe(200);
});

test('a revocation file that cannot be written at start keeps refusing earlier sessions and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-session-'));
  const stateFile = join(dir, 'revoked.json');
  const t0 = Date.now();
  const before = new OwnerSessions('k'.repeat(32), undefined, t0 - 1000).create(t0 - 1000);
  chmodSync(dir, 0o500);
  const restarted = new OwnerSessions('k'.repeat(32), stateFile, t0);
  chmodSync(dir, 0o700);
  expect(restarted.stateProblem).toMatch(/missing and could not be written/);
  expect(restarted.has(before, t0)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});

test('a second cookie with this install\'s name, planted by another port of the host, neither signs the owner out nor in', async () => {
  const app = createApp(repo, { auth: { token: TOKEN, ownerToken: OWNER } });
  const signIn = { method: 'POST', headers: { host: 'localhost:8797', 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) };
  const session = (await app.request('http://localhost:8797/api/session', signIn)).headers.get('set-cookie')!.split(';')[0];
  const planted = 'fg_session_8797=1.planted.value';
  for (const cookie of [`${planted}; ${session}`, `${session}; ${planted}`]) {
    expect((await app.request('http://localhost:8797/api/candidates', { headers: { host: 'localhost:8797', cookie } })).status).toBe(200);
  }
  expect((await app.request('http://localhost:8797/api/candidates', { headers: { host: 'localhost:8797', cookie: planted } })).status).toBe(401);
  // Signing out with both revokes the valid one.
  await app.request('http://localhost:8797/api/session', { method: 'DELETE', headers: { host: 'localhost:8797', cookie: `${planted}; ${session}`, 'content-type': 'application/json' } });
  expect((await app.request('http://localhost:8797/api/candidates', { headers: { host: 'localhost:8797', cookie: session } })).status).toBe(401);
});

test('a session issued in the same millisecond the revocation cut-off is set is refused; one issued after it is not', () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'fg-session-')), 'revoked.json');
  const t0 = Date.now();
  const before = new OwnerSessions('k'.repeat(32), undefined, t0).create(t0);
  writeFileSync(stateFile, '{"truncated');
  const restarted = new OwnerSessions('k'.repeat(32), stateFile, t0);
  expect(restarted.has(before, t0)).toBe(false);
  const after = restarted.create(t0);
  expect(restarted.has(after, t0)).toBe(true);
});

test('a corrupt or truncated revocation file refuses every earlier owner session instead of forgetting revocations', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'fg-session-')), 'revoked.json');
  const opts = { auth: { token: TOKEN, ownerToken: OWNER, sessionStateFile: stateFile } };
  const login = async (app: ReturnType<typeof createApp>) => (await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER }) })).headers.get('set-cookie')!.split(';')[0];
  const first = createApp(repo, opts);
  const revoked = await login(first);
  const kept = await login(first);
  await first.request('/api/session', { method: 'DELETE', headers: { cookie: revoked, 'content-type': 'application/json' } });
  writeFileSync(stateFile, readFileSync(stateFile, 'utf8').slice(0, 30));
  const logs: string[] = [];
  const restarted = createApp(repo, { ...opts, log: (msg) => logs.push(msg) });
  expect(logs).toContain('owner sessions reset');
  expect((await restarted.request('/api/candidates', { headers: { cookie: revoked } })).status).toBe(401);
  expect((await restarted.request('/api/candidates', { headers: { cookie: kept } })).status).toBe(401);
  // Signing in again works, and the cut-off is saved with the next revocation so a later restart keeps it.
  const fresh = await login(restarted);
  expect((await restarted.request('/api/candidates', { headers: { cookie: fresh } })).status).toBe(200);
  await restarted.request('/api/session', { method: 'DELETE', headers: { cookie: fresh, 'content-type': 'application/json' } });
  const again = createApp(repo, opts);
  expect((await again.request('/api/candidates', { headers: { cookie: revoked } })).status).toBe(401);
  expect((await again.request('/api/candidates', { headers: { cookie: fresh } })).status).toBe(401);
  // A 0.7.5 file (a flat digest map) is still read.
  const old = createApp(repo, { auth: { token: TOKEN, ownerToken: OWNER } });
  const oldSession = await login(old);
  writeFileSync(stateFile, '{}\n');
  expect((await createApp(repo, opts).request('/api/candidates', { headers: { cookie: oldSession } })).status).toBe(200);
});

test('the UI can ask whether it needs to sign in', async () => {
  expect(await (await secured().request('/api/session')).json()).toEqual({ authRequired: true, authenticated: false, ownerSession: false, ownerSetupRequired: false, ownerWrites: false });
  expect(await (await secured().request('/api/session', { headers: bearer })).json()).toEqual({ authRequired: true, authenticated: false, ownerSession: false, ownerSetupRequired: false, ownerWrites: false });
  expect(await (await createApp(repo, { peerAddress: () => '127.0.0.1' }).request('/api/session')).json()).toEqual({ authRequired: false, authenticated: false, ownerSession: false, ownerSetupRequired: false, ownerWrites: true });
  expect((await createApp(repo).request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'anything' }) })).status).toBe(403);
});

test('an upgraded install without FG_OWNER_TOKEN is usable only from its real loopback same-origin UI', async () => {
  const local = createApp(repo, { peerAddress: () => '127.0.0.1' });
  const body = JSON.stringify({ status: 'rejected' });
  const sameOrigin = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' };
  expect((await local.request('http://localhost/api/candidates/c1/decision', { method: 'POST', headers: sameOrigin, body })).status).toBe(204);
  const cli = await local.request('http://localhost/api/candidates/c1/decision', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body });
  expect(cli.status).toBe(403);
  // A CLI on loopback (fg inside the container) is told the install is read-only, not to use a UI that is read-only too.
  expect((await cli.json()).error).toMatch(/read-only.*setup\.sh --yes --enable-auth/);
  expect((await local.request('http://localhost/api/candidates/c1/decision', { method: 'POST', headers: { ...sameOrigin, authorization: 'Bearer forged' }, body })).status).toBe(403);

  const protectedUpgrade = createApp(repo, { auth: { token: TOKEN } });
  expect(await (await protectedUpgrade.request('/api/session')).json()).toEqual({ authRequired: true, authenticated: false, ownerSession: false, ownerSetupRequired: true, ownerWrites: false });
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

test('the Bearer scheme is matched in any case (RFC 7235): API_TOKEN, FG_OWNER_TOKEN, FG_OPERATOR_TOKEN and /mcp', async () => {
  expect(['Bearer t', 'bearer t', 'BEARER t', 'bEaReR \t t '].map(bearerToken)).toEqual(['t', 't', 't', 't']);
  expect(['Basic t', 'Bearer', 'Bearer   ', 'Bearert', undefined].map(bearerToken)).toEqual([null, null, null, null, null]);
  const operator = 'operator-test-token-1234567890123456';
  const app = createApp(repo, { auth: { token: TOKEN, ownerToken: OWNER, operator: { token: operator, allow: ['inbox_decide'] } } });
  const decide = (headers: Record<string, string>) => app.request('/api/candidates/c1/decision', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ status: 'rejected' }) });
  for (const scheme of ['bearer', 'BEARER']) {
    expect((await app.request('/api/candidates', { headers: { authorization: `${scheme} ${TOKEN}` } })).status).toBe(200);
    expect((await app.request('/mcp', { method: 'POST', headers: { authorization: `${scheme} ${TOKEN}`, 'content-type': 'application/json' }, body: '{}' })).status).not.toBe(401);
    expect((await decide({ authorization: `${scheme} ${OWNER}`, 'x-fg-owner': 'true' })).status).toBe(204);
    expect((await decide({ authorization: `${scheme} ${operator}`, 'x-fg-operator': 'codex' })).status).toBe(204);
    expect((await app.request('/api/candidates', { headers: { authorization: `${scheme} wrong` } })).status).toBe(401);
  }
});

// Behind Docker's published port a browser on this machine reaches the API from the bridge gateway (192.168.166.1 on
// OrbStack), on the container's own network; a LAN client whose address Docker preserves is not on it.
const containerNets = { eth0: [{ address: '192.168.166.3', netmask: '255.255.255.0', family: 'IPv4', mac: '02:42:c0:a8:a6:03', internal: false, cidr: '192.168.166.3/24' }] } as const;

test('a tokenless install is read-only for owner actions from the Docker gateway and says how to enable them', async () => {
  const { localPeers } = await import('./peer.ts');
  const app = createApp(repo, { peerAddress: () => '192.168.166.1', localPeer: localPeers(containerNets as never) });
  const sameOrigin = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost:8787', host: 'localhost:8787' };
  expect((await app.request('http://localhost:8787/api/candidates', { headers: { host: 'localhost:8787' } })).status).toBe(200);
  expect((await (await app.request('http://localhost:8787/api/session', { headers: { host: 'localhost:8787' } })).json()).ownerWrites).toBe(false);
  const res = await app.request('http://localhost:8787/api/candidates/c1/decision', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ status: 'rejected' }) });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.readOnly).toBe(true);
  expect(body.error).toMatch(/read-only.*setup\.sh --yes --enable-auth/);
  // The same text reaches ./scripts/fg, so it does not speak only to a browser.
  expect(body.error).toMatch(/your browser or \.\/scripts\/fg/);
});

test("a tokenless install's 403 names commands that work: fg --owner only for cleanup, and LOOP_DISABLED=1 to stop the loop", async () => {
  const { localPeers } = await import('./peer.ts');
  const app = createApp(repo, { peerAddress: () => '192.168.166.1', localPeer: localPeers(containerNets as never) });
  const refused = async (method: string, path: string) => {
    const res = await app.request(`http://localhost:8787${path}`, { method, headers: { 'content-type': 'application/json', host: 'localhost:8787' }, body: '{}' });
    expect(res.status).toBe(403);
    return ((await res.json()) as { error: string }).error;
  };
  for (const [method, path] of [['POST', '/api/loop/pause'], ['POST', '/api/demo/seed']]) {
    const error = await refused(method, path);
    expect(error).not.toMatch(/--owner/);
    expect(error).toContain('./scripts/fg signin');
  }
  // A verb off by default is given with the defaults in one line: OPERATOR_ALLOW=loop_settings alone would take them away.
  const { loadConfig, OPERATOR_DEFAULT_VERBS } = await import('@fb/core');
  const line = /with FG_OPERATOR_TOKEN and (OPERATOR_ALLOW=\S+) in \.env \(the defaults and loop_settings\)/.exec(await refused('POST', '/api/loop/pause'))![1]!;
  const allow = loadConfig({ NEO4J_PASSWORD: 'pw', API_TOKEN: 'a'.repeat(32), FG_OPERATOR_TOKEN: 'o'.repeat(32), OPERATOR_ALLOW: line.slice('OPERATOR_ALLOW='.length) }).operator!.allow;
  expect([...allow].sort()).toEqual([...OPERATOR_DEFAULT_VERBS, 'loop_settings'].sort());
  expect(await refused('POST', '/api/demo/seed')).toContain('or let ./scripts/fg do it with FG_OPERATOR_TOKEN (it may demo by default)');
  expect(await refused('POST', '/api/loop/pause')).toMatch(/learning loop only observes; to stop it, set LOOP_DISABLED=1 in \.env and run docker compose up -d$/);
  expect(await refused('POST', '/api/demo/seed')).not.toMatch(/LOOP_DISABLED/);
  expect(await refused('DELETE', '/api/runs/r1')).toContain('or run ./scripts/fg cleanup --owner');
});

test('tokenless reads answer only peers on this machine: a LAN client sending Host: localhost is refused', async () => {
  const { localPeers } = await import('./peer.ts');
  const lan = createApp(repo, { peerAddress: () => '192.168.1.50', localPeer: localPeers(containerNets as never) });
  for (const path of ['/api/candidates', '/api/sessions', '/api/lessons']) {
    expect((await lan.request(`http://localhost:8787${path}`, { headers: { host: 'localhost:8787' } })).status).toBe(403);
  }
  expect((await lan.request('http://localhost:8787/mcp', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  expect((await lan.request('http://localhost:8787/api/health', { headers: { host: 'localhost:8787' } })).status).toBe(200);
  // With API_TOKEN the token, not the peer, decides.
  const secured = createApp(repo, { auth: { token: TOKEN, ownerToken: OWNER }, peerAddress: () => '192.168.1.50', localPeer: localPeers(containerNets as never) });
  expect((await secured.request('http://localhost:8787/api/candidates', { headers: { host: 'localhost:8787', ...bearer } })).status).toBe(200);
});

test('the real socket peer decides tokenless access: a non-loopback local address is read-only, loopback may decide', async () => {
  const outside = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!outside) return; // no non-loopback interface to connect through
  const serveApp = (localPeer?: (a: string | undefined) => boolean) => new Promise<{ server: Server; port: number }>((resolve) => {
    const app = createApp(repo, { peerAddress: (c) => getConnInfo(c).remote.address, ...(localPeer && { localPeer }) });
    const s = serve({ fetch: app.fetch, port: 0, hostname: '0.0.0.0' }, () => resolve({ server: s as Server, port: (s.address() as AddressInfo).port }));
  });
  // node:http, not fetch: fetch cannot send Host: localhost to another address, and that is the forged case here.
  const call = (address: string, port: number, path: string, write = false) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({
      host: address, port, path, method: write ? 'POST' : 'GET',
      headers: { host: `localhost:${port}`, ...(write && { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: `http://localhost:${port}` }) },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(write ? JSON.stringify({ status: 'rejected' }) : undefined);
  });
  const decide = (address: string, port: number) => call(address, port, '/api/candidates/c1/decision', true);
  const { server, port } = await serveApp();
  try {
    const remote = await decide(outside.address, port);
    expect(remote.status).toBe(403);
    expect(JSON.parse(remote.body).readOnly).toBe(true);
    expect((await call(outside.address, port, '/api/candidates')).status).toBe(200);
    expect((await decide('127.0.0.1', port)).status).toBe(204);
  } finally { server.close(); }
  // The same peer when it is not on any of the API's networks (a LAN client): no reads either.
  const lan = await serveApp(() => false);
  try {
    expect((await call(outside.address, lan.port, '/api/candidates')).status).toBe(403);
  } finally { lan.server.close(); }
});

test('a revocation file missing at a later start is logged when it is written again', () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'fg-session-')), 'revoked.json');
  new OwnerSessions('k'.repeat(32), stateFile);
  rmSync(stateFile);
  expect(new OwnerSessions('k'.repeat(32), stateFile).stateProblem).toMatch(/was missing and is now written/);
  expect(new OwnerSessions('k'.repeat(32), stateFile).stateProblem).toBeUndefined();
});
