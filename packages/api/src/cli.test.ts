import { expect, test } from 'vitest';
import { OPERATOR_VERBS, type ActivityInput } from '@fb/core';
import { createApp, type ApiRepo } from './app.ts';
import { parse, run, type CliIO } from './cli.ts';

const OP = 'o'.repeat(32);

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A fake fetch answering by "METHOD path"; records every request. */
function fake(routes: Record<string, (body: unknown) => { status?: number; json?: unknown }>, env: Record<string, string> = { FG_OPERATOR_TOKEN: OP }) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    env,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    sleep: async () => {},
    fetch: (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
      const h = routes[`${method} ${u.pathname}${u.search}`] ?? routes[`${method} ${u.pathname}`];
      if (!h) return Response.json({ error: `no route ${method} ${u.pathname}` }, { status: 404 });
      const r = h(body);
      return r.json === undefined ? new Response(null, { status: r.status ?? 204 }) : Response.json(r.json, { status: r.status ?? 200 });
    }) as typeof fetch,
  };
  return { io, calls, out, err, text: () => out.join('\n') };
}

test('parse: verbs, flags with values, repeated keys split on commas, and --flag=value', () => {
  expect(parse(['scan', '--key', 'acme,demo-shop', '--provider=codex-cli', '--json'])).toEqual({
    words: ['scan'], flags: { key: ['acme', 'demo-shop'], provider: 'codex-cli', json: true },
  });
  expect(parse(['inbox', 'reject', 'c1', 'c2', '--reason', 'bot comment'])).toEqual({ words: ['inbox', 'reject', 'c1', 'c2'], flags: { reason: 'bot comment' } });
  expect(parse(['projects', 'select', '--key', 'a', '--key', 'b'])).toEqual({ words: ['projects', 'select'], flags: { key: ['a', 'b'] } });
  expect(() => parse(['scan', '--provider'])).toThrow(/--provider needs a value/);
  expect(() => parse(['scan', '--bogus'])).toThrow(/unknown option --bogus/);
});

test('--help and no arguments print the usage; an unknown command fails with it', async () => {
  for (const argv of [['--help'], [], ['help']]) {
    const f = fake({});
    expect(await run(argv, f.io)).toBe(0);
    expect(f.text()).toMatch(/fg scan --all/);
    expect(f.text()).toMatch(/FG_OPERATOR_TOKEN/);
  }
  const f = fake({});
  expect(await run(['frobnicate'], f.io)).toBe(2);
  expect(f.err.join('\n')).toMatch(/unknown command/);
});

test('requests go to FEEDBACK_GRAPH_URL with the operator token and the agent name; the token is never printed', async () => {
  const f = fake({ 'GET /api/status': () => ({ json: { version: '0.4.4', store: 'neo4j', graph: true, worker: null, workerHealthy: false, authRequired: false, selection: null } }) },
    { FG_OPERATOR_TOKEN: OP, FEEDBACK_GRAPH_URL: 'http://127.0.0.1:9999/', FG_OPERATOR_NAME: 'codex' });
  expect(await run(['status'], f.io)).toBe(0);
  expect(f.calls[0].url).toBe('http://127.0.0.1:9999/api/status');
  expect(f.calls[0].headers.authorization).toBe(`Bearer ${OP}`);
  expect(f.calls[0].headers['x-fg-operator']).toBe('codex');
  expect(f.text()).toMatch(/0\.4\.4/);
  expect(f.text()).not.toContain(OP);
  // --as overrides the name; with no operator token the API token signs in (reads only).
  const g = fake({ 'GET /api/status': () => ({ json: { version: 'x' } }) }, { API_TOKEN: 'a'.repeat(32) });
  await run(['status', '--as', 'claude'], g.io);
  expect(g.calls[0].url).toBe('http://localhost:8787/api/status');
  expect(g.calls[0].headers.authorization).toBe(`Bearer ${'a'.repeat(32)}`);
  expect(g.calls[0].headers['x-fg-operator']).toBe('claude');
});

