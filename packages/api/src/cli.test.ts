import { expect, test } from 'vitest';
import { OPERATOR_VERBS, type ActivityInput } from '@fb/core';
import { createApp, type ApiRepo } from './app.ts';
import { helpFor, parse, run, type CliIO } from './cli.ts';

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
  expect(f.calls.filter((c) => c.url.endsWith('/api/status')).length).toBe(2);
});

test('status --watch follows /api/events when the API has it: the status again on a change, new Activity as lines', async () => {
  // The worker's stage as the stream has told it so far.
  let latest = 'ingest';
  const f = fake({
    'GET /api/status': () => ({ json: { version: 'x', workerHealthy: true, stage: { name: latest, startedAt: '2026-10-24T10:00:00Z', current: null } } }),
    'GET /api/pipeline': () => ({ json: { inbox: { pending: 1, confirmed: 0 } } }),
  });
  const chunks = [
    'retry: 5000\n\n',
    'event: stage\ndata: {"stage":{"name":"classify"}}\n\n',
    'event: activity\ndata: {"id":"a1","ts":"t","kind":"doc_added","subject":"uploaded \\"notes\\"","projectKey":"acme","actor":"you"}\n\n',
    ': ping\n\n',
    'event: pipeline\ndata: {"inbox":{"pending":1,"confirmed":0}}\n\nevent: st',
    'age\ndata: {"stage":{"name":"waiting"}}\n\n',
  ];
  const plain = f.io.fetch;
  let opened: Headers | null = null;
  f.io.fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/api/events')) return plain(url, init);
    opened = new Headers(init?.headers);
    const enc = new TextEncoder();
    let i = 0;
    // One chunk per read, so fg renders between them.
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i === chunks.length) return c.close();
        const chunk = chunks[i++];
        latest = /"name":"(\w+)"/.exec(chunk)?.[1] ?? latest;
        c.enqueue(enc.encode(chunk));
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  // When the stream ends, fg goes back to polling: the first sleep there stops the test.
  let polled = false;
  f.io.sleep = async (ms) => { if (ms >= 1000) { polled = true; throw new Error('stop'); } };
  await expect(run(['status', '--watch'], f.io)).rejects.toThrow('stop');
  expect(polled).toBe(true);
  expect(opened!.get('accept')).toBe('text/event-stream');
  const t = f.text();
  expect(t).toContain('activity  doc_added [acme]: uploaded "notes"');
  // Printed when it changed only (a fetch that finds the same status prints nothing, nor does the poll after the stream
  // ended), and then only the line that changed.
  const stageLines = t.split('\n').filter((l) => l.startsWith('stage'));
  expect(stageLines.map((l) => l.split(/\s+/)[1])).toEqual(['ingest', 'classify', 'waiting']);
  expect(t.match(/^version/gm)).toHaveLength(1);
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

const summaries = [
  { key: 'acme', repoPath: '/roots/1/acme', remote: 'github.com/acme/acme', aliases: [], sessions: 4, feedback: 2, lessons: 3, facts: 40, pinned: true,
    lastScan: { id: 'scan:1', status: 'done', finishedAt: '2026-10-25T03:00:00Z', requestedAt: '2026-10-25T02:59:00Z' } },
];
const links = [{ id: 'link:acme|demo-shop', a: 'acme', b: 'demo-shop', relation: 'depends_on', status: 'confirmed', score: 0.94 }, { id: 'link:acme|web', a: 'acme', b: 'web', relation: 'related', status: 'suggested', score: 0.6 }];

test('projects list joins every folder with the shown projects: pinned, counts, last scan and links', async () => {
  const routes = {
    'GET /api/settings/projects': () => ({ json: settings }),
    'GET /api/projects': () => ({ json: summaries }),
    'GET /api/projects/acme/links': () => ({ json: links }),
  };
  const f = fake(routes);
  expect(await run(['projects', 'list'], f.io)).toBe(0);
  const t = f.text();
  expect(t.split('\n')[0]).toMatch(/KEY\s+SELECTED\s+PINNED\s+SESSIONS\s+FEEDBACK\s+LESSONS\s+FACTS\s+LAST SCAN\s+LINKS\s+NOTE/);
  expect(t).toMatch(/acme\s+yes\s+yes\s+4\s+2\s+3\s+40\s+done 2026-10-25 03:00\s+1 confirmed, 1 suggested/);
  expect(t).toMatch(/demo-shop-2\s+.*clone of demo-shop/);
  expect(t).toMatch(/secret\s+.*excluded/);
  // Links are asked for the shown projects only.
  expect(f.calls.filter((c) => c.url.includes('/links')).map((c) => new URL(c.url).pathname)).toEqual(['/api/projects/acme/links']);
  const j = fake(routes);
  await run(['projects', 'list', '--json'], j.io);
  const rows = JSON.parse(j.text());
  expect(rows.find((r: { key: string }) => r.key === 'acme')).toMatchObject({ tracked: true, pinned: true, facts: 40, lastScan: { status: 'done' }, links: { confirmed: 1, suggested: 1, dismissed: 0 } });
  expect(rows.find((r: { key: string }) => r.key === 'secret')).toMatchObject({ excluded: true, pinned: false });
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
  const f = fake({ 'GET /api/lessons?status=proposed': () => ({ json: [{ id: 'l1', status: 'proposed', projectKey: 'acme', title: 'Filter on the server', decidedBy: null, from: 'github', checks: [{ name: 'platitude', why: 'w' }] }] }) });
  expect(await run(['lessons', 'list'], f.io)).toBe(0);
  expect(f.text()).toMatch(/l1\s+proposed\s+acme\s+github\s+platitude\s+Filter on the server/);

  const refused = 'the operator token may not lesson decide (lesson_decide): add lesson_decide to OPERATOR_ALLOW in .env and restart, or do it in the Feedback Graph UI';
  const g = fake({ 'POST /api/lessons/decisions': () => ({ status: 403, json: { error: refused } }) });
  expect(await run(['lessons', 'approve', 'l1'], g.io)).toBe(1);
  expect(g.calls[0]).toMatchObject({ method: 'POST', body: { items: [{ id: 'l1', status: 'approved' }] } });
  expect(g.err.join('\n')).toContain(refused);
});

test('lessons approve|reject take many ids and a --note, send one batch, and fail if any lesson failed', async () => {
  const f = fake({ 'POST /api/lessons/decisions': (b) => ({ json: { results: (b as { items: { id: string }[] }).items.map((i) => (i.id === 'nope' ? { id: i.id, ok: false, error: 'not found' } : { id: i.id, ok: true, status: 'rejected' })) } }) });
  expect(await run(['lessons', 'reject', 'l:1', 'l2', 'nope', '--note', 'platitudes'], f.io)).toBe(1);
  expect(f.calls[0].body).toEqual({ items: ['l:1', 'l2', 'nope'].map((id) => ({ id, status: 'rejected', note: 'platitudes' })) });
  expect(f.text()).toMatch(/l2\s+rejected/);
  expect(f.text()).toMatch(/nope\s+not found/);
  const ok = fake({ 'POST /api/lessons/decisions': () => ({ json: { results: [{ id: 'l1', ok: true, status: 'approved' }] } }) });
  expect(await run(['lessons', 'approve', 'l1'], ok.io)).toBe(0);
  expect(ok.calls[0].body).toEqual({ items: [{ id: 'l1', status: 'approved' }] });
  expect(await run(['lessons', 'reject'], fake({}).io)).toBe(2);
});

test('lessons list filters by --flag and --source; lessons recheck asks the worker to re-check', async () => {
  const f = fake({ 'GET /api/lessons?status=proposed&flag=looks-like-a-fact&source=session': () => ({ json: [] }) });
  expect(await run(['lessons', 'list', '--flag', 'looks-like-a-fact', '--source', 'session'], f.io)).toBe(0);
  expect(f.text()).toContain('no proposed lessons');
  const r = fake({ 'POST /api/lessons/recheck': () => ({ status: 202, json: { queued: 12 } }) });
  expect(await run(['lessons', 'recheck'], r.io)).toBe(0);
  expect(r.text()).toMatch(/12 lessons queued for a re-check/);
});

test('cloud sync-now posts to the sync route', async () => {
  const f = fake({ 'POST /api/cloud/sync': () => ({ json: { ok: true, sent: { lessons: 2 } } }) });
  expect(await run(['cloud', 'sync-now'], f.io)).toBe(0);
  expect(f.calls[0]).toMatchObject({ method: 'POST', body: {} });
});

test('map rebuild asks for a fresh code map of one project; a project with no map yet fails with the reason', async () => {
  const f = fake({
    'POST /api/projects/demo-shop/codemap/rebuild': () => ({ status: 202, json: { queued: true } }),
    'POST /api/projects/acme/codemap/rebuild': () => ({ status: 404, json: { error: 'no code map yet: the worker builds the first one within a few minutes' } }),
  });
  expect(await run(['map', 'rebuild', 'demo-shop'], f.io)).toBe(0);
  expect(f.calls[0]).toMatchObject({ method: 'POST', body: {} });
  expect(f.text()).toMatch(/demo-shop: rebuild queued/);
  expect(await run(['map', 'rebuild', 'acme'], f.io)).toBe(1);
  expect(f.err.join('\n')).toMatch(/no code map yet/);
  expect(await run(['map', 'rebuild'], f.io)).toBe(2);
  expect(await run(['map', 'show', 'acme'], f.io)).toBe(2);
});

test('demo seed and remove post to the demo routes and print what they say; --project passes through', async () => {
  const f = fake({
    'POST /api/demo/seed': (b) => ({ json: { project: (b as { project?: string }).project ?? 'demo-shop', lessons: 4, misses: 1, facts: 3, message: 'Seeded the demo corpus into demo-shop.\nThese lessons are approved by you running fg demo seed.' } }),
    'POST /api/demo/remove': () => ({ json: { project: 'demo-shop', lessons: 4, misses: 1, facts: 3, message: 'Removed 4 demo lessons, 1 miss and 3 facts from demo-shop.' } }),
  });
  expect(await run(['demo', 'seed'], f.io)).toBe(0);
  expect(f.calls[0]).toMatchObject({ method: 'POST', body: {} });
  expect(f.text()).toMatch(/approved by you running fg demo seed/);
  expect(await run(['demo', 'seed', '--project', 'acme'], f.io)).toBe(0);
  expect(f.calls[1]).toMatchObject({ body: { project: 'acme' } });
  expect(await run(['demo', 'remove'], f.io)).toBe(0);
  expect(f.text()).toMatch(/Removed 4 demo lessons/);
  expect(await run(['demo', 'show'], f.io)).toBe(2);
  expect(helpFor('demo')).toMatch(/fg demo seed/);
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
  expect(decided).toEqual([['c1', 'confirmed', null, 'operator:codex']]);
  expect(logged[0].actor).toBe('operator:codex');
  expect(await run(['lessons', 'approve', 'l1'], io)).toBe(1);
  expect(err.join('\n')).toMatch(/403 .*lesson_decide.*OPERATOR_ALLOW/);
});


// ── Waiting, and the verbs over existing routes ─────────────────────────

const idle = { version: '0.5.1', workerHealthy: true, stage: { name: 'waiting', startedAt: '2026-10-25T03:50:00Z', current: null } };
const pipeline = (o: object = {}) => ({ json: { stage: null, progress: null, sessions: 10, classify: { backlog: 0, capped: false }, inbox: { pending: 4, confirmed: 1 }, postmortems: { queued: 0 }, lessons: { proposed: 2, approved: 0 }, scans: { done: 3, queued: 0, running: 0, failed: 0, never: 0 }, ...o } });

test('status prints the stage and since when, the pipeline backlog, the last Sync now and since when a model is down', async () => {
  const f = fake({
    'GET /api/status': () => ({ json: {
      ...idle, stage: { name: 'ingest', startedAt: '2026-10-25T03:38:29Z', current: '3ff6.jsonl' }, progress: { done: 1, total: null },
      models: { classify: { provider: 'ollama:gemma4', ok: false, reason: 'Ollama is not reachable', since: '2026-10-25T03:00:00Z' } },
      cloud: { host: 'cloud.example.com', token: '[REDACTED]', intervalMinutes: 60, lastManual: { at: '2026-10-25T03:43:00Z', ok: true, error: null, sent: { projects: 2 }, unchanged: 68, failed: 0 }, syncing: null },
    } }),
    'GET /api/pipeline': () => pipeline({ classify: { backlog: 12, capped: false }, scans: { done: 3, queued: 2, running: 1, failed: 0, never: 0 } }),
  });
  expect(await run(['status'], f.io)).toBe(0);
  const t = f.text();
  expect(t).toMatch(/stage\s+ingest 3ff6\.jsonl \(1 done\) since 2026-10-25 03:38:29/);
  expect(t).toMatch(/pipeline\s+classify 12 · inbox 4 pending · postmortems 0 · lessons 2 proposed · scans 1 running, 2 queued/);
  expect(t).toMatch(/UNAVAILABLE since 2026-10-25 03:00:00: Ollama is not reachable/);
  expect(t).toMatch(/sync now\s+2026-10-25 03:43:00 ok: sent 2 projects, 68 unchanged/);
});

test('status prints every queue: how many wait, the oldest wait, what runs now and for how long, and each scan by project', async () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const queues = {
    scans: {
      waiting: 2, oldestAt: ago(125), running: [{ what: 'big', since: ago(14), shards: { done: 11, total: 40 } }],
      projects: [
        { project: 'big', status: 'running', since: ago(14), shards: { done: 11, total: 40 } },
        { project: 'shop', status: 'queued', since: ago(125), shards: null },
        { project: 'web', status: 'queued', since: ago(5), shards: { done: 3, total: 8 } },
      ],
    },
    classify: { waiting: 120, capped: true, oldestAt: ago(190), running: [] },
    postmortems: { waiting: 2, oldestAt: ago(10), running: [{ what: 'fb-1', since: ago(3) }] },
    chats: { waiting: 0, oldestAt: null, running: [] },
  };
  const f = fake({ 'GET /api/status': () => ({ json: idle }), 'GET /api/pipeline': () => pipeline({ queues }) });
  expect(await run(['status'], f.io)).toBe(0);
  const t = f.text();
  expect(t).toMatch(/queue\s+scans: 2 waiting, oldest 2 h; running shard 12\/40 of big for 14 min/);
  expect(t).toMatch(/\s+shop\s+queued 2 h\n/);
  expect(t).toMatch(/\s+web\s+queued 5 min, 3 of 8 shards done/);
  expect(t).toMatch(/queue\s+classify: 120\+ waiting, oldest at least 3 h/);
  expect(t).toMatch(/queue\s+post-mortems: 2 waiting, oldest 10 min; running fb-1 for 3 min/);
  expect(t).toMatch(/queue\s+Ask answers: none waiting/);
  // An older API without queues prints none of it.
  const old = fake({ 'GET /api/status': () => ({ json: idle }), 'GET /api/pipeline': () => pipeline() });
  await run(['status'], old.io);
  expect(old.text()).not.toMatch(/^queue/m);
});

