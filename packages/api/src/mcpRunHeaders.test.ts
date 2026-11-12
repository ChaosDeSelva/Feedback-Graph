import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';

// install-agent registers `X-FG-Run: ${FG_RUN:-}`, `X-FG-Sandbox: ${FG_SANDBOX:-0}` and `X-FG-Run-Key: ${FG_RUN_KEY:-}`
// with Claude Code at user scope, where it may send them as written. A reference left unexpanded, or an empty value,
// is a variable that was not set: an unlabelled request, never a 400.
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const ctx: ContextDeps = {
  roots: [{ host: '/Users/j/Vibe', container: '/vibe' }],
  embed: async (t) => t.map(() => [0]),
  k: { searchLessons: async () => [], missesNaming: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:9' },
  judge: async () => [],
};
const list = (headers: Record<string, string>) => ({
  method: 'POST',
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
});

test.each([
  ['unexpanded references', { 'x-fg-run': '${FG_RUN:-}', 'x-fg-sandbox': '${FG_SANDBOX:-0}', 'x-fg-run-key': '${FG_RUN_KEY:-}' }],
  ['empty values', { 'x-fg-run': '', 'x-fg-sandbox': '' }],
  ['a bare reference', { 'x-fg-run': '${FG_RUN}', 'x-fg-sandbox': '${FG_SANDBOX}' }],
])('/mcp treats %s in the run headers as unset', async (_what, headers) => {
  const res = await createApp(repo, { context: ctx }).request('/mcp', list(headers));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
});

test('a run header value that is neither set nor a reference is still refused', async () => {
  const app = createApp(repo, { context: ctx });
  expect((await app.request('/mcp', list({ 'x-fg-sandbox': 'maybe' }))).status).toBe(400);
  expect((await app.request('/mcp', list({ 'x-fg-run': 'has spaces' }))).status).toBe(400);
  expect((await app.request('/mcp', list({ 'x-fg-run': '${FG_RUN:-}', 'x-fg-sandbox': '1' }))).status).toBe(400);
});
