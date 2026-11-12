import { afterEach, expect, test, vi } from 'vitest';
import { handleAdminMcp } from './adminMcp.ts';

type Reply = { status?: number; body?: unknown; text?: string };
type Routes = Record<string, Reply | ((body: unknown, n: number) => Reply)>;
type Result = { content: { text: string }[]; structuredContent?: Record<string, any>; isError?: boolean };

/** The app as the admin tools see it: each `METHOD path` answers as given; anything else is a 404. */
function app(routes: Routes) {
  const seen: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const count: Record<string, number> = {};
  const request = async (path: string, init: RequestInit) => {
    const key = `${init.method} ${path}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: String(init.method), path, headers: init.headers as Record<string, string>, body });
    const n = (count[key] = (count[key] ?? 0) + 1);
    const r = routes[key];
    const reply = typeof r === 'function' ? r(body, n) : r ?? { status: 404, body: { error: 'no route' } };
    const payload = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(payload || null, { status: reply.status ?? 200 });
  };
  return { request, seen };
}
const rpc = (method: string, params: object, headers: Record<string, string> = { authorization: 'Bearer op' }) => new Request('http://x/mcp/admin', {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});
async function tool(routes: Routes, name: string, args: object = {}, o: { headers?: Record<string, string>; sleep?: (ms: number) => Promise<void> } = {}) {
  const a = app(routes);
  const res = await handleAdminMcp(rpc('tools/call', { name, arguments: args }, o.headers), { intake: true, request: a.request, ...(o.sleep && { sleep: o.sleep }) });
  const { result } = (await res.json()) as { result: Result };
  return { result, seen: a.seen, data: result.structuredContent, text: result.content[0].text };
}

afterEach(() => { vi.useRealTimers(); });

test('an empty or list answer is still an object to the client; a refusal names the status and the route\'s error, in any shape', async () => {
  expect((await tool({ 'POST /api/candidates/decisions': { status: 204 } }, 'inbox_decide', { items: [{ id: 'c1', decision: 'reject' }] })).data).toEqual({ items: null });
  expect((await tool({ 'POST /api/cloud/sync': { body: [1, 2] } }, 'cloud_sync_now', { force: true })).data).toEqual({ items: [1, 2] });
  expect((await tool({ 'GET /api/lessons/l1': { status: 400, body: { issues: ['bad'] } } }, 'lesson_get', { id: 'l1' })).text).toBe('400: {"issues":["bad"]}');
  expect((await tool({ 'GET /api/lessons/l1': { status: 400, body: { error: { fieldErrors: {} } } } }, 'lesson_get', { id: 'l1' })).text).toBe('400: {"fieldErrors":{}}');
  const plain = await tool({ 'GET /api/lessons/l1': { status: 502, text: 'Bad Gateway' } }, 'lesson_get', { id: 'l1' });
  expect(plain.result).toMatchObject({ isError: true, content: [{ text: '502: Bad Gateway' }] });
});

test('cloud_sync_now sends force only when asked', async () => {
  const forced = await tool({ 'POST /api/cloud/sync': { body: {} } }, 'cloud_sync_now', { force: false });
  const plain = await tool({ 'POST /api/cloud/sync': { body: {} } }, 'cloud_sync_now');
  expect([forced.seen[0].body, plain.seen[0].body]).toEqual([{ force: false }, {}]);
});

test('pipeline_status fails with whichever of its two reads failed', async () => {
  expect((await tool({ 'GET /api/status': { status: 503, body: { error: 'store down' } }, 'GET /api/pipeline': { body: {} } }, 'pipeline_status')).text).toBe('503: store down');
  expect((await tool({ 'GET /api/status': { body: {} }, 'GET /api/pipeline?project=p': { status: 404, body: { error: 'not a project' } } }, 'pipeline_status', { project: 'p' })).text).toBe('404: not a project');
});

test('list_projects: folders and shown projects in one row each, with what each lacks as null and a note on odd folders', async () => {
  const folders = [
    { key: 'a', exists: true, tracked: true, claudeSessions: 2 },
    { key: 'b', exists: true, excluded: true, codexSessions: 1 },
    { key: 'c', exists: true, aliasOf: 'a' },
    { key: 'd', exists: false },
  ];
  const shown = [
    { key: 'a', pinned: true, sessions: 5, feedback: 1, lessons: 2, facts: 3, lastScan: { status: 'done', finishedAt: 'f' } },
    { key: 'e', lastScan: { status: 'running', startedAt: 's' } },
    { key: 'g', lastScan: { status: 'queued', requestedAt: 'r' } },
    { key: 'h', lastScan: { status: 'queued' } },
  ];
  const { data } = await tool({ 'GET /api/settings/projects': { body: { tracked: ['d'], candidates: folders } }, 'GET /api/projects': { body: shown } }, 'list_projects', { limit: 200 });
  expect(data!.tracked).toEqual(['d']);
  expect(data!.items).toEqual([
    { key: 'a', selected: true, pinned: true, sessions: 5, feedback: 1, lessons: 2, facts: 3, lastScan: { status: 'done', at: 'f' } },
    { key: 'b', selected: false, pinned: false, sessions: 1, feedback: null, lessons: null, facts: null, lastScan: null, note: 'excluded (EXCLUDE_PROJECTS)' },
    { key: 'c', selected: false, pinned: false, sessions: 0, feedback: null, lessons: null, facts: null, lastScan: null, note: 'clone of a' },
    { key: 'd', selected: true, pinned: false, sessions: 0, feedback: null, lessons: null, facts: null, lastScan: null, note: 'folder gone' },
    { key: 'e', selected: true, pinned: false, sessions: null, feedback: null, lessons: null, facts: null, lastScan: { status: 'running', at: 's' } },
    { key: 'g', selected: true, pinned: false, sessions: null, feedback: null, lessons: null, facts: null, lastScan: { status: 'queued', at: 'r' } },
    { key: 'h', selected: true, pinned: false, sessions: null, feedback: null, lessons: null, facts: null, lastScan: { status: 'queued', at: null } },
  ]);
});

test('list_projects without the folder list (its read failed) shows the projects as selected; without the projects it fails', async () => {
  const { data } = await tool({ 'GET /api/settings/projects': { status: 500, body: { error: 'x' } }, 'GET /api/projects': { body: [{ key: 'a' }] } }, 'list_projects');
  expect(data).toMatchObject({ tracked: null, items: [{ key: 'a', selected: true, sessions: null }] });
  expect((await tool({ 'GET /api/settings/projects': { body: {} }, 'GET /api/projects': { status: 500, body: { error: 'store down' } } }, 'list_projects')).text).toBe('500: store down');
});

test('select_projects: keys or all, never both or neither; only and remove modes; a refused read or save fails', async () => {
  const settings = { body: { tracked: ['a', 'z'], candidates: [
    { key: 'a', exists: true, excluded: false, aliasOf: null }, { key: 'b', exists: true, excluded: false, aliasOf: null },
    { key: 'gone', exists: false, excluded: false, aliasOf: null }, { key: 'x', exists: true, excluded: true, aliasOf: null }, { key: 'c', exists: true, excluded: false, aliasOf: 'a' },
  ] } };
  const save: Routes[string] = (body) => ({ body });
  expect((await tool({}, 'select_projects', {})).result).toMatchObject({ isError: true, content: [{ text: 'send either keys or all: true' }] });
  expect((await tool({}, 'select_projects', { keys: ['a'], all: true })).result.isError).toBe(true);
  expect((await tool({ 'GET /api/settings/projects': settings, 'PUT /api/settings/projects': save }, 'select_projects', { all: true, mode: 'only' })).data).toEqual({ tracked: ['a', 'b'] });
  expect((await tool({ 'GET /api/settings/projects': settings, 'PUT /api/settings/projects': save }, 'select_projects', { keys: ['z'], mode: 'remove' })).data).toEqual({ tracked: ['a'] });
  expect((await tool({ 'GET /api/settings/projects': { status: 500, body: { error: 'down' } } }, 'select_projects', { keys: ['a'] })).text).toBe('500: down');
  expect((await tool({ 'GET /api/settings/projects': settings, 'PUT /api/settings/projects': { status: 409, body: { error: 'excluded' } } }, 'select_projects', { keys: ['x'] })).text).toBe('409: excluded');
});

test('scan_projects wait: a job it cannot follow ends the wait with a note; it waits between checks with a real timer by default', async () => {
  const queued = { body: { results: [{ key: 'a', queued: true, job: { id: 'j1', status: 'queued' } }, { key: 'b', queued: false }] } };
  const lost = await tool({ 'POST /api/projects/scan': queued, 'GET /api/scans/j1': { status: 404, body: { error: 'gone' } } }, 'scan_projects', { keys: ['a', 'b'], wait: true });
  expect(lost.data).toEqual({ jobs: [{ id: 'j1', projectKey: 'a', status: 'queued' }], refused: [{ key: 'b', queued: false }], note: 'cannot follow job j1: 404' });
  vi.useFakeTimers();
  const job: Routes[string] = (_b, n) => ({ body: { id: 'j1', projectKey: 'a', status: n === 1 ? 'running' : 'done' } });
  const waiting = tool({ 'POST /api/projects/scan': queued, 'GET /api/scans/j1': job }, 'scan_projects', { all: true, provider: 'ollama:m', wait: true, timeout_seconds: 10 });
  await vi.advanceTimersByTimeAsync(3000);
  const done = await waiting;
  expect(done.data!.jobs).toEqual([{ id: 'j1', projectKey: 'a', status: 'done' }]);
  expect(done.seen[0].body).toEqual({ all: true, provider: 'ollama:m' });
});

test('inbox_list: a full store page says the total is at least that; rows carry nulls for what an item lacks', async () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, projectKey: 'a', source: 'github', status: 'pending', ...(i === 0 && { external: { title: 7 } }) }));
  const { data } = await tool({ 'GET /api/candidates?limit=1000': { body: items } }, 'inbox_list', { limit: 1 });
  expect(data).toMatchObject({ total: 1000, totalIsAtLeast: true, more: 999, note: '999+ more: pass offset: 1 for the next page' });
  expect(data!.items[0]).toEqual({ id: 'c0', projectKey: 'a', source: 'github', status: 'pending', label: null, confidence: null, summary: null, author: null, authorKind: null, title: null, url: null, createdAt: null, decidedBy: null });
  expect((await tool({ 'GET /api/candidates?limit=1000': { status: 500, body: { error: 'down' } } }, 'inbox_list')).text).toBe('500: down');
});

test('lessons_list rows without a project or paths; a refused list fails', async () => {
  const { data } = await tool({ 'GET /api/lessons': { body: [{ id: 'l1', status: 'approved', scope: 'global', title: 't', rule: 'r', createdAt: 'c' }] } }, 'lessons_list');
  expect(data!.items[0]).toMatchObject({ projectKey: null, paths: [], checks: null, cause: null, decidedBy: null });
  expect((await tool({ 'GET /api/lessons': { status: 500, body: { error: 'down' } } }, 'lessons_list')).text).toBe('500: down');
});

test.each([['approve', 'approved'], ['reject', 'rejected'], ['revoke', 'revoked']])('lesson_decide %s sets %s', async (decision, status) => {
  const r = await tool({ 'PATCH /api/lessons/l1': { body: {} } }, 'lesson_decide', { id: 'l1', decision });
  expect(r.seen[0].body).toEqual({ status });
  expect(r.data).toMatchObject({ id: 'l1', status });
});

test.each([['confirm', 'confirmed'], ['dismiss', 'dismissed'], ['reopen', 'suggested']])('link_decide %s sends %s, with a note when given', async (decision, status) => {
  const r = await tool({ 'PUT /api/links': { body: {} } }, 'link_decide', { a: 'x', b: 'y', decision, note: '' });
  expect(r.seen[0].body).toEqual({ a: 'x', b: 'y', status, note: '' });
});

test('set_fact_relevance and demo_remove: a refusal fails; another project is named', async () => {
  expect((await tool({}, 'set_fact_relevance', { project: 'a', id: 'f', relevance: 1 })).text).toBe('404: no route');
  const r = await tool({ 'POST /api/demo/remove': { body: { message: 'Removed.' } } }, 'demo_remove', { project: 'other' });
  expect([r.text, r.seen[0].body]).toEqual(['Removed.', { project: 'other' }]);
});

test('the admin endpoint ends sessions with 204 and has no stream; without a bearer the tools forward none', async () => {
  const a = app({});
  expect((await handleAdminMcp(new Request('http://x/mcp/admin', { method: 'DELETE' }), { intake: true, request: a.request })).status).toBe(204);
  const get = await handleAdminMcp(new Request('http://x/mcp/admin'), { intake: true, request: a.request });
  expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST, DELETE']);
  const r = await tool({ 'GET /api/lessons/l1': { body: {} } }, 'lesson_get', { id: 'l1' }, { headers: {} });
  expect(r.seen[0].headers.authorization).toBe('');
});

test('an initialize whose client name is not a string names no agent', async () => {
  const a = app({});
  const res = await handleAdminMcp(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 42, version: '1' } }), { intake: true, request: a.request });
  expect(res.status).toBe(200);
  expect(res.headers.get('mcp-session-id')).toBeNull();
});