test('status says how many files an older scanner read, and that a scan you start refreshes them', async () => {
  const f = fake({ 'GET /api/status': () => ({ json: idle }), 'GET /api/pipeline': () => pipeline({ scans: { done: 3, queued: 0, running: 0, failed: 0, never: 0, olderScanner: { files: 15, projects: { acme: 12, web: 3 } } } }) });
  expect(await run(['status'], f.io)).toBe(0);
  expect(f.text()).toMatch(/scanner\s+15 files were read by an older scanner \(acme 12, web 3\): press Scan on the Projects page \(or fg scan <project>\) to refresh them/);
  const none = fake({ 'GET /api/status': () => ({ json: idle }), 'GET /api/pipeline': () => pipeline() });
  await run(['status'], none.io);
  expect(none.text()).not.toMatch(/older scanner/);
});

test('status --until idle waits until the worker is waiting and nothing is queued; --timeout gives up with exit 1', async () => {
  const backlog = [5, 0];
  const f = fake({ 'GET /api/status': () => ({ json: idle }), 'GET /api/pipeline': () => pipeline({ classify: { backlog: backlog.shift() ?? 0, capped: false } }) });
  expect(await run(['status', '--until', 'idle', '--interval', '1'], f.io)).toBe(0);
  expect(f.calls.filter((c) => c.url.endsWith('/api/pipeline')).length).toBe(2);
  expect(f.text()).toMatch(/idle/);

  const busy = fake({ 'GET /api/status': () => ({ json: { ...idle, stage: { name: 'classify', startedAt: 't', current: null } } }), 'GET /api/pipeline': () => pipeline() });
  expect(await run(['status', '--until', 'idle', '--interval', '5', '--timeout', '12'], busy.io)).toBe(1);
  expect(busy.err.join('\n')).toMatch(/still not idle after 12 s/);

  // A stage name waits for that stage.
  const stage = fake({ 'GET /api/status': () => ({ json: { ...idle, stage: { name: 'scan', startedAt: 't', current: null } } }), 'GET /api/pipeline': () => pipeline() });
  expect(await run(['status', '--until', 'scan'], stage.io)).toBe(0);
  expect(await run(['status', '--until', 'nap'], fake({}).io)).toBe(2);
});

