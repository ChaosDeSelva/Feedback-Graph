import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';
import { initializeClientInfo } from './mcp.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const ctx = (o: Partial<ContextDeps> = {}): ContextDeps => ({
  roots: [{ host: '/Users/j/Vibe', container: '/vibe' }],
  embed: async (t) => t.map(() => [1]),
  k: { searchLessons: async () => [], relatedMisses: async () => [], missesNaming: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:9' },
  judge: async () => [],
  ...o,
});
const rpc = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
const tool = (name: string, args: object) => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('a store failure thrown as a bare string is still a retryable tool result, not a crash', async () => {
  const app = createApp(repo, { context: ctx({ embed: async () => { throw 'request timed out'; } }) });
  const body = (await (await app.request('/mcp', tool('get_task_context', { cwd: '/Users/j/Vibe/demo', task: 'search' }))).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  expect(body.result).toMatchObject({ isError: true, content: [{ text: 'The graph request exceeded its deadline. Retry this tool call.' }] });
});

test('a session id given to check_before_done or report_feedback is registered for the request\'s run first', async () => {
  const registered: string[] = [];
  const app = createApp(repo, { context: ctx({ registerSession: async (id) => { registered.push(id); } }) });
  await app.request('/mcp', tool('check_before_done', { cwd: '/Users/j/Vibe/demo', task: 'search', summary: 'added it', files_changed: [], session_id: 's-1' }));
  await app.request('/mcp', tool('report_feedback', { cwd: '/Users/j/Vibe/demo', feedback: 'still broken', what_was_done: 'a search box', session_id: 's-2' }));
  expect(registered).toEqual(['s-1', 's-2']);
});

test('without session registration a session id is simply passed on', async () => {
  const app = createApp(repo, { context: ctx() });
  const res = await app.request('/mcp', tool('report_feedback', { cwd: '/Users/j/Vibe/demo', feedback: 'still broken', what_was_done: 'a search box', session_id: 's-2' }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
});

test('a notification gets the transport\'s empty 202 back untouched', async () => {
  const app = createApp(repo, { context: ctx() });
  const res = await app.request('/mcp', rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  expect(res.status).toBe(202);
  expect(await res.text()).toBe('');
});

test('only a POST can carry an initialize request', async () => {
  expect(await initializeClientInfo(new Request('http://x/mcp', { method: 'PUT', body: JSON.stringify({ method: 'initialize', params: { clientInfo: { name: 'c' } } }) })))
    .toEqual({ found: false, info: undefined });
});