test('the token is never sent over plain http to another machine; https, this machine and no token are fine', async () => {
  const status = { 'GET /api/status': () => ({ json: { version: 'x' } }) };
  const remote = fake(status, { FG_OPERATOR_TOKEN: OP, FEEDBACK_GRAPH_URL: 'http://fg.example.com:8787' });
  expect(await run(['status'], remote.io)).toBe(2);
  expect(remote.calls).toHaveLength(0);
  expect(remote.err.join('\n')).toMatch(/refusing to send .*fg\.example\.com.*https/);
  for (const url of ['https://fg.example.com', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'http://host.docker.internal:8787']) {
    const ok = fake(status, { FG_OPERATOR_TOKEN: OP, FEEDBACK_GRAPH_URL: url });
    expect(await run(['status'], ok.io)).toBe(0);
  }
  const anon = fake(status, { FEEDBACK_GRAPH_URL: 'http://fg.example.com:8787' });
  expect(await run(['status'], anon.io)).toBe(0);
  expect(anon.calls[0].headers.authorization).toBeUndefined();
});

test('text from the server cannot drive the terminal: control characters are stripped from output', async () => {
  const f = fake({ 'GET /api/status': () => ({ json: { version: 'x', worker: { lastError: 'boom\u001b[2J\u001b]0;pwned\u0007 end' } } }) });
  expect(await run(['status'], f.io)).toBe(0);
  expect(f.text()).toContain('boom');
  expect(f.text()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
});

test('status --watch polls until stopped', async () => {
  const f = fake({ 'GET /api/status': () => ({ json: { version: 'x', workerHealthy: true } }) });
  let ticks = 0;
  f.io.sleep = async () => { if (++ticks === 2) throw new Error('stop'); };
  await expect(run(['status', '--watch', '--interval', '1'], f.io)).rejects.toThrow('stop');
  expect(f.calls.length).toBe(2);
});

const settings = {
  tracked: ['acme'],
  candidates: [
    { key: 'acme', path: '/v/acme', exists: true, tracked: true, excluded: false, aliasOf: null, claudeSessions: 3, codexSessions: 1 },
    { key: 'demo-shop', path: '/v/demo-shop', exists: true, tracked: false, excluded: false, aliasOf: null, claudeSessions: 0, codexSessions: 2 },
    { key: 'demo-shop-2', path: '/v/demo-shop-2', exists: true, tracked: false, excluded: false, aliasOf: 'demo-shop', claudeSessions: 1, codexSessions: 0 },
    { key: 'secret', path: '/v/secret', exists: true, tracked: false, excluded: true, aliasOf: null, claudeSessions: 9, codexSessions: 0 },
    { key: 'gone', path: '', exists: false, tracked: false, excluded: false, aliasOf: null, claudeSessions: 0, codexSessions: 0 },
  ],
};

test('projects list shows every folder and whether it is selected', async () => {
  const f = fake({ 'GET /api/settings/projects': () => ({ json: settings }) });
  expect(await run(['projects', 'list'], f.io)).toBe(0);
  const t = f.text();
  expect(t).toMatch(/acme\s+yes/);
  expect(t).toMatch(/demo-shop-2\s+.*clone of demo-shop/);
  expect(t).toMatch(/secret\s+.*excluded/);
  const j = fake({ 'GET /api/settings/projects': () => ({ json: settings }) });
  await run(['projects', 'list', '--json'], j.io);
  expect(JSON.parse(j.text())).toEqual(settings.candidates);
});

test('projects select --key adds to the selection; --only replaces it; --all picks every selectable folder', async () => {
  const put = (b: unknown) => ({ json: { ...settings, tracked: (b as { tracked: string[] }).tracked } });
  const add = fake({ 'GET /api/settings/projects': () => ({ json: settings }), 'PUT /api/settings/projects': put });
  expect(await run(['projects', 'select', '--key', 'demo-shop'], add.io)).toBe(0);
  expect(add.calls[1]).toMatchObject({ method: 'PUT', body: { tracked: ['acme', 'demo-shop'] } });
  expect(add.calls[1].headers['content-type']).toBe('application/json');

  const only = fake({ 'GET /api/settings/projects': () => ({ json: settings }), 'PUT /api/settings/projects': put });
  await run(['projects', 'select', '--only', '--key', 'demo-shop'], only.io);
  expect(only.calls.at(-1)!.body).toEqual({ tracked: ['demo-shop'] });

  // Not excluded, not a clone (it follows its project), and a folder that still exists.
  const all = fake({ 'GET /api/settings/projects': () => ({ json: settings }), 'PUT /api/settings/projects': put });
  await run(['projects', 'select', '--all'], all.io);
  expect(all.calls.at(-1)!.body).toEqual({ tracked: ['acme', 'demo-shop'] });

  const un = fake({ 'GET /api/settings/projects': () => ({ json: settings }), 'PUT /api/settings/projects': put });
  await run(['projects', 'unselect', '--key', 'acme'], un.io);
  expect(un.calls.at(-1)!.body).toEqual({ tracked: [] });

  const none = fake({});
  expect(await run(['projects', 'select'], none.io)).toBe(2);
  expect(none.calls).toEqual([]);
});

test('scan builds the batch request and reports each project', async () => {
  const f = fake({ 'POST /api/projects/scan': () => ({ status: 202, json: { results: [{ key: 'acme', queued: true, job: { id: 'scan:1', status: 'queued' } }, { key: 'x', queued: false, error: 'not selected: choose it in Settings first' }] } }) });
  expect(await run(['scan', '--key', 'acme,x', '--provider', 'codex-cli'], f.io)).toBe(1);
  expect(f.calls[0]).toMatchObject({ method: 'POST', body: { keys: ['acme', 'x'], provider: 'codex-cli' } });
  expect(f.text()).toMatch(/acme\s+queued/);
  expect(f.text()).toMatch(/x\s+not selected/);
  const all = fake({ 'POST /api/projects/scan': () => ({ status: 202, json: { results: [] } }) });
  expect(await run(['scan', '--all'], all.io)).toBe(0);
  expect(all.calls[0].body).toEqual({ all: true });
  expect(await run(['scan'], fake({}).io)).toBe(2);
});

test('inbox list asks for pending items by default and prints a table', async () => {
  const items = [{ id: 'c1', projectKey: 'acme', source: 'github', status: 'pending', createdAt: '2026-10-24T10:00:00Z', classification: { label: 'pushback', confidence: 0.91, summary: 'wants the filter on the server' } }];
  const f = fake({ 'GET /api/candidates?status=pending': () => ({ json: items }) });
  expect(await run(['inbox', 'list'], f.io)).toBe(0);
  expect(f.text()).toMatch(/c1\s+acme\s+github\s+pushback\s+0\.91\s+wants the filter/);
  const g = fake({ 'GET /api/candidates?status=confirmed&project=acme&limit=5': () => ({ json: items }) });
  await run(['inbox', 'list', '--status', 'confirmed', '--project', 'acme', '--limit', '5', '--json'], g.io);
  expect(JSON.parse(g.text())).toEqual(items);
});

test('inbox confirm|reject sends one batch with the reason, and fails if any item failed', async () => {
  const f = fake({ 'POST /api/candidates/decisions': (b) => ({ json: { results: (b as { items: { id: string }[] }).items.map((i) => (i.id === 'nope' ? { id: i.id, ok: false, error: 'not found' } : { id: i.id, ok: true, status: 'rejected' })) } }) });
  expect(await run(['inbox', 'reject', 'c1', 'nope', '--reason', 'the author fixing their own PR'], f.io)).toBe(1);
  expect(f.calls[0].body).toEqual({ items: [{ id: 'c1', decision: 'reject', reason: 'the author fixing their own PR' }, { id: 'nope', decision: 'reject', reason: 'the author fixing their own PR' }] });
  expect(f.text()).toMatch(/c1\s+rejected/);
  expect(f.text()).toMatch(/nope\s+not found/);
  expect(await run(['inbox', 'confirm'], fake({}).io)).toBe(2);
});

test('lessons list and approve; a refusal from the server is shown as it was given', async () => {
  const f = fake({ 'GET /api/lessons?status=proposed': () => ({ json: [{ id: 'l1', status: 'proposed', projectKey: 'acme', title: 'Filter on the server', decidedBy: null }] }) });
  expect(await run(['lessons', 'list'], f.io)).toBe(0);
  expect(f.text()).toMatch(/l1\s+proposed\s+acme\s+Filter on the server/);

  const refused = 'the operator token may not lesson decide (lesson_decide): add lesson_decide to OPERATOR_ALLOW in .env and restart, or do it in the Feedback Graph UI';
  const g = fake({ 'PATCH /api/lessons/l1': () => ({ status: 403, json: { error: refused } }) });
  expect(await run(['lessons', 'approve', 'l1'], g.io)).toBe(1);
  expect(g.calls[0]).toMatchObject({ method: 'PATCH', body: { status: 'approved' } });
  expect(g.err.join('\n')).toContain(refused);

  const ok = fake({ 'PATCH /api/lessons/l%3A1': () => ({ status: 204 }) });
  expect(await run(['lessons', 'reject', 'l:1'], ok.io)).toBe(0);
  expect(ok.calls[0].body).toEqual({ status: 'rejected' });
});

test('cloud sync-now posts to the sync route', async () => {
  const f = fake({ 'POST /api/cloud/sync': () => ({ json: { ok: true, sent: { lessons: 2 } } }) });
  expect(await run(['cloud', 'sync-now'], f.io)).toBe(0);
  expect(f.calls[0]).toMatchObject({ method: 'POST', body: {} });
});

test('an unreachable server says where it looked and how to point elsewhere', async () => {
  const f = fake({});
  f.io.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  expect(await run(['status'], f.io)).toBe(1);
  expect(f.err.join('\n')).toMatch(/cannot reach Feedback Graph at http:\/\/localhost:8787.*FEEDBACK_GRAPH_URL/);
});

test('a decision refused without an operator token says how to allow it', async () => {
  const f = fake({ 'POST /api/projects/scan': () => ({ status: 403, json: { error: 'only you can make this decision, from the Feedback Graph UI' } }) }, {});
  expect(await run(['scan', '--key', 'demo-shop'], f.io)).toBe(1);
  expect(f.err.join('\n')).toMatch(/403 only you can make this decision.*set FG_OPERATOR_TOKEN/);
});

test('end to end against the real app: fg decides Inbox items as the agent, and may not approve lessons by default', async () => {
  const logged: ActivityInput[] = [];
  const decided: unknown[][] = [];
  const repo = {
    listCandidates: async () => [], stats: async () => [],
    decide: async (...a: unknown[]) => { decided.push(a); },
    candidateDetail: async (id: string) => (id === 'c1' ? { candidate: { id, projectKey: 'acme', classification: { label: 'pushback', confidence: 1 } }, turn: { text: 't' }, before: [], after: [], commits: [] } : null),
  } as unknown as ApiRepo;
  const lesson = { id: 'l1', projectKey: 'acme', title: 'T', rule: 'R', appliesWhen: '', scope: 'project', paths: [], status: 'proposed' };
  const app = createApp(repo, {
    auth: { operator: { token: OP, allow: OPERATOR_VERBS.filter((v) => v !== 'lesson_decide') } },
    activity: { record: async (e: ActivityInput) => { logged.push(e); }, list: async () => [] },
    knowledge: { listLessons: async () => [lesson], lessonDetail: async () => ({ lesson }), updateLesson: async () => ({ unscoped: false }) } as never,
  });
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    env: { FG_OPERATOR_TOKEN: OP, FG_OPERATOR_NAME: 'codex' }, out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {},
    fetch: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch,
  };
  expect(await run(['inbox', 'confirm', 'c1'], io)).toBe(0);
  expect(decided).toEqual([['c1', 'confirmed', null]]);
  expect(logged[0].actor).toBe('operator:codex');
  expect(await run(['lessons', 'approve', 'l1'], io)).toBe(1);
  expect(err.join('\n')).toMatch(/403 .*lesson_decide.*OPERATOR_ALLOW/);
});