test('scan --wait follows each queued job until it is done or failed, and fails if any failed', async () => {
  const states: Record<string, string[]> = { 'scan:1': ['queued', 'running', 'done'], 'scan:2': ['running', 'failed'] };
  const f = fake({
    'POST /api/projects/scan': () => ({ status: 202, json: { results: [{ key: 'acme', queued: true, job: { id: 'scan:1', status: 'queued' } }, { key: 'web', queued: true, job: { id: 'scan:2', status: 'queued' } }] } }),
    'GET /api/scans/scan%3A1': () => { const st = states['scan:1'].length > 1 ? states['scan:1'].shift()! : states['scan:1'][0]; return { json: { id: 'scan:1', projectKey: 'acme', status: st, filesScanned: 6, factsAdded: 31, error: null, queuePosition: st === 'queued' ? 1 : null } }; },
    'GET /api/scans/scan%3A2': () => { const st = states['scan:2'].length > 1 ? states['scan:2'].shift()! : states['scan:2'][0]; return { json: { id: 'scan:2', projectKey: 'web', status: st, filesScanned: 0, factsAdded: 0, error: st === 'failed' ? 'not valid JSON' : null, queuePosition: null } }; },
  });
  expect(await run(['scan', '--key', 'acme,web', '--wait'], f.io)).toBe(1);
  const t = f.text();
  expect(t).toMatch(/acme\s+done: 6 files, 31 facts/);
  expect(t).toMatch(/web\s+failed: not valid JSON/);
  // A job still going when --timeout runs out: exit 1 and what it was doing.
  const slow = fake({
    'POST /api/projects/scan': () => ({ status: 202, json: { results: [{ key: 'acme', queued: true, job: { id: 'scan:1', status: 'queued' } }] } }),
    'GET /api/scans/scan%3A1': () => ({ json: { id: 'scan:1', projectKey: 'acme', status: 'queued', queuePosition: 3 } }),
  });
  expect(await run(['scan', '--key', 'acme', '--wait', '--timeout', '6', '--interval', '2'], slow.io)).toBe(1);
  expect(slow.text()).toMatch(/acme\s+still queued \(3rd in the queue\)/);
});

