import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { run, table, type CliIO } from './cli.ts';

/** What a route answers: JSON (200), a Response as is, or a function of the request body and URL. */
type Answer = unknown | ((body: any, url: URL) => unknown);
type Call = { method: string; path: string; headers: Record<string, string>; body: any };

/** fg against a fake API answering by "METHOD /path" (or "METHOD /path?query"); unknown routes are 404s. */
function fg(routes: Record<string, Answer>, env: Record<string, string> = {}, extra: Partial<CliIO> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    env, out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {},
    fetch: (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path: `${u.pathname}${u.search}`, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
      const key = [`${method} ${u.pathname}${u.search}`, `${method} ${u.pathname}`].find((k) => k in routes);
      if (!key) return Response.json({ error: `no route ${method} ${u.pathname}` }, { status: 404 });
      const r = routes[key];
      const v = typeof r === 'function' ? await r(body, u) : r;
      return v instanceof Response ? v : Response.json(v);
    }) as typeof fetch,
    ...extra,
  };
  const cmd = (...argv: string[]) => run(argv, io);
  return { io, calls, out, err, cmd, text: () => out.join('\n'), errors: () => err.join('\n') };
}

/** The API's cleanup plan for run r1 (CleanupPlan): nothing to remove unless `o` says so. */
const plan = (o: object = {}) => ({ run: 'r1', dryRun: true, sandbox: false, remove: { lesson: 0 }, kept: [], changed: [], entries: 0, ...o });

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// ── Arguments and HTTP ─────────────────────────────────────────────────

test('-h, --help after a command and fg help <command> print that command\'s usage', async () => {
  for (const argv of [['scan', '-h'], ['scan', '--help'], ['help', 'scan']]) {
    const f = fg({});
    expect(await f.cmd(...argv)).toBe(0);
    expect(f.text()).toMatch(/^Usage:\n {2}fg scan --all/);
    expect(f.text()).not.toMatch(/fg inbox/);
  }
});

test('--owner is only for cleanup, and needs FG_OWNER_TOKEN', async () => {
  const f = fg({});
  expect(await f.cmd('status', '--owner')).toBe(2);
  expect(f.errors()).toBe('fg: --owner is only supported for cleanup (see fg help status)');
  const g = fg({});
  expect(await g.cmd('cleanup', '--run', 'r1', '--owner')).toBe(2);
  expect(g.errors()).toMatch(/--owner requires FG_OWNER_TOKEN/);
  const h = fg({ 'DELETE /api/runs/r1': plan() }, { FG_OWNER_TOKEN: ' owner-secret ' });
  expect(await h.cmd('cleanup', '--run', 'r1', '--owner')).toBe(0);
  expect(h.calls[0].headers).toMatchObject({ authorization: 'Bearer owner-secret', 'x-fg-owner-cleanup': 'true' });
});

test('a token is not sent to a URL fg cannot read, nor to the default https port of a local host', async () => {
  const bad = fg({}, { API_TOKEN: 't' });
  expect(await bad.cmd('status', '--url', 'not a url')).toBe(2);
  expect(bad.errors()).toMatch(/not a URL: not a url/);
  const https = fg({}, { API_TOKEN: 't' });
  expect(await https.cmd('status', '--url', 'https://localhost')).toBe(2);
  expect(https.errors()).toMatch(/to local port 443;/);
  expect(https.calls).toEqual([]);
});

test('an API error is shown as its error field, its whole JSON, its text, or the HTTP status text', async () => {
  const cases: [Response, RegExp][] = [
    [Response.json({ error: { code: 'x' } }, { status: 400 }), /GET \/api\/pipeline: 400 \{"code":"x"\}$/],
    [Response.json({ problem: 'y' }, { status: 400 }), /400 \{"problem":"y"\}$/],
    [new Response('upstream exploded', { status: 502 }), /502 upstream exploded$/],
    [new Response(null, { status: 503, statusText: 'Service Unavailable' }), /503 Service Unavailable$/],
  ];
  for (const [res, message] of cases) {
    const f = fg({ 'GET /api/pipeline': () => res.clone() });
    expect(await f.cmd('pipeline')).toBe(1);
    expect(f.errors()).toMatch(message);
  }
});

test('a 401 says which tokens to check unless the API already named one', async () => {
  const plain = fg({ 'GET /api/pipeline': Response.json({ error: 'unauthorized' }, { status: 401 }) });
  expect(await plain.cmd('pipeline')).toBe(1);
  expect(plain.errors()).toMatch(/401 unauthorized \(check FG_OPERATOR_TOKEN or API_TOKEN against this install\)$/);
  const named = fg({ 'GET /api/pipeline': Response.json({ error: 'API_TOKEN is wrong' }, { status: 401 }) });
  await named.cmd('pipeline');
  expect(named.errors()).toMatch(/401 API_TOKEN is wrong$/);
});

test('a run that belongs to another caller names the credential fg sent and how to send the other one', async () => {
  const refuse = (message: string, status = 409) => ({ 'POST /api/sessions/s1/run': () => Response.json({ error: message }, { status }) });
  // The API's own message says what was sent and to clear FG_OPERATOR_TOKEN: fg adds the one-command form, with API_TOKEN set.
  const told = fg(refuse('run r belongs to another caller; this request sent FG_OPERATOR_TOKEN: clear FG_OPERATOR_TOKEN'), { FG_OPERATOR_TOKEN: 'o', API_TOKEN: 'a' });
  expect(await told.cmd('sessions', 'register', 's1', '--run', 'r')).toBe(1);
  expect(told.errors()).toMatch(/clear FG_OPERATOR_TOKEN \(for one command: FG_OPERATOR_TOKEN= \.\/scripts\/fg \.\.\.\)$/);
  const toldNoApi = fg(refuse('run r belongs to another caller; this request sent FG_OPERATOR_TOKEN: clear FG_OPERATOR_TOKEN'), { FG_OPERATOR_TOKEN: 'o' });
  await toldNoApi.cmd('sessions', 'register', 's1', '--run', 'r');
  expect(toldNoApi.errors()).toMatch(/clear FG_OPERATOR_TOKEN$/);
  // Otherwise fg says which credential it sent, and that the operator token won over API_TOKEN.
  const both = fg(refuse('run r belongs to another caller', 403), { FG_OPERATOR_TOKEN: 'o', API_TOKEN: 'a' });
  await both.cmd('sessions', 'register', 's1', '--run', 'r');
  expect(both.errors()).toMatch(/\(fg sent FG_OPERATOR_TOKEN, which takes precedence over API_TOKEN: .*FG_OPERATOR_TOKEN= \.\/scripts\/fg \.\.\.\)$/);
  const operator = fg(refuse('run r belongs to another caller'), { FG_OPERATOR_TOKEN: 'o' });
  await operator.cmd('sessions', 'register', 's1', '--run', 'r');
  expect(operator.errors()).toMatch(/belongs to another caller \(fg sent FG_OPERATOR_TOKEN\)$/);
  const api = fg(refuse('run r belongs to another caller'), { API_TOKEN: 'a' });
  await api.cmd('sessions', 'register', 's1', '--run', 'r');
  expect(api.errors()).toMatch(/\(fg sent API_TOKEN\)$/);
  const none = fg(refuse('run r belongs to another caller'));
  await none.cmd('sessions', 'register', 's1', '--run', 'r');
  expect(none.errors()).toMatch(/belongs to another caller$/);
});

test('table: empty cells, long cells cut with an ellipsis, and rows shorter than the head', () => {
  expect(table(['A', 'B', 'C'], [[null, undefined, 'x'], ['a'.repeat(10), 'b']], 5).split('\n')).toEqual(['A      B  C', '          x', 'aaaa…  b']);
});

// ── status ─────────────────────────────────────────────────────────────

