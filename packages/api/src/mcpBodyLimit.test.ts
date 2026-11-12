import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';

// check_before_done takes a diff of up to 900,000 characters. Sent as JSON, each control character is 6 bytes
// (\u0001): the body cap on /mcp must let every call the schema allows reach the tool, and one past the schema's
// limit come back as a tool error naming the argument, never a 413 before the arguments are read.
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const ctx: ContextDeps = {
  roots: [{ host: '/Users/j/Vibe', container: '/vibe' }],
  embed: async (t) => t.map(() => [0]),
  k: { searchLessons: async () => [], missesNaming: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:9' },
  judge: async () => [],
};
const check = (diff: string) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_before_done', arguments: { cwd: '/Users/j/Vibe/demo', task: 't'.repeat(8000), summary: '\u0001'.repeat(20_000), diff, files_changed: Array.from({ length: 50 }, (_, i) => `${'\u0001'.repeat(990)}${i}.ts`) } } });
  return { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(Buffer.byteLength(body)) } };
};

test('a check_before_done with every argument at its limit, all escaped, reaches the tool', async () => {
  const app = createApp(repo, { context: ctx });
  const req = check('\u0001'.repeat(900_000));
  expect(Number(req.headers['content-length'])).toBeGreaterThan(5_000_000);
  const res = await app.request('/mcp', req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { content: { text: string }[] } };
  expect(body.result?.content[0].text).not.toMatch(/too large|too_big/);
});

test('a diff one character past the limit is a tool error naming diff, not a 413', async () => {
  const app = createApp(repo, { context: ctx });
  const res = await app.request('/mcp', check('\u0001'.repeat(900_001)));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toMatch(/diff/);
});