test('pipeline prints each stage\'s count; --json is the API body', async () => {
  const f = fake({ 'GET /api/pipeline': () => pipeline() });
  expect(await run(['pipeline'], f.io)).toBe(0);
  expect(f.text()).toMatch(/inbox\s+4 pending, 1 confirmed/);
  expect(f.text()).toMatch(/scans\s+3 done, 0 queued, 0 running, 0 failed, 0 never/);
  const j = fake({ 'GET /api/pipeline': () => pipeline() });
  await run(['pipeline', '--json'], j.io);
  expect(JSON.parse(j.text()).inbox).toEqual({ pending: 4, confirmed: 1 });
});

test('inbox show and lessons show print one item, with who decided it', async () => {
  const f = fake({ 'GET /api/candidates/github%3Aacme%2Fshop%2313': () => ({ json: {
    candidate: { id: 'github:acme/shop#13', projectKey: 'acme', source: 'github', status: 'rejected', decidedBy: 'operator:codex', note: 'author reply', classification: { label: 'pushback', confidence: 1, summary: 'says it is fixed' }, external: { author: 'sam', url: 'https://github.com/acme/shop/pull/13' } },
    turn: { text: 'Fixed in abc123' }, before: [], after: [], commits: [], postmortem: null,
  } }) });
  expect(await run(['inbox', 'show', 'github:acme/shop#13'], f.io)).toBe(0);
  const t = f.text();
  expect(t).toMatch(/status\s+rejected by operator:codex/);
  expect(t).toMatch(/comment\s+Fixed in abc123/);
  expect(t).toMatch(/note\s+author reply/);
  const l = fake({ 'GET /api/lessons/l1': () => ({ json: { lesson: { id: 'l1', status: 'proposed', projectKey: 'acme', title: 'Filter on the server', rule: 'Never filter client-side', appliesWhen: 'list endpoints', scope: 'project', paths: ['api/search.ts'], decidedBy: null }, miss: { missed: 'filtered in the browser', cause: 'context_missing' }, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } }) });
  expect(await run(['lessons', 'show', 'l1'], l.io)).toBe(0);
  expect(l.text()).toMatch(/rule\s+Never filter client-side/);
  expect(l.text()).toMatch(/paths\s+api\/search\.ts/);
  expect(await run(['inbox', 'show'], fake({}).io)).toBe(2);
});

test('links list a project\'s links; confirm and dismiss decide one by its two projects', async () => {
  const f = fake({ 'GET /api/projects/acme/links': () => ({ json: links }), 'PUT /api/links': (b) => ({ json: { ...links[0], ...(b as object) } }) });
  expect(await run(['links', 'list', '--project', 'acme'], f.io)).toBe(0);
  expect(f.text()).toMatch(/acme\s+demo-shop\s+depends_on\s+confirmed\s+0\.94/);
  expect(await run(['links', 'dismiss', 'acme', 'web', '--note', 'unrelated'], f.io)).toBe(0);
  expect(f.calls.at(-1)).toMatchObject({ method: 'PUT', body: { a: 'acme', b: 'web', status: 'dismissed', note: 'unrelated' } });
  expect(await run(['links', 'list'], fake({}).io)).toBe(2);
});

test('facts list and relevance', async () => {
  const facts = [{ id: 'f1', kind: 'convention', path: 'src/a.ts', statement: 'Every query is scoped by orgId', relevance: 0.9, relevanceBy: 'model' }];
  const f = fake({ 'GET /api/projects/acme/facts?kind=convention': () => ({ json: facts }), 'PATCH /api/projects/acme/facts/f1/relevance': () => ({ status: 204 }) });
  expect(await run(['facts', 'list', '--project', 'acme', '--kind', 'convention'], f.io)).toBe(0);
  expect(f.text()).toMatch(/f1\s+convention\s+0\.90 model\s+src\/a\.ts\s+Every query/);
  expect(await run(['facts', 'relevance', 'f1', '0.2', '--project', 'acme'], f.io)).toBe(0);
  expect(f.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { relevance: 0.2 } });
  expect(await run(['facts', 'relevance', 'f1', 'lots', '--project', 'acme'], fake({}).io)).toBe(2);
});