test('status names a scan parked on its model and one failed after a day of it', async () => {
  const status = { version: '0.8.3', graph: true, workerHealthy: true, worker: { lastBeat: new Date().toISOString() },
    scans: {
      parked: [{ projectKey: 'side-tool', provider: 'codex-cli', since: '2026-11-12T08:00:00Z', error: 'scan parked on codex-cli: cannot reach the codex runner.' }],
      gaveUp: [{ projectKey: 'tiny-app', at: '2026-11-12T00:00:00Z', error: 'gave up after more than 24 hours parked on codex-cli (since 2026-11-11T00:00:00Z): cannot reach the codex runner.' }],
    } };
  const f = fg({ 'GET /api/status': status, 'GET /api/pipeline': null });
  expect(await f.cmd('status')).toBe(0);
  expect(f.text()).toContain('scan      side-tool parked on codex-cli since 2026-11-12T08:00:00Z: cannot reach the codex runner.');
  expect(f.text()).toContain('scan      tiny-app FAILED: gave up after more than 24 hours parked on codex-cli');
});

const STAGE = { name: 'scan', current: 'alpha', startedAt: '2026-11-10T10:00:00.000Z' };

test('status prints every part of the API status it is given', async () => {
  const now = Date.now();
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  const status = {
    version: '0.7.6', store: 'postgres', graph: true, workerHealthy: false,
    worker: { lastBeat: ago(400), lastCycleAt: '2026-11-10T09:00:00Z', lastCycle: { ingested: 3, ok: true }, lastError: 'boom' },
    ownerSetupRequired: true,
    stage: STAGE, progress: { done: 4, total: null },
    codeMaps: [
      { projectKey: 'a', builtAt: '2026-11-01', ageDays: 9, checkedAt: '2026-11-09', rebuilding: true },
      { projectKey: 'b', builtAt: '2026-11-01', ageDays: 9, checkedAt: '2026-11-01', interrupted: true },
      { projectKey: 'c', builtAt: '2026-11-01', ageDays: 9, checkedAt: '2026-11-01', lastFailureAt: '2026-11-02', lastFailure: 'parse error' },
      { projectKey: 'd', builtAt: '2026-11-01', ageDays: 9, checkedAt: '2026-11-01', lastFailureAt: '2026-11-02' },
      { projectKey: 'e', builtAt: '2026-11-01', ageDays: 9, checkedAt: '2026-11-01' },
      { projectKey: 'f', builtAt: null, ageDays: null, checkedAt: null, interrupted: true },
      { projectKey: 'g', builtAt: null, ageDays: null, checkedAt: null, lastFailureAt: '2026-11-02', lastFailure: 'boom' },
    ],
    selection: { tracked: 2, note: 'two of five' },
    models: {
      classify: { provider: 'ollama:m', ok: true },
      scan: { provider: null, ok: false, reason: null },
      docs: { provider: 'ollama:m', ok: false, since: '2026-11-10T08:00:00Z', reason: 'down' },
      summary: { off: true },
    },
    givenUpTurns: 3,
    connections: { github: { state: 'ok', detail: 'as octo' } },
    cloud: { syncing: { done: 1, total: 3, current: 'alpha', startedAt: '2026-11-10T10:00:00Z' }, lastManual: { at: '2026-11-10T09:00:00Z', ok: false, error: null, sent: null, unchanged: 2, failed: 1 } },
  };
  const pipeline = {
    classify: { backlog: 5, capped: true }, inbox: { pending: 1 }, postmortems: { queued: 2 }, lessons: { proposed: 4 },
    scans: { running: 1, queued: 2, failed: 3, olderScanner: { files: 1, projects: { a: 1 } } },
    queues: {
      scans: { waiting: 12, capped: true, oldestAt: ago(120), running: [{ what: 'alpha', since: ago(30), shards: { done: 4, total: 4 } }],
        projects: Array.from({ length: 12 }, (_, i) => ({ project: `p${i}`, status: 'queued', since: ago(60), shards: i === 0 ? { done: 1, total: 1 } : null })) },
      classify: { waiting: 3, oldestAt: null, running: [{ what: 'turn t1', since: ago(5) }] },
      postmortems: null,
      custom: { waiting: 0 },
    },
  };
  const f = fg({ 'GET /api/status': status, 'GET /api/pipeline': pipeline });
  expect(await f.cmd('status')).toBe(0);
  const t = f.text();
  for (const line of [
    'version   0.7.6 (postgres)',
    'store     ok',
    'worker    stale: no heartbeat for 6 min (it beats every 30 s; is it running? ./scripts/doctor.sh), last cycle 2026-11-10T09:00:00Z',
    'owner     SETUP REQUIRED',
    'stage     scan alpha (4 done) since 2026-11-10 10:00:00',
    'code map  a built 2026-11-01 (9d since rebuild), last confirmed current 2026-11-09; rebuilding now',
    'code map  b built 2026-11-01 (9d since rebuild); rebuild was interrupted and will be retried',
    'code map  c built 2026-11-01 (9d since rebuild); last rebuild failed 2026-11-02: parse error',
    'code map  d built 2026-11-01 (9d since rebuild); last rebuild failed 2026-11-02\n',
    'code map  e built 2026-11-01 (9d since rebuild)\n',
    'code map  f never built; rebuild was interrupted and will be retried\n',
    'code map  g never built; last rebuild failed 2026-11-02: boom\n',
    'pipeline  classify 5+ · inbox 1 pending · postmortems 2 · lessons 4 proposed · scans 1 running, 2 queued, 3 failed',
    'queue     scans: 12+ waiting, oldest at least 2 min; running shard 4/4 of alpha for',
    '          p0                   queued 1 min, 1 of 1 shard done',
    '          and 2 more',
    'queue     classify: 3 waiting; running turn t1 for',
    'queue     custom: none waiting',
    'scanner   1 file was read by an older scanner (a 1): press Scan on the Projects page (or fg scan <project>) to refresh it',
    'cycle     ingested=3 ok=true',
    'error     boom',
    'projects  2 selected: two of five',
    'model     classify   ollama:m ok',
    'model     scan       none UNAVAILABLE: ',
    'model     docs       ollama:m UNAVAILABLE since 2026-11-10 08:00:00: down',
    'model     summary    off',
    'given up  3 turns',
    'github    ok: as octo',
    'syncing   1 of 3 projects (alpha) since 2026-11-10 10:00:00',
    'sync now  2026-11-10 09:00:00 FAILED: : sent 0 projects, 2 unchanged, 1 failed',
  ]) expect(`${t}\n`).toContain(line);
  expect(t).not.toMatch(/post-mortems/);
  expect(t).not.toMatch(/undefined|null|NaN/);
});

test('status of an API that reports little: no version, a store that does not answer, no worker and no pipeline', async () => {
  const f = fg({ 'GET /api/status': { graph: false, stage: { name: 'ingest', current: null, startedAt: '2026-11-10T10:00:00Z' }, progress: { done: 1, total: 9 }, selection: { tracked: 0 },
    cloud: { syncing: { done: 0, total: 1, current: null, startedAt: '2026-11-10T10:00:00Z' }, lastManual: { at: '2026-11-10T09:00:00Z', ok: true, sent: { projects: 1 }, unchanged: 0, failed: 0 } } } });
  expect(await f.cmd('status')).toBe(0);
  expect(f.out).toEqual([
    'version   ?', 'store     NOT answering', 'worker    not reported', 'stage     ingest (1 of 9) since 2026-11-10 10:00:00',
    'projects  0 selected',
    'syncing   0 of 1 projects since 2026-11-10 10:00:00', 'sync now  2026-11-10 09:00:00 ok: sent 1 project, 0 unchanged',
  ]);
});

test('status says the worker is ok only while it beats: three missed beats are stale even before /api/status calls it unhealthy', async () => {
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const worker = async (lastBeat: string) => {
    const f = fg({ 'GET /api/status': { version: 'v', graph: true, workerHealthy: true, worker: { lastBeat } }, 'GET /api/pipeline': {} });
    await f.cmd('status');
    return f.out.find((l) => l.startsWith('worker'));
  };
  expect(await worker(at(20))).toBe('worker    ok');
  expect(await worker(at(150))).toBe('worker    stale: no heartbeat for 2 min (it beats every 30 s; is it running? ./scripts/doctor.sh)');
});

