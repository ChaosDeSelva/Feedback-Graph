import { mcpDiscoveryOnly } from './storeWriteGuard.ts';
import { authorizeStoreWrite, type RunOwner } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { ContextDeps } from './context.ts';
const OP = 'operator-token-for-tests';
const KEY_A = 'c2ad856fb97403e18a2e7dc9015b6f438670dcaeb3219a845f0d7c8b6e109234';
const KEY_B = '983fb97403e18a2e7dc9015b6f438670dcaeb3219a845f0d7c8b6e109234c2ad856';
function fixture() {
  const owners = new Map<string, RunOwner>(); const writes: string[] = []; let sessionClaims = 0;
  const repo = { listCandidates: async () => [], stats: async () => [], candidateDetail: async () => null, decide: async () => { writes.push('decision'); } } as unknown as ApiRepo;
  const context: ContextDeps = { roots: [{ host: '/Users/test', container: '/repo' }], embed: async texts => texts.map(() => [1]), judge: async () => [], k: {
    searchLessons: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {},
    createManualFeedback: async input => { writes.push(input.text); if (input.text === 'fail after write') throw new Error('database failure'); return 'manual:1'; },
  } };
  const app = createApp(repo, { auth: { operator: { token: OP, allow: ['inbox_decide', 'lesson_decide'] } }, context, runs: {
    owner: async id => owners.get(id) ?? null, claim: async (run, principal, actor) => { await Promise.resolve(); if (!owners.has(run)) owners.set(run, { run, principal, actor: actor ?? null, firstSeen: 'now' }); return owners.get(run)!; },
    items: async () => [], remove: async () => ({} as never),
  }, sessions: { projects: () => [], inScope: () => true, store: { list: async () => ({ sessions: [], next: null }), detail: async () => null, requestRebuild: async () => false, claimRun: async () => { await authorizeStoreWrite(); sessionClaims++; return true; } } } });
  const request = (path: string, body: unknown, key = KEY_A) => app.request(path, { method: 'POST', headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${OP}`, 'x-fg-run': 'fresh', 'x-fg-run-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, request, owners, writes, context, sessionClaims: () => sessionClaims };
}
const tool = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('generic invalid-body400, unknown404 and missing-record404 do not reserve a run', async () => {
  const f = fixture();
  expect((await f.request('/api/candidates/decisions', { items: 'invalid' })).status).toBe(400);
  expect((await f.request('/api/not-a-route', {})).status).toBe(404);
  expect((await f.request('/api/candidates/missing/decision', { status: 'confirmed' })).status).toBe(404);
  expect(f.owners.size).toBe(0); expect(f.writes).toEqual([]);
});

test('unknown MCP tools and invalid known arguments never bind sessions or reserve owners', async () => {
  const f = fixture();
  for (const body of [tool('unknown-tool', { session_id: 'new-session' }), tool('get_task_context', { task: 42, session_id: 'new-session' }), tool('get_task_context', { cwd: '/Users/test/demo', task: 'fixture', session_id: '../../bad path' }), tool('get_task_context', { cwd: '/Users/test/demo', task: 'fixture', session_id: '' })]) {
    const result = await (await f.request('/mcp', body)).json();
    expect(result.error !== undefined || result.result?.isError === true).toBe(true);
  }
  expect(f.owners.size).toBe(0); expect(f.sessionClaims()).toBe(0); expect(f.writes).toEqual([]);
});

test('concurrent first writes from competing callers authorize one winner before domain mutation', async () => {
  const f = fixture();
  const body = tool('report_feedback', { cwd: '/Users/test/demo', feedback: 'synthetic miss', what_was_done: 'fixture' });
  const results = await Promise.all([f.request('/mcp', body, KEY_A), f.request('/mcp', body, KEY_B)]);
  const bodies = await Promise.all(results.map(result => result.clone().json()));
  expect(results.map(result => result.status).sort(), JSON.stringify({ bodies, writes: f.writes, ownerCount: f.owners.size })).toEqual([200, 409]);
  expect(f.owners.size).toBe(1); expect(f.writes).toEqual(['synthetic miss']);
});

test('a real mutation followed by an error keeps its established owner', async () => {
  const f = fixture();
  await f.request('/mcp', tool('report_feedback', { cwd: '/Users/test/demo', feedback: 'fail after write', what_was_done: 'fixture' }));
  expect(f.writes).toEqual(['fail after write']); expect(f.owners.size).toBe(1);
});

test('creating an app does not attach session callbacks to caller-owned shared context', () => {
  const f = fixture(); expect(f.context.registerSession).toBeUndefined();
});


test('valid SDK-validated session context authorizes and binds the actual session', async () => {
  const f = fixture();
  const response = await f.request('/mcp', tool('get_task_context', { cwd: '/Users/test/demo', task: 'inspect fixture', session_id: 'real-session' }));
  expect(response.status).toBe(200);
  expect(f.sessionClaims()).toBe(1); expect(f.owners.size).toBe(1);
});


test('only discovery bypasses lazy scope; unknown methods and mixed batches never do', () => {
  expect(mcpDiscoveryOnly({ method: 'initialize' })).toBe(true);
  expect(mcpDiscoveryOnly([{ method: 'initialize' }, { method: 'tools/list' }])).toBe(true);
  expect(mcpDiscoveryOnly([{ method: 'initialize' }, tool('report_feedback', {})])).toBe(false);
  expect(mcpDiscoveryOnly([tool('report_feedback', {})])).toBe(false);
  expect(mcpDiscoveryOnly({ method: 'unknown-method' })).toBe(false);
  expect(mcpDiscoveryOnly(null)).toBe(false);
});

test('SDK-rejected batch tool calls leave no run ownership or session binding', async () => {
  const f = fixture();
  const response = await f.request('/mcp', [tool('unknown-tool', { session_id: 'batch-session' })]);
  const result = await response.json();
  const messages = Array.isArray(result) ? result : [result];
  expect(messages.every(message => message.error !== undefined || message.result?.isError === true)).toBe(true);
  expect(f.owners.size).toBe(0); expect(f.sessionClaims()).toBe(0); expect(f.writes).toEqual([]);
});


test('valid batch tool mutations remain behind the same first-write ownership guard', async () => {
  const f = fixture();
  const first = tool('report_feedback', { cwd: '/Users/test/demo', feedback: 'batch first', what_was_done: 'fixture' });
  const second = { ...tool('report_feedback', { cwd: '/Users/test/demo', feedback: 'batch second', what_was_done: 'fixture' }), id: 2 };
  expect((await f.request('/mcp', [first, second])).status).toBe(200);
  expect(f.owners.size).toBe(1); expect(f.writes).toEqual(['batch first', 'batch second']);
});
