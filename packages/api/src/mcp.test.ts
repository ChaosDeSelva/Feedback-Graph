import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';
import { ollamaEmbed } from '@fb/core';

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
  expect(names).toEqual(['check_before_done', 'get_module_context', 'get_task_context', 'impact', 'report_feedback', 'search_graph']);
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
