import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { ADMIN_TOOLS } from './adminMcp.ts';
import { decision, fakeLoop } from './testing/loop.ts';
import type { OperatorVerb } from '@fb/core';

const OP = 'o'.repeat(32);
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

const proposed = decision('dec:p', { type: 'approve_lesson', tier: 'A', mode: 'propose', status: 'proposed', appliedAt: null, decidedAt: null, decidedBy: null, rationale: 'x'.repeat(300) });
const applied = decision('dec:a', { createdAt: '2026-11-08T00:00:00.000Z', targets: [{ kind: 'lesson', id: 'lesson:k', role: 'keeper' }] });
const bare = decision('dec:t', { type: 'tune_threshold', targets: [], createdAt: '2026-11-01T00:00:00.000Z', status: 'proposed', appliedAt: null });

function setup(allow: OperatorVerb[] = ['loop_decide', 'loop_settings']) {
  const loop = fakeLoop({ decisions: [proposed, applied, bare] });
  const app = createApp(repo, { loop: loop.deps, auth: { operator: { token: OP, allow } } });
  return { app, ...loop };
}

async function tool(app: ReturnType<typeof setup>['app'], name: string, args: object) {
  const res = await app.request('/mcp/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${OP}`, 'x-fg-operator': 'codex' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const r = ((await res.json()) as { result: { content: { text: string }[]; structuredContent?: Record<string, any>; isError?: boolean } }).result;
  return { ...r, text: r.content[0].text, data: r.structuredContent };
}

test('the loop tools are gated: reads need the token alone, decisions loop_decide, pause loop_settings', () => {
  expect(ADMIN_TOOLS).toMatchObject({ decisions_list: null, decision_get: null, loop_status: null, decision_decide: 'loop_decide', decision_rollback: 'loop_decide', decision_note: 'loop_decide', loop_pause: 'loop_settings' });
});

test('decisions_list: compact rows newest first, filtered and paged; decision_get and loop_status in full', async () => {
  const { app } = setup([]);
  const list = await tool(app, 'decisions_list', { limit: 1 });
  expect(list.data).toEqual({
    offset: 0, more: true, note: 'more: pass offset: 1 for the next page',
    items: [{ id: 'dec:p', type: 'approve_lesson', status: 'proposed', tier: 'A', mode: 'propose', projectKey: 'shop', target: 'lesson:1', confidence: proposed.confidence, rationale: `${'x'.repeat(239)}…`, createdAt: proposed.createdAt, decidedBy: null, score: expect.any(Number), scoreWhy: expect.stringContaining('approve_lesson') }],
  });
  const rest = await tool(app, 'decisions_list', { offset: 1 });
  expect(rest.data).toMatchObject({ offset: 1, more: false });
  expect(rest.data!.items.map((r: { id: string; target: string | null }) => [r.id, r.target])).toEqual([['dec:a', 'lesson:k'], ['dec:t', null]]);
  expect((await tool(app, 'decisions_list', { status: 'applied', q: 'never' })).data!.items.map((r: { id: string }) => r.id)).toEqual(['dec:a']);
  expect((await tool(app, 'decisions_list', { type: 'tune_threshold', project: 'shop', target: 'lesson:k', since: '2026-11-01T00:00:00Z' })).data!.items).toEqual([]);
  // since is an instant: an offset is read as one, and one no place has is refused before the API is asked.
  expect((await tool(app, 'decisions_list', { since: '2026-11-09T20:00:00+08:00' })).data!.items.map((r: { id: string }) => r.id)).toEqual(['dec:p']);
  expect(await tool(app, 'decisions_list', { since: '2026-11-10T12:00:00+99:00' })).toMatchObject({ isError: true, text: expect.stringMatching(/offset must be within ±14:00/) });
  expect((await tool(app, 'decision_get', { id: 'dec:a' })).data).toMatchObject({ decision: { id: 'dec:a' }, notes: [] });
  expect((await tool(app, 'decision_get', { id: 'dec:none' }))).toMatchObject({ isError: true, text: '404: no such decision' });
  // Only the operator token is configured: owner actions are read-only, so the loop is capped at observe.
  expect((await tool(app, 'loop_status', {})).data).toMatchObject({ mode: 'auto', effectiveMode: 'observe', capped: 'tokenless', counts: { proposed: 2 } });
});

test('decisions_list says why a read failed', async () => {
  const { app, fail } = setup([]);
  fail.store = new Error('down');
  expect(await tool(app, 'decisions_list', {})).toMatchObject({ isError: true, text: expect.stringMatching(/^503: the store did not answer/) });
});

test('decision_decide approves, rejects and keeps as the operator, expecting the status it reads when not told', async () => {
  const { app, decisions, entries, notes } = setup();
  const r = await tool(app, 'decision_decide', { id: 'dec:p', decision: 'approve', note: 'repeated twice' });
  expect(r.isError).toBeFalsy();
  expect(r.data).toMatchObject({ id: 'dec:p', status: 'applied', decidedBy: 'operator:codex' });
  expect(entries[0]).toMatchObject({ kind: 'decision_applied', actor: 'operator:codex' });
  expect(notes[0]).toMatchObject({ by: 'operator:codex', verdict: 'agree' });
  expect((await tool(app, 'decision_decide', { id: 'dec:a', decision: 'keep', expect: 'applied' })).data).toMatchObject({ ratifiedBy: 'operator:codex' });
  expect((await tool(app, 'decision_decide', { id: 'dec:t', decision: 'reject', reason: 'not_now', note: 'later' })).data).toMatchObject({ status: 'rejected' });
  expect(decisions.get('dec:t')!.decidedBy).toBe('operator:codex');
  // What it saw is stale: refused.
  expect(await tool(app, 'decision_decide', { id: 'dec:a', decision: 'keep', expect: 'proposed' })).toMatchObject({ isError: true, text: '409: it is applied now, not proposed: reload it' });
  expect(await tool(app, 'decision_decide', { id: 'dec:none', decision: 'keep' })).toMatchObject({ isError: true, text: '404: no such decision' });
});

test('decision_rollback previews unless apply, then rolls back with its reason; restore_anyway for an overridden one', async () => {
  const { app, decisions, calls } = setup();
  const preview = await tool(app, 'decision_rollback', { id: 'dec:a' });
  expect(preview.data).toEqual({ cascade: [], blocked: [] });
  expect(decisions.get('dec:a')!.status).toBe('applied');
  const done = await tool(app, 'decision_rollback', { id: 'dec:a', apply: true, reason: 'too_broad', note: 'too wide' });
  expect(done.data).toMatchObject({ status: 'rolled_back', rollback: { by: 'operator:codex', reason: 'too_broad', note: 'too wide' } });
  decisions.get('dec:a')!.status = 'overridden';
  await tool(app, 'decision_rollback', { id: 'dec:a', apply: true, restore_anyway: true, expect: 'overridden' });
  expect(calls.rollback.at(-1)).toEqual(['dec:a', { by: 'operator:codex', cascade: 'apply', restoreAnyway: true }]);
  expect(await tool(app, 'decision_rollback', { id: 'dec:none' })).toMatchObject({ isError: true, text: '404: no such decision' });
});

test('decision_note and loop_pause; without the verbs they are refused, naming the verb', async () => {
  const { app, notes, entries } = setup();
  expect((await tool(app, 'decision_note', { id: 'dec:a', text: 'too wide', verdict: 'disagree', reason: 'too_broad' })).data).toMatchObject({ by: 'operator:codex', verdict: 'disagree', reason: 'too_broad' });
  expect((await tool(app, 'decision_note', { id: 'dec:a', text: 'ok' })).data).toMatchObject({ verdict: null });
  expect(notes).toHaveLength(2);
  expect((await tool(app, 'loop_pause', {})).data).toMatchObject({ capped: 'paused', paused: { by: 'operator:codex' } });
  expect(entries.at(-1)).toMatchObject({ kind: 'loop_paused', actor: 'operator:codex' });
  const off = setup(['scan']);
  expect((await tool(off.app, 'decision_note', { id: 'dec:a', text: 'x' })).text).toMatch(/^403: .*loop_decide/);
  expect((await tool(off.app, 'loop_pause', {})).text).toMatch(/^403: .*loop_settings/);
  expect((await tool(off.app, 'decision_decide', { id: 'dec:a', decision: 'keep' })).text).toMatch(/^403: .*loop_decide/);
});
