import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';
import { ollamaEmbed } from '@fb/core';
import { mcpClientLabel } from './mcp.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const ctx: ContextDeps = {
  roots: [{ host: '/Users/j/Vibe', container: '/vibe' }],
  embed: async (t) => t.map(() => [1]),
  k: {
    searchLessons: async () => [],
    relatedMisses: async () => [],
    recordPreDoneCheck: async () => {},
    createManualFeedback: async () => 'manual:9',
  },
  judge: async () => [],
};

const rpc = (body: object) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
});

test('MCP lists the feedback graph tools', async () => {
  const app = createApp(repo, { context: ctx });
  const res = await app.request('/mcp', rpc({ method: 'tools/list', params: {} }));
  expect(res.status).toBe(200);
  const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
  expect(names).toEqual(['check_before_done', 'get_module_context', 'get_recent_sessions', 'get_task_context', 'impact', 'report_feedback', 'search_graph']);
});

test('MCP get_task_context returns markdown text', async () => {
  const app = createApp(repo, { context: ctx });
  const res = await app.request('/mcp', rpc({ method: 'tools/call', params: { name: 'get_task_context', arguments: { cwd: '/Users/j/Vibe/demo', task: 'search' } } }));
  const body = (await res.json()) as { result: { content: { type: string; text: string }[] } };
  expect(body.result.content[0].text).toContain('No approved lessons');
});

test('MCP report_feedback records manual feedback', async () => {
  const app = createApp(repo, { context: ctx });
  const res = await app.request('/mcp', rpc({ method: 'tools/call', params: { name: 'report_feedback', arguments: { cwd: '/Users/j/Vibe/demo', feedback: 'missed auth', what_was_done: 'endpoint' } } }));
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  expect(body.result.content[0].text).toContain('manual:9');
});

test('MCP report_feedback takes an optional session_id', async () => {
  const seen: unknown[] = [];
  const app = createApp(repo, { context: { ...ctx, k: { ...ctx.k, createManualFeedback: async (o) => { seen.push(o); return 'manual:9'; } } } });
  await app.request('/mcp', rpc({ method: 'tools/call', params: { name: 'report_feedback', arguments: { cwd: '/Users/j/Vibe/demo', feedback: 'missed auth', what_was_done: 'endpoint', session_id: 's-42' } } }));
  expect(seen).toEqual([expect.objectContaining({ text: 'missed auth', sessionId: 's-42' })]);
});

test('MCP get_task_context takes the files the agent will touch and ranks their lessons first', async () => {
  const asked: string[][] = [];
  const lesson = { id: 'l9', projectKey: 'demo', title: 'Release pool clients', rule: 'always release', appliesWhen: 'db work', scope: 'project' as const, paths: ['src/db/**'], status: 'approved' as const, source: 'postmortem' as const, cause: null, missId: null, createdAt: 't', decidedAt: 't' };
  const app = createApp(repo, { context: { ...ctx, codegraph: { lessonsForPaths: async (_k, paths) => { asked.push(paths); return [{ lesson, paths: ['src/db/pool.ts'] }]; } } } });
  const res = await app.request('/mcp', rpc({ method: 'tools/call', params: { name: 'get_task_context', arguments: { cwd: '/Users/j/Vibe/demo', task: 'tune pool', files: ['src/db/pool.ts'] } } }));
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  expect(asked).toEqual([['src/db/pool.ts']]);
  expect(body.result.content[0].text).toContain('Release pool clients');
  expect(body.result.content[0].text).toContain('touches src/db/pool.ts');
});

