import { OPERATOR_VERBS, type ActivityInput, type Lesson, type OperatorVerb, type ProjectSelection } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo, type AppOpts, type SettingsDeps } from './app.ts';
import { ADMIN_TOOLS, handleAdminMcp } from './adminMcp.ts';
import type { CloudDeps } from './cloud.ts';

const OP = 'o'.repeat(32);
const API = 'a'.repeat(32);
const DEFAULT_ALLOW = OPERATOR_VERBS.filter((v) => v !== 'lesson_decide');

const cand = (id: string, source: string) => ({ id, projectKey: 'demo-shop', source, status: 'pending', classification: { label: 'pushback', confidence: 0.9, summary: 's', signals: [] } });
const lesson: Lesson = {
  id: 'l1', projectKey: 'demo-shop', title: 'T', rule: 'R', appliesWhen: 'W', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: null,
};
const project = { key: 'demo-shop', name: 'demo-shop', repoPath: '/vibe/demo-shop' };

function setup(o: { allow?: OperatorVerb[]; token?: string | null; apiToken?: string; extra?: Partial<AppOpts> } = {}) {
  const logged: ActivityInput[] = [];
  const calls: Record<string, unknown[]> = {};
  const note = (k: string, v: unknown) => { (calls[k] ??= []).push(v); };
  let sel: ProjectSelection = { tracked: ['acme'], initialized: true, updatedAt: 't' };
  const repo = {
    listCandidates: async (q: unknown) => { note('listCandidates', q); return [cand('c1', 'claude'), cand('c2', 'github')]; },
    stats: async () => [],
    decide: async (...a: unknown[]) => { note('decide', a); },
    candidateDetail: async (id: string) => (id === 'c1' ? { candidate: cand('c1', 'claude'), turn: { text: 'no' }, before: [], after: [], commits: [] } : null),
  } as unknown as ApiRepo;
  const settings: SettingsDeps = {
    selection: {
      current: async () => sel,
      setTracked: async (tracked) => { const before = sel.tracked; sel = { tracked, initialized: true, updatedAt: 'now' }; return { before, selection: sel }; },
      candidates: async () => null, aliases: async () => new Map(), keysWithData: async () => [],
      exclusive: async (fn) => fn(), forgetReads: async () => {},
    },
    folders: async () => [{ key: 'acme', path: '/Users/me/Vibe/acme' }, { key: 'demo-shop', path: '/Users/me/Vibe/demo-shop' }],
    excluded: [], roots: ['/Users/me/Vibe'],
  };
  const activity = { record: async (e: ActivityInput) => { logged.push(e); }, list: async () => [] };
  const cloud: CloudDeps = {
    cloud: null, portability: { exportData: async () => ({}) as never }, activity, projects: async () => [], worker: async () => null,
  };
  const token = o.token === undefined ? OP : o.token;
  const app = createApp(repo, {
    auth: { token: o.apiToken, ...(token !== null && { operator: { token, allow: o.allow ?? DEFAULT_ALLOW } }) },
    activity,
    system: { version: 't', ping: async () => true, worker: async () => null },
    knowledge: {
      listLessons: async () => [lesson],
      lessonDetail: async () => ({ lesson, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] }),
      updateLesson: async (...a: unknown[]) => { note('updateLesson', a); return { unscoped: false }; },
    } as never,
    facts: {
      listProjects: async () => [], listFacts: async () => [], searchFacts: async () => [],
      requestScan: async (p: { key: string }, provider: string | null) => { note('requestScan', [p.key, provider]); return { id: `scan:${p.key}`, projectKey: p.key, status: 'queued' }; },
      setFactRelevance: async (u: unknown[]) => { note('relevance', u); return 1; },
    } as never,
    projectDirs: async () => [project, { key: 'acme', name: 'acme', repoPath: '/vibe/acme' }],
    links: { listLinks: async () => [], deleteLink: async () => true, setLink: async (a: string, b: string, p: object) => { note('setLink', [a, b, p]); return { id: `link:${a}|${b}`, a, b, status: 'confirmed', relation: 'related' }; } } as never,
    codegraph: {
      hotspots: async () => [], moduleContext: async () => null, impact: async () => null, codeMapMeta: async () => null,
      requestCodeMapRebuild: async (k: string) => { note('rebuild', k); return true; },
    } as never,
    settings,
    cloud,
    ...o.extra,
  });
  return { app, logged, calls, sel: () => sel };
}