test('docs list and upload a text file or an image', async () => {
  const files: Record<string, Buffer> = { '/tmp/notes.md': Buffer.from('tenants are isolated'), '/tmp/shot.png': Buffer.from([137, 80, 78, 71]) };
  const f = fake({
    'GET /api/projects/acme/docs?limit=500': () => ({ json: [{ id: 'doc:acme:upload:notes.md', title: 'Notes', ref: 'notes.md', source: 'upload', kind: 'text', addedAt: '2026-10-25T03:00:00Z', addedBy: 'operator:codex', read: { status: 'done', facts: 2 } }] }),
    'POST /api/projects/acme/docs': () => ({ status: 201, json: { id: 'doc:acme:upload:notes.md', chunks: 1 } }),
  });
  f.io.readFile = async (path: string) => { if (!files[path]) throw new Error('ENOENT'); return files[path]; };
  expect(await run(['docs', 'list', '--project', 'acme'], f.io)).toBe(0);
  expect(f.text()).toMatch(/notes\.md\s+text\s+done \(2 facts\)\s+operator:codex/);
  expect(f.text()).not.toMatch(/newest/);
  // a full page says the list goes on
  const doc = (i: number) => ({ id: `doc:acme:github:${i}`, title: `PR ${i}`, ref: `github:acme/shop#${i}`, source: 'github', kind: 'text', addedAt: '2026-10-25T03:00:00Z', addedBy: null, read: null });
  const full = fake({ 'GET /api/projects/acme/docs?limit=500': () => ({ json: Array.from({ length: 500 }, (_, i) => doc(i)) }) });
  expect(await run(['docs', 'list', '--project', 'acme'], full.io)).toBe(0);
  expect(full.text()).toMatch(/the newest 500 documents are shown: older ones are on the project's Docs page/);
  expect(await run(['docs', 'upload', '/tmp/notes.md', '--project', 'acme', '--title', 'Notes'], f.io)).toBe(0);
  expect(f.calls.at(-1)!.body).toEqual({ title: 'Notes', name: 'notes.md', text: 'tenants are isolated' });
  expect(await run(['docs', 'upload', '/tmp/shot.png', '--project', 'acme'], f.io)).toBe(0);
  expect(f.calls.at(-1)!.body).toEqual({ title: 'shot.png', name: 'shot.png', image: { mediaType: 'image/png', data: files['/tmp/shot.png'].toString('base64') } });
  const missing = fake({});
  missing.io.readFile = async () => { throw new Error('ENOENT: no such file'); };
  expect(await run(['docs', 'upload', '/tmp/nope.md', '--project', 'acme'], missing.io)).toBe(1);
});

test('activity and sessions list what the API returns', async () => {
  const f = fake({
    'GET /api/activity?project=acme&kind=feedback_decided&limit=5': () => ({ json: [{ id: 'a1', ts: '2026-10-25T03:31:55Z', actor: 'operator:fg', kind: 'feedback_decided', projectKey: 'acme', subject: 'rejected: "Fixed in abc"', why: '' }] }),
    'GET /api/sessions?project=acme&limit=10': () => ({ json: { sessions: [{ id: 's1', projectKey: 'acme', source: 'claude', state: 'idle', snippet: 'Build search', lastActivityAt: '2026-10-25T02:00:00Z', turnCount: 12 }], next: null } }),
  });
  expect(await run(['activity', '--project', 'acme', '--kind', 'feedback_decided', '--limit', '5'], f.io)).toBe(0);
  expect(f.text()).toMatch(/2026-10-25 03:31:55\s+operator:fg\s+feedback_decided\s+acme\s+rejected/);
  expect(await run(['sessions', '--project', 'acme', '--limit', '10'], f.io)).toBe(0);
  expect(f.text()).toMatch(/s1\s+acme\s+claude\s+idle/);
});

test('cloud status and integrations status read their routes; sync-now --force resends everything', async () => {
  const f = fake({
    'GET /api/cloud': () => ({ json: { enabled: true, host: 'cloud.example.com', intervalMinutes: 60, suggestions: false, projects: ['acme', 'web'], preview: { total: { projects: 2, lessons: 1, misses: 3, facts: 40, docs: 2, codeFiles: 100 } }, last: { at: '2026-10-25T03:43:00Z', ok: true, trigger: 'manual', error: null }, nextAt: '2026-10-25T04:43:00Z' } }),
    'GET /api/settings/integrations': () => ({ json: { github: { connection: { state: 'connected', detail: 'signed in as acme-bot' }, lastSyncAt: '2026-10-25T03:48:00Z' }, linear: { connection: { state: 'not_connected', detail: 'no key yet' }, lastSyncAt: null } } }),
    'POST /api/cloud/sync': () => ({ json: { ok: true, sent: { projects: 2 }, projects: [{ key: 'acme', status: 'sent' }, { key: 'web', status: 'unchanged' }] } }),
    'GET /api/cloud/progress': () => ({ json: { running: null, lastManual: null } }),
  });
  expect(await run(['cloud', 'status'], f.io)).toBe(0);
  expect(f.text()).toMatch(/host\s+cloud\.example\.com, every 60 min, next 2026-10-25 04:43:00/);
  expect(f.text()).toMatch(/last\s+2026-10-25 03:43:00 \(manual\) ok/);
  expect(await run(['integrations', 'status'], f.io)).toBe(0);
  expect(f.text()).toMatch(/github\s+connected: signed in as acme-bot/);
  expect(await run(['cloud', 'sync-now', '--force'], f.io)).toBe(0);
  expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ force: true });
  expect(f.text()).toMatch(/1 sent, 1 unchanged/);
});

test('integrations set reads the token from stdin (never an argument), sends it once and never prints it; test checks it', async () => {
  const token = 'k'.repeat(40);
  const f = fake({
    'PUT /api/settings/integrations/linear': () => ({ json: { ok: true, view: { linear: { connection: { state: 'connected', detail: 'signed in as Acme' } } } } }),
    'POST /api/settings/integrations/linear/test': () => ({ json: { ok: true, account: 'Acme', error: null } }),
  });
  f.io.readStdin = async () => `${token}\n`;
  expect(await run(['integrations', 'set', 'linear', '--from-stdin'], f.io)).toBe(0);
  expect(f.calls[0]).toMatchObject({ method: 'PUT', body: { token } });
  expect(f.text()).toMatch(/linear\s+connected: signed in as Acme/);
  expect(f.text() + f.err.join('\n')).not.toContain(token);
  expect(await run(['integrations', 'test', 'linear'], f.io)).toBe(0);
  expect(f.text()).toMatch(/linear: ok \(Acme\)/);
  // Without --from-stdin, or with an empty stdin, nothing is sent.
  const g = fake({});
  g.io.readStdin = async () => '\n';
  expect(await run(['integrations', 'set', 'linear'], g.io)).toBe(2);
  expect(await run(['integrations', 'set', 'linear', '--from-stdin'], g.io)).toBe(2);
  expect(await run(['integrations', 'set', 'jira', '--from-stdin'], g.io)).toBe(2);
  expect(g.calls).toEqual([]);
});

test('doctor is run by scripts/fg on the host; the CLI itself says so', async () => {
  const f = fake({});
  expect(await run(['doctor'], f.io)).toBe(2);
  expect(f.err.join('\n')).toMatch(/scripts\/doctor\.sh/);
});

test('setup is run by scripts/fg on the host; the CLI itself (as in the api container) says it must run on the host', async () => {
  const f = fake({});
  expect(await run(['setup', '--yes'], f.io)).toBe(2);
  expect(f.err.join('\n')).toMatch(/scripts\/setup\.sh/);
  expect(f.err.join('\n')).toMatch(/on the host/);
  expect(f.calls).toEqual([]);
});

