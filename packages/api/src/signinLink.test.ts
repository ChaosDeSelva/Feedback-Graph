import { afterEach, expect, test, vi } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { SIGNIN_LINK_TTL_MS } from './auth.ts';
import { run, type CliIO } from './cli.ts';

// fg signin: the owner token buys a one-time link that signs this machine's browser in, so nobody copies it out of .env.
const repo = { listCandidates: async () => [], stats: async () => [], decide: async () => {} } as unknown as ApiRepo;
const OWNER = 'owner-signin-link-test-token-0123456789abcdef';
const API = 'api-signin-link-test-token-0123456789abcdef';
const HOST = 'localhost:8797';
afterEach(() => { vi.useRealTimers(); });

function install(o: { ownerToken?: string; token?: string; publicHosts?: string[] } = { ownerToken: OWNER, token: API }) {
  const logged: unknown[] = [];
  const app = createApp(repo, { auth: o, log: (...line: unknown[]) => { logged.push(line); } });
  const mint = (bearer: string | null = OWNER, headers: Record<string, string> = {}) => app.request('http://localhost/api/session/link', {
    method: 'POST', body: '{}', headers: { host: HOST, 'content-type': 'application/json', ...(bearer && { authorization: `Bearer ${bearer}` }), ...headers },
  });
  const open = (path: string, headers: Record<string, string> = {}) => app.request(`http://localhost${path}`, { headers: { host: HOST, ...headers } });
  const signedIn = async (cookie: string) => (await (await app.request('http://localhost/api/session', { headers: { host: HOST, cookie } })).json() as { ownerSession: boolean }).ownerSession;
  return { app, logged, mint, open, signedIn };
}
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

test('the owner token mints a link; opening it once signs the browser in and lands on the Dashboard', async () => {
  const s = install();
  const minted = await s.mint();
  expect(minted.status).toBe(200);
  const { path, expiresInSeconds } = await minted.json() as { path: string; expiresInSeconds: number };
  expect(path).toMatch(/^\/api\/session\/link\?code=[\w-]{43}$/);
  expect(expiresInSeconds).toBe(SIGNIN_LINK_TTL_MS / 1000);
  const opened = await s.open(path);
  expect(opened.status).toBe(303);
  expect(opened.headers.get('location')).toBe('/');
  expect(opened.headers.get('set-cookie')).toMatch(/^fg_session_8797=[^;]+; Path=\/; HttpOnly; SameSite=Strict/);
  expect(await s.signedIn(cookieOf(opened))).toBe(true);
  // Never logged: the request log has the path, not the code.
  expect(JSON.stringify(s.logged)).not.toContain(path.split('code=')[1]);
});

test('replay: a link works once', async () => {
  const s = install();
  const { path } = await (await s.mint()).json() as { path: string };
  expect((await s.open(path)).status).toBe(303);
  const again = await s.open(path);
  expect(again.status).toBe(403);
  expect(again.headers.get('set-cookie')).toBeNull();
  expect(await again.text()).toMatch(/expired or was already used.*fg signin/);
});

test('expiry: a link older than its lifetime is refused', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const s = install();
  const { path } = await (await s.mint()).json() as { path: string };
  vi.setSystemTime(Date.now() + SIGNIN_LINK_TTL_MS + 1);
  const late = await s.open(path);
  expect(late.status).toBe(403);
  expect(late.headers.get('set-cookie')).toBeNull();
});

test('wrong host: only localhost, directly; a public name or a proxy neither mints nor opens a link, and the code is spent', async () => {
  const s = install({ ownerToken: OWNER, token: API, publicHosts: ['fg.example.com'] });
  expect((await s.mint(OWNER, { host: 'fg.example.com' })).status).toBe(403);
  expect((await s.mint(OWNER, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
  const { path } = await (await s.mint()).json() as { path: string };
  const remote = await s.open(path, { host: 'fg.example.com' });
  expect(remote.status).toBe(403);
  expect(remote.headers.get('set-cookie')).toBeNull();
  expect((await s.open(path)).status).toBe(403);
  const { path: proxied } = await (await s.mint()).json() as { path: string };
  expect((await s.open(proxied, { forwarded: 'for=203.0.113.9' })).status).toBe(403);
  // A host that is not this install's at all never reaches the route, and the code it carried is spent all the same.
  const { path: rebound } = await (await s.mint()).json() as { path: string };
  expect((await s.open(rebound, { host: 'evil.example' })).status).toBe(403);
  const after = await s.open(rebound);
  expect(after.status).toBe(403);
  expect(after.headers.get('set-cookie')).toBeNull();
});

test('only the owner token mints: no bearer, the API token or a wrong one is refused; a made-up code signs nobody in', async () => {
  const s = install();
  expect((await s.mint(null)).status).toBe(401);
  expect((await s.mint(API)).status).toBe(401);
  expect((await s.mint('x'.repeat(44))).status).toBe(401);
  expect((await s.open('/api/session/link?code=' + 'A'.repeat(43))).status).toBe(403);
  expect((await s.open('/api/session/link')).status).toBe(403);
});

test('tokenless: an install without FG_OWNER_TOKEN has no sign-in link', async () => {
  const s = install({});
  expect((await s.mint('anything')).status).toBe(403);
  expect((await s.open('/api/session/link?code=' + 'A'.repeat(43))).status).toBe(403);
});

test('fg signin prints the link for the published port, sends the owner token only to localhost, and never prints it', async () => {
  const out: string[] = [], err: string[] = [];
  const sent: { url: string; auth: string | null }[] = [];
  const io: CliIO = {
    env: { FG_OWNER_TOKEN: OWNER, FEEDBACK_GRAPH_URL: 'http://localhost:8787', API_PORT: '8797' },
    fetch: (async (url: string, init?: RequestInit) => {
      sent.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return Response.json({ path: '/api/session/link?code=abc', expiresInSeconds: 60 });
    }) as typeof fetch,
    out: (l) => { out.push(l); }, err: (l) => { err.push(l); }, sleep: async () => {},
  };
  expect(await run(['signin'], io)).toBe(0);
  expect(sent).toEqual([{ url: 'http://localhost:8787/api/session/link', auth: `Bearer ${OWNER}` }]);
  expect(out.at(-1)).toBe('http://localhost:8797/api/session/link?code=abc');
  expect(out.join('\n')).not.toContain(OWNER);
  expect(await run(['signin', '--url', 'https://fg.example.com'], io)).toBe(2);
  expect(sent).toHaveLength(1);
  expect(await run(['signin'], { ...io, env: {} })).toBe(2);
  expect(err.join('\n')).toMatch(/needs FG_OWNER_TOKEN/);
});