test('MCP search_graph returns its hits, not the task context, and has no check_before_done footer', async () => {
  const app = createApp(repo, { context: ctx });
  const res = await app.request('/mcp', rpc({ method: 'tools/call', params: { name: 'search_graph', arguments: { cwd: '/Users/j/Vibe/demo', query: 'purple elephant' } } }));
  const text = ((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text;
  expect(text).toMatch(/^# Feedback Graph search for "purple elephant"/);
  expect(text).toMatch(/No past miss is close enough/);
  expect(text).not.toContain('check_before_done');
});

test('MCP get_task_context takes brief and session_id', async () => {
  const asked: string[] = [];
  // The session's edited files and its start decide which facts are its own change.
  const codegraph = { lessonsForPaths: async () => [], sessionFiles: async (id: string) => { asked.push(`files:${id}`); return [{ path: 'src/pool.ts', read: true, edited: true, firstEditAt: null, lastEditAt: null }]; } };
  const app = createApp(repo, { context: { ...ctx, codegraph, sessions: { list: async () => ({ sessions: [], next: null }), detail: async (id) => { asked.push(id); return null; } } } });
  const res = await app.request('/mcp', rpc({ method: 'tools/call', params: { name: 'get_task_context', arguments: { cwd: '/Users/j/Vibe/demo', task: 'tune pool', brief: true } } }));
  expect(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text).toMatch(/^# Feedback Graph brief/);
  await app.request('/mcp', rpc({ method: 'tools/call', params: { name: 'get_task_context', arguments: { cwd: '/Users/j/Vibe/demo', task: 'tune pool', session_id: 's-7' } } }));
  expect(asked.sort()).toEqual(['files:s-7', 's-7']);
});

test('without Ollama, get_task_context and check_before_done say Ollama is not reachable, with its URL and model', async () => {
  const refused = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  }) as unknown as typeof fetch;
  const embed = (input: string[]) => ollamaEmbed({ url: 'http://host.docker.internal:11434', model: 'nomic-embed-text', input, fetchImpl: refused });
  const app = createApp(repo, { context: { ...ctx, embed } });
  for (const [name, args] of [['get_task_context', { task: 'search' }], ['check_before_done', { task: 'search', summary: 'done' }]] as const) {
    const res = await app.request('/mcp', rpc({ method: 'tools/call', params: { name, arguments: { cwd: '/Users/j/Vibe/demo', ...args } } }));
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/Ollama is not reachable at http:\/\/host\.docker\.internal:11434 \(nomic-embed-text, ECONNREFUSED\): start it/);
  }
});

const taskCall = rpc({ method: 'tools/call', params: { name: 'get_task_context', arguments: { cwd: '/Users/j/Vibe/demo', task: 'search' } } });
const withSession = (session: string) => ({ ...taskCall, headers: { ...taskCall.headers, 'mcp-session-id': session } });

test('MCP Activity names the client from initialize, carried in the session id to its later tool calls', async () => {
  const recorded: { actor: string }[] = [];
  const app = createApp(repo, { context: { ...ctx, activity: { record: async (a) => void recorded.push(a) } } });
  const init = await app.request('/mcp', rpc({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.309' } } }));
  expect(init.status).toBe(200);
  const session = init.headers.get('mcp-session-id');
  expect(session).toMatch(/^fg1\.[A-Za-z0-9_-]+$/);
  await app.request('/mcp', withSession(session!));
  // Without the session id (a client that never initialized here) it stays the generic actor.
  await app.request('/mcp', taskCall);
  expect(recorded.map((a) => a.actor)).toEqual(['claude-code 2.1.309 (MCP)', 'agent (MCP)']);
});

test('MCP client labels are cleaned, and a forged or foreign session id is ignored', async () => {
  expect(mcpClientLabel({ name: 'codex-mcp-client', version: '0.162.0' })).toBe('codex-mcp-client 0.162.0 (MCP)');
  expect(mcpClientLabel({ name: 'evil\n<script>x</script>', version: '1\u0000' })).toBe('evilscriptx/script 1 (MCP)');
  expect(mcpClientLabel({ name: 'a'.repeat(500) })).toBe(`${'a'.repeat(64)} (MCP)`);
  expect(mcpClientLabel({ version: '1' })).toBeUndefined();
  expect(mcpClientLabel(null)).toBeUndefined();
  const recorded: { actor: string }[] = [];
  const app = createApp(repo, { context: { ...ctx, activity: { record: async (a) => void recorded.push(a) } } });
  const forged = ['fg1.' + Buffer.from('you').toString('base64url'), 'fg1.' + Buffer.from('<b>x</b> (MCP)').toString('base64url'), 'some-other-session', 'fg1.%%%'];
  for (const session of forged) await app.request('/mcp', withSession(session));
  expect(recorded.map((a) => a.actor)).toEqual(forged.map(() => 'agent (MCP)'));
});

test('GET /api/agent/project tells the plugin hooks whether a folder is a selected project', async () => {
  const app = createApp(repo, { context: { ...ctx, inScope: (k) => k === 'demo' } });
  const ask = async (cwd: string) => (await app.request(`/api/agent/project?cwd=${encodeURIComponent(cwd)}`)).json();
  expect(await ask('/Users/j/Vibe/demo/src')).toEqual({ project: 'demo', tracked: true });
  expect(await ask('/Users/j/Vibe/other')).toEqual({ project: null, tracked: false });
});

test('a client ending its session (DELETE /mcp, no body) gets a clean answer: the server is stateless', async () => {
  const logs: { msg: string; extra?: object }[] = [];
  const app = createApp(repo, { context: ctx, log: (msg, extra) => logs.push({ msg, extra }) });
  const res = await app.request('/mcp', { method: 'DELETE', headers: { 'mcp-session-id': 'whatever' } });
  expect(res.status).toBe(204);
  expect(logs).toEqual([{ msg: 'request', extra: expect.objectContaining({ method: 'DELETE', status: 204 }) }]);
});

test('GET /mcp answers 405: the server sends nothing unasked, so clients do not hold (and reopen) an event stream', async () => {
  const app = createApp(repo, { context: ctx });
  const res = await app.request('/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } });
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toBe('POST, DELETE');
});

test('free-text arguments have a length limit: a megabyte task is refused before it is embedded or stored', async () => {
  const embedded: string[][] = [];
  const app = createApp(repo, { context: { ...ctx, embed: async (t) => { embedded.push(t); return t.map(() => [1]); } } });
  const call = async (name: string, args: object) => (await (await app.request('/mcp', rpc({ method: 'tools/call', params: { name, arguments: args } }))).json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
  const huge = 'C'.repeat(1_048_576);
  for (const [name, args] of [
    ['get_task_context', { cwd: '/Users/j/Vibe/demo', task: huge }],
    ['search_graph', { cwd: '/Users/j/Vibe/demo', query: huge }],
    ['check_before_done', { cwd: '/Users/j/Vibe/demo', task: 't', summary: huge }],
    ['report_feedback', { cwd: '/Users/j/Vibe/demo', feedback: huge, what_was_done: 'x' }],
  ] as const) {
    const r = await call(name, args);
    const text = r.error?.message ?? r.result?.content[0]?.text ?? '';
    expect(r.error !== undefined || r.result?.isError === true, name).toBe(true);
    expect(text, name).toMatch(/too_big|at most|too long|<=/i);
  }
  expect(embedded).toEqual([]);
  // An ordinary task still works.
  expect((await call('get_task_context', { cwd: '/Users/j/Vibe/demo', task: 'add search' })).result?.isError).toBeFalsy();
});

test('check_before_done takes a big diff and cuts it for the judge instead of refusing the call', async () => {
  const app = createApp(repo, { context: ctx });
  const file = (i: number) => `diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1 +1,400 @@\n${Array.from({ length: 400 }, (_, k) => `+export const v${k} = ${k};`).join('\n')}\n`;
  const diff = Array.from({ length: 40 }, (_, i) => file(i)).join('');
  expect(diff.length).toBeGreaterThan(300_000);
  const res = await app.request('/mcp', rpc({ method: 'tools/call', params: { name: 'check_before_done', arguments: { cwd: '/Users/j/Vibe/demo', task: 't', summary: 's', diff } } }));
  const r = (await res.json()) as { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown };
  expect(r.error).toBeUndefined();
  expect(r.result?.isError).toBeFalsy();
});

test('the check_before_done description tells the agent to pass its git diff', async () => {
  const app = createApp(repo, { context: ctx });
  const res = await app.request('/mcp', rpc({ method: 'tools/list', params: {} }));
  const tools = ((await res.json()) as { result: { tools: { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }[] } }).result.tools;
  const t = tools.find((x) => x.name === 'check_before_done')!;
  expect(t.inputSchema.properties.diff.description).toMatch(/git diff/);
  expect(t.description).toMatch(/diff/);
});

test('every agent MCP tool carries annotations: reads are read-only, report_feedback is a non-destructive write', async () => {
  // codex exec will not call a tool without annotations (it cannot tell a read from a write), so headless runs need each.
  const app = createApp(repo, { context: ctx });
  const res = await app.request('/mcp', rpc({ method: 'tools/list', params: {} }));
  type Tool = { name: string; title?: string; annotations?: Record<string, unknown> };
  const tools = ((await res.json()) as { result: { tools: Tool[] } }).result.tools;
  const writes = new Set(['get_task_context', 'check_before_done', 'get_module_context', 'impact', 'get_recent_sessions', 'search_graph', 'report_feedback']);
  expect(tools).toHaveLength(7);
  for (const t of tools) {
    expect(t.annotations, t.name).toBeDefined();
    expect(t.title, t.name).toMatch(/\w/);
    expect(t.annotations!.title, t.name).toBe(t.title);
    expect(t.annotations!.readOnlyHint, t.name).toBe(!writes.has(t.name));
    expect(t.annotations!.destructiveHint, t.name).toBe(false);
    expect(t.annotations!.openWorldHint, t.name).toBe(false);
  }
  // Each report queues a new inbox item, so calling it twice is not the same as calling it once.
  expect(tools.find((t) => t.name === 'report_feedback')!.annotations!.idempotentHint).toBe(false);
  expect(tools.filter((t) => !writes.has(t.name)).every((t) => t.annotations!.idempotentHint === true)).toBe(true);
});