test('projects list --with-sessions shows only folders with sessions; select --with-sessions selects the selectable ones', async () => {
  const routes = { 'GET /api/settings/projects': () => ({ json: settings }), 'GET /api/projects': () => ({ json: summaries }), 'GET /api/projects/acme/links': () => ({ json: [] }) };
  const f = fake(routes);
  expect(await run(['projects', 'list', '--with-sessions', '--json'], f.io)).toBe(0);
  expect(JSON.parse(f.text()).map((r: { key: string }) => r.key)).toEqual(['acme', 'demo-shop', 'demo-shop-2', 'secret']);
  const t = fake(routes);
  await run(['projects', 'list', '--with-sessions'], t.io);
  expect(t.text()).not.toMatch(/folder gone/);

  const put = (b: unknown) => ({ json: { ...settings, tracked: (b as { tracked: string[] }).tracked } });
  // Not excluded, not a clone, not gone, and with at least one Claude or Codex session.
  const sel = fake({ 'GET /api/settings/projects': () => ({ json: { ...settings, tracked: [] } }), 'PUT /api/settings/projects': put });
  expect(await run(['projects', 'select', '--with-sessions'], sel.io)).toBe(0);
  expect(sel.calls.at(-1)!.body).toEqual({ tracked: ['acme', 'demo-shop'] });
  // With --key it narrows those keys to the ones with sessions.
  const none = { ...settings, tracked: [], candidates: settings.candidates.map((c) => (c.key === 'demo-shop' ? { ...c, codexSessions: 0 } : c)) };
  const keyed = fake({ 'GET /api/settings/projects': () => ({ json: none }), 'PUT /api/settings/projects': put });
  await run(['projects', 'select', '--with-sessions', '--key', 'acme,demo-shop'], keyed.io);
  expect(keyed.calls.at(-1)!.body).toEqual({ tracked: ['acme'] });
});

test('inbox list --source filters by where the comment came from; an unknown source is a usage mistake', async () => {
  const f = fake({ 'GET /api/candidates?status=pending&source=linear': () => ({ json: [] }) });
  expect(await run(['inbox', 'list', '--source', 'linear'], f.io)).toBe(0);
  expect(f.text()).toMatch(/no pending items from linear/);
  const bad = fake({});
  expect(await run(['inbox', 'list', '--source', 'slack'], bad.io)).toBe(2);
  expect(bad.err.join('\n')).toMatch(/claude, codex, github, linear/);
  expect(bad.calls).toEqual([]);
});

test('lessons to-fact converts a lesson into a project fact (default convention); --kind and --relevance choose', async () => {
  const fact = { id: 'fact:1', kind: 'convention', path: '.', statement: 'Orders are read from the source table', origin: 'you' };
  const f = fake({ 'POST /api/lessons/l1/to-fact': () => ({ status: 201, json: fact }) });
  expect(await run(['lessons', 'to-fact', 'l1'], f.io)).toBe(0);
  expect(f.calls[0]).toMatchObject({ method: 'POST', body: {} });
  expect(f.text()).toMatch(/l1 converted to a convention fact fact:1 \(\.\); the lesson is rejected/);
  const g = fake({ 'POST /api/lessons/l1/to-fact': (b) => ({ status: 201, json: { ...fact, ...(b as object) } }) });
  await run(['lessons', 'to-fact', 'l1', '--kind', 'gotcha', '--relevance', '0.3'], g.io);
  expect(g.calls[0].body).toEqual({ kind: 'gotcha', relevance: 0.3 });
  expect(await run(['lessons', 'to-fact'], fake({}).io)).toBe(2);
  expect(await run(['lessons', 'to-fact', 'l1', '--relevance', '2'], fake({}).io)).toBe(2);
});