test('status: files read by an older scanner are named per project, and FG_DATABASE_MEMORY that is not JSON is ignored', async () => {
  const f = fg({ 'GET /api/status': { version: 'v', graph: true, workerHealthy: true, worker: {} },
    'GET /api/pipeline': { scans: { running: 0, queued: 0, olderScanner: { files: 3, projects: { a: 2, b: 1 } } } } }, { FG_DATABASE_MEMORY: '{not json' });
  expect(await f.cmd('status')).toBe(0);
  expect(f.text()).toContain('scanner   3 files were read by an older scanner (a 2, b 1): press Scan on the Projects page (or fg scan <project>) to refresh them');
  expect(f.text()).not.toMatch(/neo4j/);
});

test('status --json prints the API status as it came', async () => {
  const f = fg({ 'GET /api/status': { version: 'v' }, 'GET /api/pipeline': {} });
  expect(await f.cmd('status', '--json')).toBe(0);
  expect(JSON.parse(f.text())).toEqual({ version: 'v' });
});

test('status --until: --json when reached; a timeout says there was no stage and no pipeline; a bad --timeout is a usage error', async () => {
  const idle = fg({ 'GET /api/status': { stage: { name: 'waiting', startedAt: '2026-11-10T10:00:00Z' } }, 'GET /api/pipeline': { classify: { backlog: 0 } } });
  expect(await idle.cmd('status', '--until', 'idle', '--json')).toBe(0);
  expect(JSON.parse(idle.text())).toMatchObject({ stage: { name: 'waiting' }, pipeline: { classify: { backlog: 0 } } });
  const stuck = fg({ 'GET /api/status': {}, 'GET /api/pipeline': Response.json({ error: 'old' }, { status: 404 }) });
  expect(await stuck.cmd('status', '--until', 'scan', '--timeout', '1', '--interval', '1')).toBe(1);
  expect(stuck.errors()).toBe('fg: still not at stage scan after 1 s: no stage reported');
  for (const t of ['0', 'soon']) {
    const bad = fg({});
    expect(await bad.cmd('status', '--until', 'idle', '--timeout', t)).toBe(2);
    expect(bad.errors()).toMatch(/--timeout must be a number of seconds above 0/);
  }
});

test('status --until idle is not reached while a Sync now runs or work is queued, and counts what the pipeline leaves out as none', async () => {
  const states = [
    { s: { stage: { name: 'waiting' }, cloud: { syncing: { done: 0, total: 1 } } }, p: {} },
    { s: { stage: { name: 'waiting' } }, p: { scans: { running: 1 } } },
    { s: { stage: { name: 'waiting' } }, p: { scans: { queued: 1 } } },
    { s: { stage: { name: 'waiting' } }, p: { postmortems: { queued: 1 } } },
    { s: { stage: { name: 'waiting', startedAt: '2026-11-10T10:00:00Z' } }, p: {} },
  ];
  let i = 0;
  const f = fg({ 'GET /api/status': () => states[i].s, 'GET /api/pipeline': () => states[i++].p });
  expect(await f.cmd('status', '--until', 'idle')).toBe(0);
  expect(i).toBe(5);
  expect(f.text()).toBe('idle since 2026-11-10 10:00:00');
});

test('status --watch --json prints the whole status again only when it changed', async () => {
  const seen = [{ v: 1 }, { v: 1 }, { v: 2 }];
  let i = 0;
  let slept = 0;
  const f = fg({ 'GET /api/status': () => seen[Math.min(i++, 2)], 'GET /api/pipeline': {} }, {}, {
    sleep: async () => { if (++slept === 3) throw new Error('stop'); },
  });
  await expect(f.cmd('status', '--watch', '--json')).rejects.toThrow('stop');
  expect(f.out.map((l) => JSON.parse(l))).toEqual([{ v: 1 }, { v: 2 }]);
});

