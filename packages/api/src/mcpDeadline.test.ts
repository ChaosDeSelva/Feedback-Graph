import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const ctx = (embed: ContextDeps['embed']): ContextDeps => ({
  roots: [{ host: '/Users/j/Vibe', container: '/vibe' }],
  embed,
  k: { searchLessons: async () => [], missesNaming: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:9' },
  judge: async () => [],
});
const call = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task_context', arguments: { cwd: '/Users/j/Vibe/demo', task: 'search' } } }) };

test.each([
  ['a Postgres statement timeout', Object.assign(new Error('canceling statement due to statement timeout on db.internal'), { code: '57014' })],
  ['a store deadline', Object.assign(new Error('store work past db.internal deadline'), { name: 'StoreDeadlineError' })],
])('MCP: %s is a retryable tool result without the store details', async (_what, error) => {
  const app = createApp(repo, { context: ctx(async () => { throw error; }) });
  const body = (await (await app.request('/mcp', call)).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toBe('The graph request exceeded its deadline. Retry this tool call.');
});

// An Ollama that drops packets fails the connect after undici's 10 s with UND_ERR_CONNECT_TIMEOUT: that is the model,
// not the store, and the agent is told so instead of to retry a healthy graph.
test.each([
  ['an embedding model that cannot be reached in time', Object.assign(new Error('model unavailable: Ollama is not reachable at http://10.255.255.1:11434 (nomic-embed-text, UND_ERR_CONNECT_TIMEOUT): start it (ollama serve)'), { name: 'ProviderUnavailableError' }), /is unavailable \(model unavailable: Ollama is not reachable at http:\/\/10\.255\.255\.1:11434/],
  ['an embedding model that does not answer', Object.assign(new Error('Ollama (nomic-embed-text) did not answer within 120 s; raise OLLAMA_TIMEOUT_SECONDS'), { name: 'ModelTimeoutError' }), /did not answer in time \(Ollama \(nomic-embed-text\) did not answer within 120 s/],
])('MCP: %s is a tool error that names Ollama, not the graph store', async (_what, error, said) => {
  const app = createApp(repo, { context: ctx(async () => { throw error; }) });
  const body = (await (await app.request('/mcp', call)).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toMatch(said);
  expect(body.result.content[0].text).toMatch(/^The graph store is fine;/);
});