test('scripts/fg setup runs ./scripts/setup.sh with its arguments, without Node or the API', async () => {
  const { execFileSync } = await import('node:child_process');
  const { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const repo = mkdtempSync(join(tmpdir(), 'fgsetup-'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(join(root, 'scripts', 'fg'), join(repo, 'scripts', 'fg'));
  writeFileSync(join(repo, 'scripts', 'setup.sh'), '#!/bin/sh\necho "setup ran: $*"\n');
  chmodSync(join(repo, 'scripts', 'setup.sh'), 0o755);
  const out = execFileSync('bash', [join(repo, 'scripts', 'fg'), 'setup', '--yes', '--projects', '/tmp/x'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  expect(out).toBe('setup ran: --yes --projects /tmp/x\n');
});

test('scripts/fg doctor runs ./scripts/doctor.sh with its arguments, without Node or the API', async () => {
  const { execFileSync } = await import('node:child_process');
  const { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const repo = mkdtempSync(join(tmpdir(), 'fgdoctor-'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(join(root, 'scripts', 'fg'), join(repo, 'scripts', 'fg'));
  writeFileSync(join(repo, 'scripts', 'doctor.sh'), '#!/bin/sh\necho "doctor ran: $*"\n');
  chmodSync(join(repo, 'scripts', 'doctor.sh'), 0o755);
  const out = execFileSync('bash', [join(repo, 'scripts', 'fg'), 'doctor', '--help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  expect(out).toBe('doctor ran: --help\n');
});

test('facts list --q prints the search hits (the API answers fact and score pairs), with their score', async () => {
  const hits = [{ fact: { id: 'f1', kind: 'convention', path: 'src/a.ts', statement: 'Every query is scoped by orgId', relevance: 0.9, relevanceBy: 'model' }, score: 0.82 }];
  const f = fake({ 'GET /api/projects/acme/facts?q=tenant+scoping': () => ({ json: hits }) });
  expect(await run(['facts', 'list', '--project', 'acme', '--q', 'tenant scoping'], f.io)).toBe(0);
  expect(f.text()).toMatch(/f1\s+convention\s+0\.90 model\s+0\.82\s+src\/a\.ts\s+Every query is scoped/);
  const j = fake({ 'GET /api/projects/acme/facts?q=tenant': () => ({ json: hits }) });
  await run(['facts', 'list', '--project', 'acme', '--q', 'tenant', '--json'], j.io);
  expect(JSON.parse(j.text())).toEqual([{ ...hits[0].fact, score: 0.82 }]);
});

test('scan --wait says how far each job has got, on stderr, at least every 30 seconds', async () => {
  let polls = 0;
  const f = fake({
    'POST /api/projects/scan': () => ({ status: 202, json: { results: [{ key: 'acme', queued: true, job: { id: 'scan:1', status: 'queued' } }] } }),
    // Running for 14 polls (70 s at 5 s each) with the same progress, then done.
    'GET /api/scans/scan%3A1': () => (++polls < 15
      ? { json: { id: 'scan:1', projectKey: 'acme', status: 'running', factsAdded: 12, shards: { total: 7, done: 3, rescanned: 3, failed: 0 } } }
      : { json: { id: 'scan:1', projectKey: 'acme', status: 'done', filesScanned: 40, factsAdded: 31 } }),
  });
  expect(await run(['scan', '--key', 'acme', '--wait'], f.io)).toBe(0);
  const progress = f.err.filter((l) => l.startsWith('acme'));
  // The first change at once, then a reminder every 30 s while nothing moves: never silent for longer.
  expect(progress.length).toBeGreaterThanOrEqual(3);
  expect(progress[0]).toMatch(/acme: running, shard 3 of 7, 12 facts so far/);
  expect(progress.at(-1)).toMatch(/\(1m\d\ds\)/);
  expect(f.text()).toMatch(/acme\s+done: 40 files, 31 facts/);
});

test('status --watch prints only the lines that changed since the last print', async () => {
  const stages = ['ingest', 'ingest', 'classify'];
  const f = fake({
    'GET /api/status': () => ({ json: { version: 'x', workerHealthy: true, stage: { name: stages.shift() ?? 'classify', startedAt: '2026-10-24T10:00:00Z', current: null } } }),
    'GET /api/pipeline': () => pipeline(),
  });
  let ticks = 0;
  f.io.sleep = async () => { if (++ticks === 3) throw new Error('stop'); };
  await expect(run(['status', '--watch', '--interval', '1'], f.io)).rejects.toThrow('stop');
  const t = f.text();
  // The whole status once, nothing for the poll that found the same, then only the stage line.
  expect(t.match(/^version/gm)).toHaveLength(1);
  expect(t.match(/^stage/gm)).toHaveLength(2);
  expect(t.match(/^pipeline/gm)).toHaveLength(1);
});

test('with --json a failure is JSON on stdout too: { error }, and the exit code says what kind', async () => {
  const f = fake({ 'POST /api/projects/scan': () => ({ status: 403, json: { error: 'the operator token may not scan (scan)' } }) });
  expect(await run(['scan', '--key', 'acme', '--json'], f.io)).toBe(1);
  expect(JSON.parse(f.text())).toEqual({ error: expect.stringContaining('may not scan'), status: 403 });
  const u = fake({});
  expect(await run(['scan', '--json'], u.io)).toBe(2);
  expect(JSON.parse(u.text())).toEqual({ error: expect.stringContaining('fg scan needs --all') });
  const p = fake({});
  expect(await run(['scan', '--bogus', '--json'], p.io)).toBe(2);
  expect(JSON.parse(p.text()).error).toMatch(/unknown option --bogus/);
});

test('a usage mistake is one line and where to read more, not the whole help; fg help <verb> prints that verb', async () => {
  const f = fake({});
  expect(await run(['scan'], f.io)).toBe(2);
  expect(f.err).toEqual(['fg: fg scan needs --all or --key k1,k2 (see fg help scan)']);
  const h = fake({});
  expect(await run(['help', 'scan'], h.io)).toBe(0);
  expect(h.text()).toMatch(/^\s*fg scan --all/m);
  expect(h.text()).not.toMatch(/fg inbox/);
  expect(h.text()).toMatch(/--wait/);
  const unknown = fake({});
  expect(await run(['frobnicate'], unknown.io)).toBe(2);
  expect(unknown.err).toEqual(['fg: unknown command: frobnicate (see fg help)']);
});

test('status --until idle does not wait for the GitHub and Linear sync: nothing queued while it runs is idle', async () => {
  const f = fake({ 'GET /api/status': () => ({ json: { ...idle, stage: { name: 'sync', startedAt: '2026-10-25T03:50:00Z', current: null } } }), 'GET /api/pipeline': () => pipeline() });
  expect(await run(['status', '--until', 'idle', '--timeout', '60'], f.io)).toBe(0);
  expect(f.text()).toMatch(/idle.*syncing GitHub and Linear/);
  // Work still queued during the sync is not idle.
  const busy = fake({ 'GET /api/status': () => ({ json: { ...idle, stage: { name: 'sync', startedAt: 't', current: null } } }), 'GET /api/pipeline': () => pipeline({ postmortems: { queued: 2 } }) });
  expect(await run(['status', '--until', 'idle', '--timeout', '6', '--interval', '5'], busy.io)).toBe(1);
});

// ── Runs: a tester labels what it does, sandboxes it, and cleans up after it ──

const plan = (o: object = {}) => ({
  run: 'run-1', dryRun: true, sandbox: true, entries: 4,
  remove: { feedback: 2, lesson: 1, miss: 1, predone_check: 0, fact: 0, doc: 1, link: 0, chat: 0 },
  kept: [{ kind: 'feedback', id: 'manual:b', why: 'you touched it outside the run (approved lesson "B", t)' }],
  changed: [{ kind: 'feedback_decided', subject: 'confirmed: "x"', targets: ['c-owner'], ts: 't' }],
  ...o,
});

test('--run and --sandbox (or FG_RUN and FG_SANDBOX) label every request fg makes', async () => {
  const f = fake({ 'GET /api/pipeline': () => pipeline() });
  expect(await run(['pipeline', '--run', 'run-1', '--sandbox'], f.io)).toBe(0);
  expect(f.calls[0].headers).toMatchObject({ 'x-fg-run': 'run-1', 'x-fg-sandbox': '1' });
  const e = fake({ 'GET /api/pipeline': () => pipeline() }, { FG_OPERATOR_TOKEN: OP, FG_RUN: 'run-2', FG_SANDBOX: '1' });
  expect(await run(['pipeline'], e.io)).toBe(0);
  expect(e.calls[0].headers).toMatchObject({ 'x-fg-run': 'run-2', 'x-fg-sandbox': '1' });
  const none = fake({ 'GET /api/pipeline': () => pipeline() });
  await run(['pipeline'], none.io);
  expect(none.calls[0].headers['x-fg-run']).toBeUndefined();
  expect(await run(['pipeline', '--sandbox'], fake({}).io)).toBe(2);
});

test('fg cleanup --run: a dry run by default (counts per kind, what stays and why, what it changed that is not its own); --apply removes', async () => {
  const f = fake({ 'DELETE /api/runs/run-1': (b) => ({ json: (b as { dryRun: boolean }).dryRun ? plan() : plan({ dryRun: false, removed: plan().remove }) }) });
  expect(await run(['cleanup', '--run', 'run-1'], f.io)).toBe(0);
  expect(f.calls[0]).toMatchObject({ method: 'DELETE', body: { dryRun: true } });
  expect(f.text()).toMatch(/dry run/i);
  expect(f.text()).toMatch(/feedback\s+2/);
  expect(f.text()).toMatch(/manual:b.*approved lesson "B"/);
  expect(f.text()).toMatch(/c-owner/);
  expect(f.text()).toMatch(/--apply/);
  const g = fake({ 'DELETE /api/runs/run-1': () => ({ json: plan({ dryRun: false, removed: plan().remove }) }) });
  expect(await run(['cleanup', '--run', 'run-1', '--apply'], g.io)).toBe(0);
  expect(g.calls[0].body).toEqual({ dryRun: false });
  expect(g.text()).toMatch(/removed/i);
  expect(await run(['cleanup', '--run', 'run-1', '--dry-run'], fake({ 'DELETE /api/runs/run-1': () => ({ json: plan() }) }).io)).toBe(0);
  expect(await run(['cleanup'], fake({}).io)).toBe(2);
  expect(await run(['cleanup', '--run', 'run-1', '--apply', '--dry-run'], fake({}).io)).toBe(2);
});

test('fg cleanup, activity and evidence never label their requests with a run: --run names what to clean or list, and FG_RUN is not sent', async () => {
  const env = { FG_OPERATOR_TOKEN: OP, FG_RUN: 'run-2', FG_SANDBOX: '1' };
  const f = fake({ 'DELETE /api/runs/run-1': () => ({ json: plan() }) }, env);
  expect(await run(['cleanup', '--run', 'run-1', '--sandbox'], f.io)).toBe(0);
  const g = fake({ 'GET /api/activity': () => ({ json: [] }) }, env);
  expect(await run(['activity', '--run', 'run-1'], g.io)).toBe(0);
  const h = fake({ 'GET /api/sessions/s1/evidence': () => ({ json: { session: { id: 's1', projectKey: 'demo', source: 'claude', state: 'idle' }, turns: { count: 0, classified: 0, waiting: 0, givenUp: 0 }, flags: [], inbox: [], served: [] } }) }, env);
  expect(await run(['evidence', 's1'], h.io)).toBe(0);
  for (const c of [...f.calls, ...g.calls, ...h.calls]) {
    expect(c.headers['x-fg-run']).toBeUndefined();
    expect(c.headers['x-fg-sandbox']).toBeUndefined();
  }
});

test('fg activity --run lists one run; fg evidence <session> shows what the tool saw and decided', async () => {
  const f = fake({ 'GET /api/activity': () => ({ json: [{ ts: '2026-10-25T10:00:00Z', actor: 'agent (MCP)', kind: 'context_served', projectKey: 'demo', subject: 'context', run: 'run-1' }] }) });
  expect(await run(['activity', '--run', 'run-1'], f.io)).toBe(0);
  expect(new URL(f.calls[0].url).searchParams.get('run')).toBe('run-1');
  expect(f.text()).toMatch(/run-1/);
  const evidence = {
    session: { id: 's1', projectKey: 'demo', source: 'claude', state: 'idle' },
    turns: { count: 4, first: '2026-10-25T09:00:00Z', last: '2026-10-25T09:03:00Z', classified: 2, waiting: 0, givenUp: 1, prunedText: 0 },
    files: { edited: ['src/total.ts'], readOnly: [] },
    flags: [{ index: 1, label: 'neutral', confidence: 0.8, flagged: false, skipped: ['git-instruction'], why: 'an instruction' }, { index: 2, label: 'pushback', confidence: 0.9, flagged: true, skipped: [], why: 'keep cents', candidateId: 's1-t2' }],
    inbox: [{ id: 's1-t2', status: 'confirmed', decidedBy: 'you', lesson: { id: 'lesson:s1-t2', status: 'proposed' }, miss: null }],
    served: [{ ts: 't', kind: 'context_served', subject: 'context for "x"' }],
  };
  const e = fake({ 'GET /api/sessions/s1/evidence': () => ({ json: evidence }) });
  expect(await run(['evidence', 's1'], e.io)).toBe(0);
  expect(e.text()).toMatch(/4 turns/);
  expect(e.text()).toMatch(/git-instruction/);
  expect(e.text()).toMatch(/s1-t2.*confirmed.*lesson:s1-t2/);
  expect(await run(['evidence'], fake({}).io)).toBe(2);
});

const quality = (days: number, asWritten: number, edited: number, rejected: number) => ({ days, asWritten, edited, rejected, decided: asWritten + edited + rejected });

test('lessons quality: of the decided lessons, approved as written / after an edit / rejected, in all and by project', async () => {
  const f = fake({
    'GET /api/lessons/quality': () => ({ json: { windows: [quality(30, 21, 60, 62), quality(90, 30, 70, 80)], projects: { acme: [quality(30, 21, 60, 62), quality(90, 30, 70, 80)] } } }),
    'GET /api/lessons/quality?project=acme': () => ({ json: { windows: [quality(30, 1, 0, 0), quality(90, 1, 0, 0)], projects: {} } }),
  });
  expect(await run(['lessons', 'quality'], f.io)).toBe(0);
  const t = f.text();
  expect(t).toMatch(/PROJECT\s+DAYS\s+DECIDED\s+AS WRITTEN\s+AFTER EDIT\s+REJECTED/);
  expect(t).toMatch(/all\s+30\s+143\s+21 \(15%\)\s+60 \(42%\)\s+62 \(43%\)/);
  expect(t).toMatch(/acme\s+90\s+180\s+30 \(17%\)/);
  expect(await run(['lessons', 'quality', '--project', 'acme'], f.io)).toBe(0);
  expect(f.calls.at(-1)?.url).toMatch(/\?project=acme$/);
});

test('status says how the lessons were judged in the last 30 days, when the server can tell', async () => {
  const f = fake({ 'GET /api/status': () => ({ json: idle }), 'GET /api/pipeline': () => pipeline({ lessons: { proposed: 2, approved: 0, quality: [quality(30, 21, 60, 62), quality(90, 30, 70, 80)] } }) });
  expect(await run(['status'], f.io)).toBe(0);
  expect(f.text()).toMatch(/lessons\s+last 30 d: 143 decided: 21 approved as written \(15%\), 60 after an edit \(42%\), 62 rejected \(43%\)/);
  const none = fake({ 'GET /api/status': () => ({ json: idle }), 'GET /api/pipeline': () => pipeline() });
  expect(await run(['status'], none.io)).toBe(0);
  expect(none.text()).not.toMatch(/approved as written/);
});