/** A text/event-stream body that sends `chunks` and then ends, or fails when `fail` is set. */
function sse(chunks: string[], fail = false) {
  const left = [...chunks];
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      const next = left.shift();
      if (next !== undefined) c.enqueue(new TextEncoder().encode(next));
      else if (fail) c.error(new Error('connection reset'));
      else c.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('status --watch prints Activity from the event stream, as JSON with --json, and falls back to polling when the stream drops', async () => {
  const activity = (projectKey: string | null) => `event: activity\ndata: ${JSON.stringify({ kind: 'scan_finished', subject: 'done', projectKey })}\n\n`;
  const stop = async () => { throw new Error('stop'); };
  const plain = fg({ 'GET /api/events': () => sse([activity('alpha'), activity(null)], true), 'GET /api/status': { version: 'v' }, 'GET /api/pipeline': {} }, {}, { sleep: stop });
  await expect(plain.cmd('status', '--watch')).rejects.toThrow('stop');
  expect(plain.out).toContain('activity  scan_finished [alpha]: done');
  expect(plain.out).toContain('activity  scan_finished: done');
  const json = fg({ 'GET /api/events': () => sse([activity('alpha')]), 'GET /api/status': { version: 'v' }, 'GET /api/pipeline': {} }, {}, { sleep: stop });
  await expect(json.cmd('status', '--watch', '--json')).rejects.toThrow('stop');
  expect(json.out).toContain(JSON.stringify({ event: 'activity', data: { kind: 'scan_finished', subject: 'done', projectKey: 'alpha' } }));
});

// ── pipeline and projects ──────────────────────────────────────────────

test('pipeline: unknown for every stage an API leaves out', async () => {
  const f = fg({ 'GET /api/pipeline': { stage: { name: 'waiting', current: null, startedAt: '2026-11-10T10:00:00Z' }, sessions: null } });
  expect(await f.cmd('pipeline')).toBe(0);
  expect(f.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual([
    'STAGE COUNT', 'worker waiting since 2026-11-10 10:00:00', 'sessions unknown', 'classify unknown', 'inbox unknown', 'postmortems unknown', 'lessons unknown', 'scans unknown',
  ]);
  const full = fg({ 'GET /api/pipeline': { stage: { name: 'scan', current: 'alpha', startedAt: '2026-11-10T10:00:00Z' }, sessions: 4, classify: { backlog: 3, capped: true } } });
  await full.cmd('pipeline');
  expect(full.text()).toMatch(/worker\s+scan alpha since/);
  expect(full.text()).toMatch(/classify\s+3\+ waiting/);
});

test('projects list joins Settings with the shown projects: their sessions, scans, links and notes', async () => {
  const cand = (key: string, o: object = {}) => ({ key, path: `/c/${key}`, exists: true, tracked: true, excluded: false, aliasOf: null, claudeSessions: 1, codexSessions: 0, ...o });
  const f = fg({
    'GET /api/settings/projects': { tracked: ['a'], candidates: [cand('a'), cand('gone', { exists: false, tracked: false }), cand('ex', { excluded: true }), cand('clone', { aliasOf: 'a' }), cand('idle', { claudeSessions: 0 })] },
    'GET /api/projects': [
      { key: 'a', pinned: true, sessions: 4, feedback: 2, lessons: 1, facts: 9, lastScan: { status: 'done', finishedAt: '2026-11-10T10:00:00Z' } },
      { key: 'shown-only', repoPath: '/r/shown-only', lastScan: { status: 'queued', requestedAt: '2026-11-10T09:00:00Z' } },
      { key: 'old', lastScan: { status: 'running', startedAt: '2026-11-10T08:00:00Z' } },
      { key: 'never', lastScan: { status: 'failed' } },
    ],
    'GET /api/projects/a/links': [{ status: 'confirmed' }, { status: 'suggested' }, { status: 'other' }],
    'GET /api/projects/shown-only/links': [],
    'GET /api/projects/old/links': Response.json({ error: 'gone' }, { status: 500 }),
    'GET /api/projects/never/links': [],
  });
  expect(await f.cmd('projects')).toBe(0);
  const rows = f.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '));
  expect(rows).toEqual([
    'KEY SELECTED PINNED SESSIONS FEEDBACK LESSONS FACTS LAST SCAN LINKS NOTE PATH',
    'a yes yes 4 2 1 9 done 2026-11-10 10:00 1 confirmed, 1 suggested, 1 other /c/a',
    'gone no 1 folder gone /c/gone',
    'ex yes 1 excluded (EXCLUDE_PROJECTS) /c/ex',
    'clone yes 1 clone of a /c/clone',
    'idle yes 0 /c/idle',
    'shown-only yes 0 queued 2026-11-10 09:00 /r/shown-only',
    'old yes 0 running 2026-11-10 08:00',
    'never yes 0 failed',
  ]);
  const sessions = fg({ 'GET /api/settings/projects': { tracked: [], candidates: [cand('a'), cand('idle', { claudeSessions: 0 })] }, 'GET /api/projects': [{ key: 'b', sessions: 2 }, { key: 'c' }], 'GET /api/projects/b/links': [], 'GET /api/projects/c/links': [] });
  await sessions.cmd('projects', 'list', '--with-sessions', '--json');
  expect(JSON.parse(sessions.text()).map((r: { key: string }) => r.key)).toEqual(['a', 'b']);
});

test('projects: an unknown verb, unselect without --key, and select --json', async () => {
  const f = fg({});
  expect(await f.cmd('projects', 'frob')).toBe(2);
  expect(f.errors()).toMatch(/unknown projects command: frob \(see fg help projects\)/);
  const g = fg({});
  expect(await g.cmd('projects', 'unselect')).toBe(2);
  expect(g.errors()).toMatch(/needs --key k1,k2/);
  const h = fg({ 'GET /api/settings/projects': { tracked: [], candidates: [] }, 'PUT /api/settings/projects': (b: { tracked: string[] }) => ({ tracked: b.tracked, candidates: [] }) });
  expect(await h.cmd('projects', 'select', '--key', 'a', '--json')).toBe(0);
  expect(JSON.parse(h.text())).toEqual({ tracked: ['a'] });
});

// ── scan ───────────────────────────────────────────────────────────────

test('scan: a queued result without a job id still prints', async () => {
  const f = fg({ 'POST /api/projects/scan': { results: [{ key: 'a', queued: true }] } });
  expect(await f.cmd('scan', '--key', 'a')).toBe(0);
  expect(f.text()).toMatch(/a\s+queued \(\)/);
});

test('scan --wait follows each job: queue position, shards, facts so far, parked; then the result per job', async () => {
  const views = {
    j1: [
      { id: 'j1', projectKey: 'a', status: 'queued', queuePosition: 1 },
      { id: 'j1', projectKey: 'a', status: 'running', shards: { total: 4, rescanned: 1, failed: 0 } },
      { id: 'j1', projectKey: 'a', status: 'running', factsAdded: 3, shards: { total: 4, done: 2, rescanned: 1, failed: 0 } },
      { id: 'j1', projectKey: 'a', status: 'done', factsAdded: 3 },
    ],
    j2: [
      { id: 'j2', projectKey: 'b', status: 'queued', queuePosition: 2, blocked: true, warning: 'runner not ready' },
      { id: 'j2', projectKey: 'b', status: 'queued', queuePosition: 3 },
      { id: 'j2', projectKey: 'b', status: 'queued', queuePosition: 11 },
      { id: 'j2', projectKey: 'b', status: 'failed' },
    ],
    j3: [{ id: 'j3', projectKey: 'c', status: 'queued', queuePosition: 4 }, { id: 'j3', projectKey: 'c', status: 'queued', queuePosition: 22 }, { id: 'j3', projectKey: 'c', status: 'queued', queuePosition: 112 }, { id: 'j3', projectKey: 'c', status: 'queued', queuePosition: 23 }],
    j4: [{ id: 'j4', projectKey: 'd', status: 'done', filesScanned: 1, factsAdded: 1 }],
    j5: [{ id: 'j5', projectKey: 'e', status: 'running' }],
    j6: [{ id: 'j6', projectKey: 'f', status: 'done', filesScanned: 2 }],
  } as Record<string, object[]>;
  const polled: Record<string, number> = {};
  const f = fg({
    'POST /api/projects/scan': { results: Object.keys(views).map((id, i) => ({ key: 'abcdef'[i], queued: true, job: { id, status: 'queued' } })) },
    ...Object.fromEntries(Object.keys(views).map((id) => [`GET /api/scans/${id}`, () => views[id][Math.min(polled[id] = (polled[id] ?? -1) + 1, views[id].length - 1)]])),
  });
  expect(await f.cmd('scan', '--all', '--wait', '--timeout', '15', '--interval', '5')).toBe(1);
  expect(f.err).toEqual(expect.arrayContaining([
    'a: queued (1st in the queue) (0m00s)', 'b: parked (2nd in the queue) — runner not ready (0m00s)', 'c: queued (4th in the queue) (0m00s)',
    'a: running, shard 1 of 4, 0 facts so far (0m05s)', 'b: queued (3rd in the queue) (0m05s)', 'c: queued (22nd in the queue) (0m05s)',
    'a: running, shard 2 of 4, 3 facts so far (0m10s)', 'b: queued (11th in the queue) (0m10s)', 'c: queued (112th in the queue) (0m10s)',
  ]));
  const rows = f.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '));
  expect(rows).toEqual(['PROJECT RESULT', 'a done: 0 files, 3 facts (nothing changed since the last scan)', 'b failed: no reason given', 'c still queued (23rd in the queue)', 'd done: 1 file, 1 fact', 'e still running', 'f done: 2 files, 0 facts']);
});

test('scan --wait --json prints the jobs and the refused projects', async () => {
  const f = fg({ 'POST /api/projects/scan': { results: [{ key: 'a', queued: true, job: { id: 'j1', status: 'queued' } }, { key: 'b', queued: false, error: 'not selected' }] }, 'GET /api/scans/j1': { id: 'j1', projectKey: 'a', status: 'done', filesScanned: 2, factsAdded: 0 } });
  expect(await f.cmd('scan', '--all', '--wait', '--json')).toBe(1);
  expect(JSON.parse(f.text())).toEqual({ jobs: [{ id: 'j1', projectKey: 'a', status: 'done', filesScanned: 2, factsAdded: 0 }], refused: [{ key: 'b', queued: false, error: 'not selected' }] });
});

// ── inbox and lessons ──────────────────────────────────────────────────

test('inbox: an empty list says what was filtered; show prints every part of an item; --json prints it as it came', async () => {
  const empty = fg({ 'GET /api/candidates': [] });
  await empty.cmd('inbox', '--status', 'pending', '--source', 'github');
  expect(empty.text()).toBe('no pending items from github');
  const bare = fg({ 'GET /api/candidates': [] });
  await bare.cmd('inbox');
  expect(bare.text()).toBe('no items');
  const detail = {
    candidate: { id: 'c1', projectKey: 'a', source: 'github', status: 'confirmed', decidedBy: 'owner', decidedAt: '2026-11-10T10:00:00Z', classification: { label: 'pushback', confidence: 0.9, summary: 's' },
      external: { author: 'octo', authorKind: 'human', url: 'https://x' }, note: 'n', agentReport: { text: 'r' } },
    turn: { text: 'no, wrong' },
    postmortem: { done: false, gaveUp: false, attempts: 2, retryAt: '2026-11-10T11:00:00Z' },
  };
  const f = fg({ 'GET /api/candidates/c1': detail });
  expect(await f.cmd('inbox', 'show', 'c1')).toBe(0);
  const rows = f.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '));
  expect(rows).toEqual(['FIELD VALUE', 'id c1', 'project a', 'source github', 'status confirmed by owner at 2026-11-10 10:00:00', 'label pushback (0.9): s', 'author octo (human)', 'url https://x', 'comment no, wrong', 'note n', 'reported r', 'postmortem attempt 2, next 2026-11-10 11:00:00']);
  const minimal = fg({ 'GET /api/candidates/c2': { candidate: { id: 'c2', projectKey: 'a', source: 'github', status: 'pending', external: {} }, postmortem: { done: false, gaveUp: true } } });
  await minimal.cmd('inbox', 'show', 'c2');
  expect(minimal.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['FIELD VALUE', 'id c2', 'project a', 'source github', 'status pending', 'label ():', 'author', 'url', 'comment', 'postmortem gave up:']);
  const plain = fg({ 'GET /api/candidates/c3': { candidate: { id: 'c3', projectKey: 'a', source: 'claude', status: 'pending' }, postmortem: { done: true } } });
  await plain.cmd('inbox', 'show', 'c3');
  expect(plain.text()).toMatch(/postmortem\s+done/);
  expect(plain.text()).not.toMatch(/author/);
  const retry = fg({ 'GET /api/candidates/c5': { candidate: { id: 'c5', projectKey: 'a', source: 'claude', status: 'pending' }, postmortem: { attempts: 1 } } });
  await retry.cmd('inbox', 'show', 'c5');
  expect(retry.text()).toMatch(/postmortem\s+attempt 1$/);
  const gave = fg({ 'GET /api/candidates/c4': { candidate: { id: 'c4', projectKey: 'a', source: 'claude', status: 'pending' }, postmortem: { gaveUp: true, lastError: 'timeout' } } });
  await gave.cmd('inbox', 'show', 'c4');
  expect(gave.text()).toMatch(/postmortem\s+gave up: timeout/);
  const json = fg({ 'GET /api/candidates/c1': detail });
  await json.cmd('inbox', 'show', 'c1', '--json');
  expect(JSON.parse(json.text())).toEqual(detail);
});

test('inbox: an unknown verb is a usage error; decisions print as JSON with --json', async () => {
  const f = fg({});
  expect(await f.cmd('inbox', 'frob')).toBe(2);
  expect(f.errors()).toMatch(/unknown inbox command: frob/);
  const g = fg({ 'POST /api/candidates/decisions': { results: [{ id: 'c1', ok: true, status: 'confirmed' }] } });
  expect(await g.cmd('inbox', 'confirm', 'c1', '--json')).toBe(0);
  expect(JSON.parse(g.text())).toEqual([{ id: 'c1', ok: true, status: 'confirmed' }]);
});

test('lessons list and show: global lessons, flags, origin and who decided; --json; empty lists say what was filtered', async () => {
  const list = [{ id: 'l1', status: 'approved', projectKey: null, title: 't1', checks: [{ name: 'stale' }, { name: 'dup' }], from: 'pm', decidedBy: 'owner' }, { id: 'l2', status: 'proposed', projectKey: 'a', title: 't2' }];
  const f = fg({ 'GET /api/lessons': list });
  await f.cmd('lessons');
  expect(f.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['ID STATUS PROJECT FROM FLAGS TITLE DECIDED BY', 'l1 approved global pm stale,dup t1 owner', 'l2 proposed a t2']);
  const json = fg({ 'GET /api/lessons': list });
  await json.cmd('lessons', 'list', '--json');
  expect(JSON.parse(json.text())).toEqual(list);
  for (const [args, text] of [[['--status', 'approved'], 'no approved lessons'], [[], 'no lessons']] as const) {
    const e = fg({ 'GET /api/lessons': [] });
    await e.cmd('lessons', ...args);
    expect(e.text()).toBe(text);
  }
  const detail = { lesson: { id: 'l1', status: 'approved', decidedBy: 'owner', projectKey: null, scope: 'global', title: 't', rule: 'r', appliesWhen: 'w', paths: ['a.ts', 'b.ts'] }, miss: { missed: 'the rule', cause: 'no-context' }, feedback: { text: 'fb' } };
  const show = fg({ 'GET /api/lessons/l1': detail });
  await show.cmd('lessons', 'show', 'l1');
  expect(show.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['FIELD VALUE', 'id l1', 'status approved by owner', 'project global', 'scope global', 'title t', 'rule r', 'applies w', 'paths a.ts, b.ts', 'missed the rule (no-context)', 'feedback fb']);
  const bare = fg({ 'GET /api/lessons/l2': { lesson: { id: 'l2', status: 'proposed', projectKey: 'a', scope: 'project', title: 't', rule: 'r', appliesWhen: 'w' }, miss: { missed: 'm' } } });
  await bare.cmd('lessons', 'show', 'l2');
  expect(bare.text()).toMatch(/status\s+proposed\n/);
  expect(bare.text()).toMatch(/paths\s*\n/);
  expect(bare.text()).toMatch(/missed\s+m \(\)/);
  const noMiss = fg({ 'GET /api/lessons/l3': { lesson: { id: 'l3', status: 'proposed', projectKey: 'a', scope: 'project', title: 't', rule: 'r', appliesWhen: 'w', paths: [] } } });
  await noMiss.cmd('lessons', 'show', 'l3');
  expect(noMiss.text()).not.toMatch(/missed|feedback/);
  const showJson = fg({ 'GET /api/lessons/l1': detail });
  await showJson.cmd('lessons', 'show', 'l1', '--json');
  expect(JSON.parse(showJson.text())).toEqual(detail);
  const noId = fg({});
  expect(await noId.cmd('lessons', 'show')).toBe(2);
  expect(noId.errors()).toMatch(/fg lessons show needs a lesson id/);
});

test('lessons quality, recheck and to-fact with --json; quality says when it was capped and shares of no decisions are 0%', async () => {
  const q = { windows: [{ days: 30, asWritten: 0, edited: 0, rejected: 0, decided: 0 }], projects: {}, capped: true as const };
  const f = fg({ 'GET /api/lessons/quality': q });
  await f.cmd('lessons', 'quality');
  expect(f.out[0]).toMatch(/all\s+30\s+0\s+0 \(0%\)\s+0 \(0%\)\s+0 \(0%\)\s+0\b/);
  expect(f.out[1]).toBe('(capped: more decisions than were counted; the oldest are left out)');
  const qj = fg({ 'GET /api/lessons/quality': q });
  await qj.cmd('lessons', 'quality', '--json');
  expect(JSON.parse(qj.text())).toEqual(q);
  const r = fg({ 'POST /api/lessons/recheck': { queued: 4 } });
  await r.cmd('lessons', 'recheck', '--json');
  expect(JSON.parse(r.text())).toEqual({ queued: 4 });
  const fact = { id: 'f1', kind: 'convention', path: 'a.ts' };
  const t = fg({ 'POST /api/lessons/l1/to-fact': fact });
  await t.cmd('lessons', 'to-fact', 'l1', '--json');
  expect(JSON.parse(t.text())).toEqual(fact);
});

test('lessons: an unknown verb is a usage error; decisions with --json carry the sharing notice the API sent', async () => {
  const f = fg({});
  expect(await f.cmd('lessons', 'frob')).toBe(2);
  expect(f.errors()).toMatch(/unknown lessons command: frob/);
  const sharing = { message: 'shared with your team', adminApprovalRequired: false };
  const g = fg({ 'POST /api/lessons/decisions': { results: [{ id: 'l1', ok: true, status: 'approved' }, { id: 'l2', ok: false, error: 'gone' }], sharing } });
  expect(await g.cmd('lessons', 'approve', 'l1', 'l2', '--json')).toBe(1);
  expect(JSON.parse(g.text())).toEqual([{ id: 'l1', ok: true, status: 'approved', sharing }, { id: 'l2', ok: false, error: 'gone' }]);
});

// ── cloud ──────────────────────────────────────────────────────────────

test('cloud status: off, --json, and every part of an enabled one', async () => {
  const off = fg({ 'GET /api/cloud': { enabled: false } });
  await off.cmd('cloud', 'status');
  expect(off.text()).toMatch(/cloud sync is off/);
  const json = fg({ 'GET /api/cloud': { enabled: false } });
  await json.cmd('cloud', 'status', '--json');
  expect(JSON.parse(json.text())).toEqual({ enabled: false });
  const on = fg({ 'GET /api/cloud?project=a': { enabled: true, host: 'cloud.example', intervalMinutes: 30, nextAt: '2026-11-10T11:00:00Z', projects: ['a'], suggestions: true,
    preview: { total: { projects: 1, lessons: 2, misses: 0, facts: 3, docs: 0, codeFiles: 4 }, projects: [{ key: 'a', counts: { lessons: 2, misses: 0, facts: 3, docs: 0, codeFiles: 4 } }, { key: 'b', counts: null, reason: 'local-only' }, { key: 'c', counts: null }] },
    previewError: 'slow', last: { at: '2026-11-10T10:00:00Z', trigger: 'manual', ok: false, error: null, teamLessons: [{ message: 'm1' }, { message: 'm1' }] },
    teamLessons: { message: 'needs approval' }, policyError: 'policy unavailable' } });
  await on.cmd('cloud', 'status', '--project', 'a');
  const t = `${on.text()}\n`;
  for (const s of ['cloud.example, every 30 min, next 2026-11-10 11:00:00', 'approved and proposed (SYNC_SUGGESTIONS)', '1 projects, 2 lessons, 0 misses, 3 facts, 0 docs, 4 code files', 'failed: slow',
    '2026-11-10 10:00:00 (manual) FAILED:\n', 'project   a: eligible (2 lessons, 0 misses, 3 facts, 0 docs, 4 code files)', 'project   b: not sent: local-only', 'project   c: not sent: no shareable knowledge',
    'team      needs approval', 'team      policy unavailable']) expect(t).toContain(s);
  expect(on.out.filter((l) => l === 'team      m1')).toHaveLength(1);
  const plain = fg({ 'GET /api/cloud': { enabled: true, host: 'h', intervalMinutes: 15, projects: ['a'], last: { at: '2026-11-10T10:00:00Z', trigger: 'schedule', ok: true } } });
  await plain.cmd('cloud', 'status');
  expect(plain.text()).toMatch(/host\s+h, every 15 min\n/);
  expect(plain.text()).toMatch(/lessons\s+approved only/);
  expect(plain.text()).toMatch(/last\s+2026-11-10 10:00:00 \(schedule\) ok/);
  expect(plain.text()).toContain('project   a: not sent: preview unavailable');
  const manual = fg({ 'GET /api/cloud': { enabled: true, host: 'h', intervalMinutes: 0, projects: [] } });
  await manual.cmd('cloud', 'status');
  expect(manual.text()).toMatch(/host\s+h, only on Sync now/);
  expect(manual.text()).toMatch(/last\s+never/);
});

test('cloud sync-now shows its progress while it runs, and its result: failed, --json, the team notices', async () => {
  let release!: () => void;
  const done = new Promise<void>((r) => { release = r; });
  const progress = [{ running: { done: 0, total: 2, current: 'a' } }, { running: { done: 0, total: 2, current: 'a' } }, { running: { done: 1, total: 2, current: null } }, { running: null }];
  let p = 0;
  let ticks = 0;
  const f = fg({
    'POST /api/cloud/sync': async () => { await done; return { ok: false, error: null, projects: [{ status: 'sent', teamLessons: { message: 't' } }, { status: 'failed' }, { status: 'sent' }], sent: { projects: 2 } }; },
    'GET /api/cloud/progress': () => { const r = progress[Math.min(p++, 3)]; if (p === 4) release(); return r; },
  }, {}, { sleep: async () => { ticks++; } });
  expect(await f.cmd('cloud', 'sync-now')).toBe(1);
  expect(f.err).toEqual(['syncing 0 of 2 (a)', 'syncing 1 of 2']);
  expect(f.out).toEqual(['cloud sync failed: : 2 sent, 1 failed; sent {"projects":2}', 'team      t']);
  expect(ticks).toBeGreaterThan(0);
  const json = fg({ 'POST /api/cloud/sync': { ok: true, projects: [] } }, {}, { sleep: () => new Promise((r) => setTimeout(r, 50)) });
  expect(await json.cmd('cloud', 'sync', '--json')).toBe(0);
  expect(JSON.parse(json.text())).toEqual({ ok: true, projects: [] });
  const jsonFailed = fg({ 'POST /api/cloud/sync': { ok: false } }, {}, { sleep: () => new Promise((r) => setTimeout(r, 50)) });
  expect(await jsonFailed.cmd('cloud', 'sync', '--json')).toBe(1);
  const empty = fg({ 'POST /api/cloud/sync': new Response(null, { status: 200 }) }, {}, { sleep: () => new Promise((r) => setTimeout(r, 50)) });
  expect(await empty.cmd('cloud', 'sync')).toBe(0);
  expect(empty.text()).toBe('cloud sync done');
  const bad = fg({});
  expect(await bad.cmd('cloud', 'frob')).toBe(2);
  expect(bad.errors()).toMatch(/usage: fg cloud status \| fg cloud sync-now/);
});

// ── map, demo, links, facts, docs ──────────────────────────────────────

test('map drop and rebuild --json; demo --json', async () => {
  const drop = fg({ 'DELETE /api/projects/a/codemap': { dropped: true } });
  await drop.cmd('map', 'drop', 'a');
  expect(drop.text()).toBe('a: code map dropped; facts and transcripts retained');
  const dropJson = fg({ 'DELETE /api/projects/a/codemap': { dropped: true } });
  await dropJson.cmd('map', 'drop', 'a', '--json');
  expect(JSON.parse(dropJson.text())).toEqual({ dropped: true });
  const rebuild = fg({ 'POST /api/projects/a/codemap/rebuild': { queued: true } });
  await rebuild.cmd('map', 'rebuild', 'a', '--json');
  expect(JSON.parse(rebuild.text())).toEqual({ key: 'a', queued: true });
  const demo = fg({ 'POST /api/demo/seed': { message: 'seeded' } });
  await demo.cmd('demo', 'seed', '--json');
  expect(JSON.parse(demo.text())).toEqual({ message: 'seeded' });
});

test('links: list (--json, empty, missing score and note), confirm with relation and note, and the usage errors', async () => {
  const list = [{ a: 'a', b: 'b', relation: 'related', status: 'suggested' }];
  const f = fg({ 'GET /api/projects/a/links': list });
  await f.cmd('links', '--project', 'a');
  expect(f.out[0]).toMatch(/a\s+b\s+related\s+suggested\s+0\.00$/m);
  const json = fg({ 'GET /api/projects/a/links': list });
  await json.cmd('links', 'list', '--project', 'a', '--json');
  expect(JSON.parse(json.text())).toEqual(list);
  const empty = fg({ 'GET /api/projects/a/links': [] });
  await empty.cmd('links', 'list', '--project', 'a');
  expect(empty.text()).toBe('no links for a');
  const put = fg({ 'PUT /api/links': (b: object) => ({ ...b, relation: 'depends_on' }) });
  await put.cmd('links', 'dismiss', 'a', 'b', '--relation', 'depends_on', '--note', 'n', '--json');
  expect(put.calls[0].body).toEqual({ a: 'a', b: 'b', status: 'dismissed', relation: 'depends_on', note: 'n' });
  expect(JSON.parse(put.text())).toMatchObject({ status: 'dismissed' });
  const confirm = fg({ 'PUT /api/links': (b: object) => ({ ...b, relation: 'related' }) });
  await confirm.cmd('links', 'confirm', 'a', 'b');
  expect(confirm.calls[0].body).toEqual({ a: 'a', b: 'b', status: 'confirmed' });
  expect(confirm.text()).toBe('a ↔ b confirmed (related)');
  for (const [args, message] of [[['frob'], /unknown links command: frob/], [['confirm', 'a'], /fg links confirm needs two projects/], [['list'], /needs --project k/]] as const) {
    const e = fg({});
    expect(await e.cmd('links', ...args)).toBe(2);
    expect(e.errors()).toMatch(message);
  }
});

test('facts: a search keeps --kind, --limit cuts the list, relevance is shown or unscored; --json; the usage errors', async () => {
  const hits = [{ fact: { id: 'f1', kind: 'convention', path: 'a.ts', statement: 's1', relevance: 0.8, relevanceBy: 'owner' }, score: 0.9 }, { fact: { id: 'f2', kind: 'gotcha', path: 'b.ts', statement: 's2', relevance: null }, score: 0.5 }];
  const search = fg({ 'GET /api/projects/a/facts': hits });
  await search.cmd('facts', '--project', 'a', '--q', 'x', '--kind', 'convention');
  expect(search.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['ID KIND RELEVANCE SCORE PATH STATEMENT', 'f1 convention 0.80 owner 0.90 a.ts s1']);
  const all = fg({ 'GET /api/projects/a/facts': hits });
  await all.cmd('facts', 'list', '--project', 'a', '--q', 'x', '--limit', '1', '--json');
  expect(JSON.parse(all.text())).toEqual([{ ...hits[0].fact, score: 0.9 }]);
  const list = fg({ 'GET /api/projects/a/facts': [{ id: 'f3', kind: 'convention', path: 'c.ts', statement: 's3', relevance: 0.5 }, { id: 'f4', kind: 'convention', path: 'd.ts', statement: 's4' }] });
  await list.cmd('facts', '--project', 'a');
  expect(list.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['ID KIND RELEVANCE PATH STATEMENT', 'f3 convention 0.50 c.ts s3', 'f4 convention unscored d.ts s4']);
  const none = fg({ 'GET /api/projects/a/facts': [] });
  await none.cmd('facts', '--project', 'a');
  expect(none.text()).toBe('no facts for a');
  const miss = fg({ 'GET /api/projects/a/facts': [] });
  await miss.cmd('facts', '--project', 'a', '--q', 'auth');
  expect(miss.text()).toBe('no facts in a match "auth"');
  const rel = fg({ 'PATCH /api/projects/a/facts/f1/relevance': { ok: true } });
  await rel.cmd('facts', 'relevance', 'f1', '0.3', '--project', 'a', '--json');
  expect(JSON.parse(rel.text())).toEqual({ id: 'f1', relevance: 0.3 });
  for (const [args, message] of [[['frob', '--project', 'a'], /unknown facts command: frob/], [['relevance', 'f1', '--project', 'a'], /fg facts relevance <id> <0\.\.1>/], [['relevance', 'f1', '2', '--project', 'a'], /fg facts relevance/], [['relevance'], /fg facts relevance needs --project k/], [[], /fg facts list needs --project k/]] as const) {
    const e = fg({});
    expect(await e.cmd('facts', ...args)).toBe(2);
    expect(e.errors()).toMatch(message);
  }
});

test('docs: the read state of each document, --json, the list cap; upload from the file system, a name that sanitises to nothing, --json', async () => {
  const docs = [
    { ref: 'd1', kind: 'pdf', read: { status: 'done', facts: 2 }, addedBy: 'owner', addedAt: '2026-11-10T10:00:00Z', title: 't1' },
    { ref: 'd2', read: { status: 'done' }, addedAt: '2026-11-10T10:00:00Z', title: 't2' },
    { ref: 'd3', read: { status: 'failed', error: 'too big' }, title: 't3' },
    { ref: 'd4', read: { status: 'queued' }, title: 't4' },
    { ref: 'd5', read: null, title: 't5' },
  ];
  const f = fg({ 'GET /api/projects/a/docs': docs });
  await f.cmd('docs', '--project', 'a');
  expect(f.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual([
    'REF KIND READ ADDED BY ADDED TITLE', 'd1 pdf done (2 facts) owner 2026-11-10 10:00:00 t1', 'd2 text done (0 facts) 2026-11-10 10:00:00 t2', 'd3 text failed: too big t3', 'd4 text queued t4', 'd5 text t5',
  ]);
  const json = fg({ 'GET /api/projects/a/docs': docs });
  await json.cmd('docs', 'list', '--project', 'a', '--json');
  expect(JSON.parse(json.text())).toEqual(docs);
  const many = fg({ 'GET /api/projects/a/docs': Array.from({ length: 500 }, (_, i) => ({ ref: `d${i}`, title: 't' })) });
  await many.cmd('docs', '--project', 'a');
  expect(many.out[1]).toBe('the newest 500 documents are shown: older ones are on the project\'s Docs page');
  const empty = fg({ 'GET /api/projects/a/docs': [] });
  await empty.cmd('docs', '--project', 'a');
  expect(empty.text()).toBe('no documents for a');

  const dir = mkdtempSync(join(tmpdir(), 'fg-cli-docs-'));
  temps.push(dir);
  writeFileSync(join(dir, '-'), 'notes');
  const up = fg({ 'POST /api/projects/a/docs': { id: 'doc-1', chunks: 1 } });
  expect(await up.cmd('docs', 'upload', join(dir, '-'), '--project', 'a', '--json')).toBe(0);
  expect(up.calls[0].body).toEqual({ title: 'upload.txt', name: 'upload.txt', text: 'notes' });
  expect(JSON.parse(up.text())).toEqual({ id: 'doc-1', chunks: 1 });
  for (const [args, message] of [[['frob', '--project', 'a'], /unknown docs command: frob/], [['upload', '--project', 'a'], /fg docs upload <file> --project k/], [['upload', 'x'], /fg docs upload needs --project k/], [[], /fg docs list needs --project k/]] as const) {
    const e = fg({});
    expect(await e.cmd('docs', ...args)).toBe(2);
    expect(e.errors()).toMatch(message);
  }
});

// ── activity, cleanup, evidence, sessions, integrations ────────────────

test('activity: --json asks for the details; a RUN column only when an entry is a run\'s', async () => {
  const list = [{ ts: '2026-11-10T10:00:00Z', actor: 'fg', kind: 'scan_started', projectKey: 'a', run: 'r1', sandbox: true, subject: 's1' }, { ts: '2026-11-10T10:00:00Z', actor: 'fg', kind: 'k', run: 'r2', subject: 's2' }, { ts: '2026-11-10T10:00:00Z', actor: 'owner', kind: 'k', subject: 's3' }];
  const f = fg({ 'GET /api/activity': list });
  await f.cmd('activity');
  expect(f.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['TIME ACTOR KIND PROJECT RUN SUBJECT', '2026-11-10 10:00:00 fg scan_started a r1 (sandbox) s1', '2026-11-10 10:00:00 fg k r2 s2', '2026-11-10 10:00:00 owner k s3']);
  const json = fg({ 'GET /api/activity': list });
  await json.cmd('activity', '--json');
  expect(json.calls[0].path).toBe('/api/activity?limit=50&details=1');
  expect(JSON.parse(json.text())).toEqual(list);
});

test('cleanup: --json, a sandbox run with nothing to remove, an applied cleanup that removed nothing countable, singular entries', async () => {
  const json = fg({ 'DELETE /api/runs/r1': plan() });
  await json.cmd('cleanup', '--run', 'r1', '--json');
  expect(JSON.parse(json.text())).toEqual(plan());
  const nothing = fg({ 'DELETE /api/runs/r1': plan({ sandbox: true, dryRun: false, removed: { lesson: 0 }, entriesRemoved: 0 }) });
  await nothing.cmd('cleanup', '--run', 'r1', '--apply');
  expect(nothing.text()).toBe('run r1 (sandbox): nothing to remove');
  const applied = fg({ 'DELETE /api/runs/r1': plan({ sandbox: true, dryRun: false, removed: { lesson: 0 }, entriesRemoved: 1 }) });
  await applied.cmd('cleanup', '--run', 'r1', '--apply');
  expect(applied.out).toEqual(['run r1 (sandbox): removed', 'nothing removed', '\nremoved its 1 Activity entry; the run_cleaned entry in Activity records the cleanup and what the run changed']);
  const one = fg({ 'DELETE /api/runs/r1': plan({ entries: 1 }) });
  await one.cmd('cleanup', '--run', 'r1');
  expect(one.out).toEqual(['run r1: dry run, nothing removed yet', 'nothing to remove', '\nits 1 Activity entry goes too with --apply (a run_cleaned entry, not the run\'s, records the cleanup and what the run changed); fg cleanup --run r1 --apply removes all of it']);
});

test('evidence: pruned text, many edited files, turns listed by why they matter, inbox items, --json', async () => {
  const e = {
    session: { id: 's1', projectKey: 'a', source: 'claude', state: 'done' },
    turns: { count: 3, first: '2026-11-10T10:00:00Z', last: '2026-11-10T11:00:00Z', classified: 3, waiting: 0, givenUp: 0, prunedText: 2 },
    files: { edited: Array.from({ length: 9 }, (_, i) => `f${i}.ts`), readOnly: [] },
    flags: [
      { index: 1, label: 'pushback', confidence: 0.9, flagged: true, candidateId: 'c1', skipped: [], why: 'w' },
      { index: 2, label: 'correction', flagged: false, skipped: [] },
      { index: 3, label: 'other', flagged: false, skipped: ['bot'] },
      { index: 4, label: 'other', flagged: false, skipped: [] },
    ],
    flagsLeftOut: 5,
    inbox: [{ id: 'c1', status: 'confirmed', decidedBy: 'owner', lesson: { id: 'l1', status: 'approved' }, miss: { missed: 'm' } }, { id: 'c2', status: 'pending' }],
    served: [],
  };
  const f = fg({ 'GET /api/sessions/s1/evidence': e });
  await f.cmd('evidence', 's1');
  expect(f.out[0]).toBe('s1 [a] claude, done: 3 turns (2026-11-10 10:00:00 to 2026-11-10 11:00:00), 3 classified, 0 waiting, 0 given up, 2 with their text pruned');
  expect(f.out[1]).toBe('files: 9 edited (f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts, ...), 0 only read');
  expect(f.out[2].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['', 'TURN LABEL CONF FILED SKIP RULES WHY', '1 pushback 0.9 c1 w', '2 correction no', '3 other no bot']);
  expect(f.out[3]).toBe('(5 more classified turns not listed)');
  expect(f.out[4].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['', 'INBOX STATUS DECIDED BY LESSON MISS', 'c1 confirmed owner l1 (approved) m', 'c2 pending']);
  const few = fg({ 'GET /api/sessions/s1/evidence': { ...e, files: { edited: [], readOnly: ['r.ts'] } } });
  await few.cmd('evidence', 's1');
  expect(few.out[1]).toBe('files: 0 edited, 1 only read');
  const some = fg({ 'GET /api/sessions/s1/evidence': { ...e, files: { edited: ['a.ts'], readOnly: [] } } });
  await some.cmd('evidence', 's1');
  expect(some.out[1]).toBe('files: 1 edited (a.ts), 0 only read');
  const json = fg({ 'GET /api/sessions/s1/evidence': e });
  await json.cmd('evidence', 's1', '--json');
  expect(JSON.parse(json.text())).toEqual(e);
});

test('sessions: register checks the id and the run, names the credential; the list (--json, missing fields, the next cursor)', async () => {
  for (const [args, env, message] of [
    [['register', 'bad id!'], {}, /pass the actual id/],
    [['register'], {}, /pass the actual id/],
    [['register', 's1'], {}, /session registration requires --run or FG_RUN/],
    [['register', 's1', 'extra', '--run', 'r'], {}, null],
    [['frob'], {}, /fg sessions \[register \[session-id\]\]/],
  ] as const) {
    const e = fg({ 'POST /api/sessions/s1/run': {} }, env);
    const code = await e.cmd('sessions', ...args);
    if (message) { expect(code).toBe(2); expect(e.errors()).toMatch(message); } else expect(code).toBe(0);
  }
  const codex = fg({ 'POST /api/sessions/t1/run': {} }, { CODEX_THREAD_ID: 't1', FG_RUN: 'r9' });
  expect(await codex.cmd('sessions', 'register')).toBe(0);
  expect(codex.text()).toBe('registered session t1 for run r9 with no token');
  const json = fg({ 'POST /api/sessions/s1/run': {} }, { API_TOKEN: 'a' });
  await json.cmd('sessions', 'register', 's1', '--run', 'r', '--json');
  expect(JSON.parse(json.text())).toEqual({ id: 's1', registered: true, credential: 'API_TOKEN' });
  const r = { sessions: [{ id: 's1', projectKey: 'a', source: 'claude', state: 'done', lastActivityAt: '2026-11-10T10:00:00Z' }], next: 'cur' };
  const list = fg({ 'GET /api/sessions': r });
  await list.cmd('sessions');
  expect(list.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['ID PROJECT SOURCE STATE TURNS LAST ACTIVITY GOAL', 's1 a claude done 2026-11-10 10:00:00']);
  expect(list.out[1]).toBe('(more: the API\'s next cursor is cur)');
  const lj = fg({ 'GET /api/sessions': r });
  await lj.cmd('sessions', '--json');
  expect(JSON.parse(lj.text())).toEqual(r);
  const empty = fg({ 'GET /api/sessions': { sessions: [], next: null } });
  await empty.cmd('sessions');
  expect(empty.out).toEqual(['no sessions']);
});

test('integrations: the GitHub author filter, test and set results, --json, the usage errors', async () => {
  const author = fg({ 'PUT /api/settings/integrations/projects/a': {} });
  await author.cmd('integrations', 'project', 'a', '--github-author', 'all', '--json');
  expect(author.calls[0].body).toEqual({ githubAuthor: null });
  expect(JSON.parse(author.text())).toEqual({ project: 'a', githubAuthor: null });
  const loginJson = fg({ 'PUT /api/settings/integrations/projects/a': {} });
  await loginJson.cmd('integrations', 'project', 'a', '--github-author', 'octo', '--json');
  expect(JSON.parse(loginJson.text())).toEqual({ project: 'a', githubAuthor: 'octo' });
  const named = fg({ 'PUT /api/settings/integrations/projects/a': {} });
  await named.cmd('integrations', 'project', 'a', '--github-author', ' octo ');
  expect(named.text()).toBe('a: sync PRs by octo');

  const ok = fg({ 'POST /api/settings/integrations/github/test': { ok: true, account: null, error: null } });
  expect(await ok.cmd('integrations', 'test', 'github')).toBe(0);
  expect(ok.text()).toBe('github: ok (signed in)');
  const failed = fg({ 'POST /api/settings/integrations/linear/test': { ok: false, account: null, error: null } });
  expect(await failed.cmd('integrations', 'test', 'linear')).toBe(1);
  expect(failed.text()).toBe('linear: FAILED: ');
  const testJson = fg({ 'POST /api/settings/integrations/github/test': { ok: true, account: 'octo', error: null } });
  await testJson.cmd('integrations', 'test', 'github', '--json');
  expect(JSON.parse(testJson.text())).toEqual({ ok: true, account: 'octo', error: null });

  const saved = fg({ 'PUT /api/settings/integrations/github': { ok: true } }, {}, { readStdin: async () => 'tok\n' });
  await saved.cmd('integrations', 'set', 'github', '--from-stdin');
  expect(saved.calls[0].body).toEqual({ token: 'tok' });
  expect(saved.text()).toMatch(/github\s+saved/);
  const setJson = fg({ 'PUT /api/settings/integrations/github': { ok: true, view: { github: { connection: { state: 'ok', detail: 'as octo' } } } } }, {}, { readStdin: async () => 'tok' });
  await setJson.cmd('integrations', 'set', 'github', '--from-stdin', '--json');
  expect(JSON.parse(setJson.text())).toEqual({ ok: true, connection: { state: 'ok', detail: 'as octo' } });
  const savedJson = fg({ 'PUT /api/settings/integrations/linear': { ok: true } }, {}, { readStdin: async () => 'tok' });
  await savedJson.cmd('integrations', 'set', 'linear', '--from-stdin', '--json');
  expect(JSON.parse(savedJson.text())).toEqual({ ok: true, connection: null });
  // An io without standard input (not main's) has no token to read.
  const noStdin = fg({});
  expect(await noStdin.cmd('integrations', 'set', 'github', '--from-stdin')).toBe(2);
  expect(noStdin.errors()).toMatch(/no token on standard input/);

  const view = { github: { connection: { state: 'ok', detail: 'as octo' }, lastSyncAt: '2026-11-10T10:00:00Z' }, linear: {} };
  const status = fg({ 'GET /api/settings/integrations': view });
  await status.cmd('integrations');
  expect(status.out[0].split('\n').map((l) => l.replace(/\s+/g, ' '))).toEqual(['SERVICE STATE LAST SYNC', 'github ok: as octo 2026-11-10 10:00:00', 'linear unknown: never']);
  const statusJson = fg({ 'GET /api/settings/integrations': view });
  await statusJson.cmd('integrations', 'status', '--json');
  expect(JSON.parse(statusJson.text())).toEqual(view);

  for (const [args, message] of [
    [['project', 'a'], /fg integrations project <key> --github-author/],
    [['project', 'a', '--github-author', 'not/valid'], /--github-author needs a GitHub login or all/],
    [['frob'], /usage: fg integrations status \| set/],
  ] as const) {
    const e = fg({});
    expect(await e.cmd('integrations', ...args)).toBe(2);
    expect(e.errors()).toMatch(message);
  }
});