const rpc = (body: object, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
});
const bearer = (t: string, name?: string) => ({ authorization: `Bearer ${t}`, ...(name !== undefined && { 'x-fg-operator': name }) });

type ToolResult = { content: { text: string }[]; isError?: boolean };
async function tool(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, name: string, args: object, headers: Record<string, string> = bearer(OP, 'codex')) {
  const res = await app.request('/mcp/admin', rpc({ method: 'tools/call', params: { name, arguments: args } }, headers));
  expect(res.status).toBe(200);
  const r = ((await res.json()) as { result: ToolResult }).result;
  return { ...r, text: r.content[0].text };
}

test('the admin endpoint is absent while FG_OPERATOR_TOKEN is unset, even with a bearer', async () => {
  const { app } = setup({ token: null, apiToken: API });
  expect((await app.request('/mcp/admin', rpc({ method: 'tools/list', params: {} }, bearer(API)))).status).toBe(404);
  expect((await app.request('/mcp/admin', rpc({ method: 'tools/list', params: {} }, bearer(OP)))).status).toBe(404);
});

test('with no token it is not found; with a wrong one (or the API token) it is refused, and the token is never logged', async () => {
  const lines: [string, object | undefined][] = [];
  const { app } = setup({ apiToken: API, extra: { log: (m, x) => { lines.push([m, x]); } } });
  expect((await app.request('/mcp/admin', rpc({ method: 'tools/list', params: {} }))).status).toBe(404);
  const wrong = 'w'.repeat(32);
  const res = await app.request('/mcp/admin', rpc({ method: 'tools/list', params: {} }, bearer(wrong, 'codex')));
  expect(res.status).toBe(401);
  expect((await res.json()).error).toMatch(/FG_OPERATOR_TOKEN/);
  expect((await app.request('/mcp/admin', rpc({ method: 'tools/list', params: {} }, bearer(API)))).status).toBe(401);
  expect(lines.filter(([m]) => m === 'auth refused')).toContainEqual(['auth refused', expect.objectContaining({ path: '/mcp/admin', operator: 'operator:codex' })]);
  expect(JSON.stringify(lines)).not.toContain(wrong);
  // The read-only endpoint is untouched: it has no owner tools, even for the operator token.
  const ctx = { roots: [], embed: async (t: string[]) => t.map(() => [1]), k: {}, judge: async () => [] } as never;
  const ro = await setup({ extra: { context: ctx } }).app.request('/mcp', rpc({ method: 'tools/list', params: {} }, bearer(OP)));
  const names = ((await ro.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  expect(names).toContain('get_task_context');
  expect(names.filter((n) => n in ADMIN_TOOLS)).toEqual([]);
});

test('the operator token lists every admin tool, each description naming its verb', async () => {
  const { app } = setup();
  const res = await app.request('/mcp/admin', rpc({ method: 'tools/list', params: {} }, bearer(OP)));
  expect(res.status).toBe(200);
  const tools = ((await res.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;
  expect(tools.map((t) => t.name).sort()).toEqual([
    'cloud_sync_now', 'inbox_decide', 'inbox_list', 'lesson_decide', 'lessons_list', 'link_decide', 'list_projects',
    'pipeline_status', 'rebuild_code_map', 'scan_projects', 'select_projects', 'set_fact_relevance',
  ]);
  expect(tools.find((t) => t.name === 'lesson_decide')!.description).toContain('lesson_decide');
  expect(tools.find((t) => t.name === 'rebuild_code_map')!.description).toContain('OPERATOR_ALLOW: scan');
  expect(ADMIN_TOOLS.inbox_decide).toBe('inbox_decide');
  expect(ADMIN_TOOLS.inbox_list).toBeNull();
});

test('a refused verb is a tool error naming the verb and how to allow it; nothing changes', async () => {
  const { app, calls } = setup();
  const r = await tool(app, 'lesson_decide', { id: 'l1', decision: 'approve' });
  expect(r.isError).toBe(true);
  expect(r.text).toContain('lesson_decide');
  expect(r.text).toContain('OPERATOR_ALLOW');
  expect(calls.updateLesson).toBeUndefined();
  const narrow = setup({ allow: ['inbox_decide'] });
  const s = await tool(narrow.app, 'scan_projects', { all: true });
  expect(s.isError).toBe(true);
  expect(s.text).toContain('(scan)');
  expect(narrow.calls.requestScan).toBeUndefined();
});

test('the agent is named in Activity from X-FG-Operator, else the MCP client name from initialize', async () => {
  const { app, logged } = setup();
  await tool(app, 'inbox_decide', { items: [{ id: 'c1', decision: 'confirm', reason: 'right' }] });
  expect(logged.at(-1)).toEqual(expect.objectContaining({ kind: 'feedback_decided', actor: 'operator:codex' }));

  const init = await app.request('/mcp/admin', rpc({
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude code<b>', version: '2.1' } },
  }, bearer(OP)));
  expect(init.status).toBe(200);
  const session = init.headers.get('mcp-session-id');
  expect(session).toBeTruthy();
  await tool(app, 'inbox_decide', { items: [{ id: 'c1', decision: 'reject' }] }, { ...bearer(OP), 'mcp-session-id': session! });
  expect(logged.at(-1)!.actor).toBe('operator:claude-code-b');
  // A forged session id is cleaned like the header, never trusted as given.
  await tool(app, 'inbox_decide', { items: [{ id: 'c1', decision: 'reject' }] }, { ...bearer(OP), 'mcp-session-id': 'nonsense' });
  expect(logged.at(-1)!.actor).toBe('operator');
});

test('arguments are validated with limits before any route runs', async () => {
  const { app, calls } = setup();
  const res = await app.request('/mcp/admin', rpc({ method: 'tools/call', params: { name: 'inbox_decide', arguments: { items: [{ id: 'c1', decision: 'confirm', reason: 'x'.repeat(5000) }] } } }, bearer(OP)));
  const { result } = (await res.json()) as { result: ToolResult };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/4000|too_big|at most/i);
  expect(calls.decide).toBeUndefined();
});

test('pipeline_status: the status and every stage backlog', async () => {
  const r = await tool(setup().app, 'pipeline_status', {});
  expect(r.isError).toBeFalsy();
  const j = JSON.parse(r.text);
  expect(j.status.version).toBe('t');
  expect(j.pipeline).toHaveProperty('inbox');
});

test('list_projects: the selection and the shown projects', async () => {
  const j = JSON.parse((await tool(setup().app, 'list_projects', {})).text);
  expect(j.tracked).toEqual(['acme']);
  expect(j.projects.map((p: { key: string }) => p.key)).toContain('demo-shop');
});

test('select_projects adds, narrows to only, or removes', async () => {
  const s = setup();
  const r = await tool(s.app, 'select_projects', { keys: ['demo-shop'] });
  expect(r.isError).toBeFalsy();
  expect(s.sel().tracked).toEqual(['acme', 'demo-shop']);
  await tool(s.app, 'select_projects', { keys: ['acme'], mode: 'remove' });
  expect(s.sel().tracked).toEqual(['demo-shop']);
  await tool(s.app, 'select_projects', { keys: ['acme'], mode: 'only' });
  expect(s.sel().tracked).toEqual(['acme']);
  expect(s.logged.at(-1)).toEqual(expect.objectContaining({ kind: 'projects_selected', actor: 'operator:codex' }));
});

test('scan_projects queues keys or all with a provider', async () => {
  const s = setup();
  const j = JSON.parse((await tool(s.app, 'scan_projects', { keys: ['demo-shop'], provider: 'codex-cli' })).text);
  expect(j.results[0]).toEqual(expect.objectContaining({ key: 'demo-shop', queued: true }));
  expect(s.calls.requestScan).toEqual([['demo-shop', 'codex-cli']]);
});

test('scan_projects with wait follows each job until it is done', async () => {
  let polls = 0;
  const seen: string[] = [];
  const request = async (path: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/projects/scan') return Response.json({ results: [{ key: 'acme', queued: true, job: { id: 'j1', status: 'queued' } }] }, { status: 202 });
    polls++;
    return Response.json({ id: 'j1', projectKey: 'acme', status: polls < 2 ? 'running' : 'done', filesScanned: 3 });
  };
  const req = new Request('http://localhost/mcp/admin', rpc({ method: 'tools/call', params: { name: 'scan_projects', arguments: { all: true, wait: true } } }, bearer(OP)));
  const res = await handleAdminMcp(req, { request, sleep: async () => {} });
  const r = ((await res.json()) as { result: ToolResult }).result;
  expect(JSON.parse(r.content[0].text).jobs).toEqual([expect.objectContaining({ id: 'j1', status: 'done' })]);
  expect(seen).toEqual(['POST /api/projects/scan', 'GET /api/scans/j1', 'GET /api/scans/j1']);
});

test('inbox_list filters by status, project and source', async () => {
  const s = setup();
  const j = JSON.parse((await tool(s.app, 'inbox_list', { status: 'pending', project: 'demo-shop', source: 'github' })).text);
  expect(j.map((c: { id: string }) => c.id)).toEqual(['c2']);
  expect(s.calls.listCandidates[0]).toEqual(expect.objectContaining({ status: 'pending', projectKey: 'demo-shop' }));
});

test('inbox_decide decides many items and says per item what happened', async () => {
  const s = setup();
  const j = JSON.parse((await tool(s.app, 'inbox_decide', { items: [{ id: 'c1', decision: 'confirm' }, { id: 'nope', decision: 'reject' }] })).text);
  expect(j.results).toEqual([expect.objectContaining({ id: 'c1', ok: true }), expect.objectContaining({ id: 'nope', ok: false })]);
  expect(s.calls.decide[0]).toEqual(['c1', 'confirmed', null, 'operator:codex']);
});

test('lessons_list lists lessons', async () => {
  const j = JSON.parse((await tool(setup().app, 'lessons_list', { status: 'proposed' })).text);
  expect(j[0].id).toBe('l1');
});

test('lesson_decide approves when OPERATOR_ALLOW names lesson_decide, attributed to the agent', async () => {
  const s = setup({ allow: ['lesson_decide'] });
  const r = await tool(s.app, 'lesson_decide', { id: 'l1', decision: 'approve' });
  expect(r.isError).toBeFalsy();
  expect(s.calls.updateLesson[0]).toEqual(['l1', { status: 'approved' }, expect.objectContaining({ by: 'operator:codex' })]);
  expect(s.logged.at(-1)).toEqual(expect.objectContaining({ kind: 'lesson_decided', actor: 'operator:codex' }));
});

test('link_decide confirms a link', async () => {
  const s = setup();
  const r = await tool(s.app, 'link_decide', { a: 'acme', b: 'demo-shop', decision: 'confirm', relation: 'related' });
  expect(r.isError).toBeFalsy();
  expect(s.calls.setLink[0]).toEqual(['acme', 'demo-shop', { status: 'confirmed', relation: 'related' }]);
  expect(s.logged.at(-1)!.actor).toBe('operator:codex');
});

test('set_fact_relevance sets a fact as the agent', async () => {
  const s = setup();
  expect((await tool(s.app, 'set_fact_relevance', { project: 'demo-shop', id: 'f1', relevance: 0.2 })).isError).toBeFalsy();
  expect(s.calls.relevance[0]).toEqual([expect.objectContaining({ id: 'f1', relevance: 0.2, by: 'operator:codex', projectKey: 'demo-shop' })]);
});

test('cloud_sync_now passes the route answer through (sync off here)', async () => {
  const r = await tool(setup().app, 'cloud_sync_now', {});
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/409.*CLOUD_URL/);
});

test('rebuild_code_map queues a remap', async () => {
  const s = setup();
  const r = await tool(s.app, 'rebuild_code_map', { project: 'demo-shop' });
  expect(JSON.parse(r.text)).toEqual({ queued: true });
  expect(s.calls.rebuild).toEqual(['demo-shop']);
});
