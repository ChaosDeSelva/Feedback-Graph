import { withMarkdown, type SessionDetail } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { SessionsDeps } from './sessions.ts';

const repo = { listCandidates: async () => [], stats: async () => [], candidateDetail: async () => null, decide: async () => {} } as unknown as ApiRepo;
const OP = 'o'.repeat(32);
const OWNER = 'owner-test-token-01234567890123456789';

const detail = (id: string, o: Partial<SessionDetail> = {}): SessionDetail => ({
  id, projectKey: 'demo', source: 'claude', cwd: '/vibe/demo', gitBranch: 'main', startedAt: 't0', lastActivityAt: 't1', turnCount: 2, state: 'idle',
  snippet: 'x', summarizedThrough: null, summaryUpdatedAt: null, summaryVersion: 1, pendingTurns: 0,
  summary: withMarkdown({ goal: 'g', done: [], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: '' }),
  summaryModel: null, history: [], rebuildRequested: false, prunedTurns: 0, summaryError: null, summaryRetryAt: null, inbox: [], ...o,
} as SessionDetail);

function app(store: Partial<SessionsDeps['store']> = {}) {
  const listed: unknown[] = [];
  const rebuilt: string[] = [];
  const sessions: Record<string, SessionDetail> = {
    mine: detail('mine', { sandbox: true, run: 'test-1' } as Partial<SessionDetail>),
    theirs: detail('theirs', { sandbox: true, run: 'test-2' } as Partial<SessionDetail>),
    one: detail('one', { prunedTurns: 1 }),
  };
  const a = createApp(repo, { auth: { ownerToken: OWNER, operator: { token: OP, allow: ['resummarize'] as never } }, sessions: { projects: () => ['demo'], inScope: () => true, store: {
    list: async (q) => { listed.push(q); return { sessions: [], next: null }; },
    detail: async (id) => sessions[id] ?? null,
    requestRebuild: async (id) => { rebuilt.push(id); return true; },
    ...store,
  } } });
  return { a, listed, rebuilt };
}
const labelled = (run: string, init: RequestInit = {}) => ({
  ...init, headers: { authorization: `Bearer ${OP}`, 'x-fg-run-key': 'session-registration-private-key-123456789', 'x-fg-run': run, 'x-fg-sandbox': '1', 'content-type': 'application/json' },
});
const owner = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' } };

test('registering a session refuses an id that is not a session id, and says so when the store cannot register runs', async () => {
  const { a } = app({ claimRun: async () => true });
  expect((await a.request('/api/sessions/has%20space/run', labelled('test-1', { method: 'POST', body: '{}' }))).status).toBe(400);
  const { a: noClaims } = app();
  const res = await noClaims.request('/api/sessions/s1/run', labelled('test-1', { method: 'POST', body: '{}' }));
  expect(res.status).toBe(503);
  expect((await res.json()).error).toBe('session run registration unavailable');
});

test('a labelled run lists only with its own run id, and sees its own sandboxed session but not another run\'s', async () => {
  const { a, listed } = app();
  await a.request('/api/sessions', labelled('test-1'));
  expect(listed).toEqual([expect.objectContaining({ run: 'test-1' })]);
  expect((await a.request('/api/sessions/mine', labelled('test-1'))).status).toBe(200);
  expect((await a.request('/api/sessions/theirs', labelled('test-1'))).status).toBe(404);
  expect((await a.request('/api/sessions/mine')).status).toBe(404);
});

test('another run cannot rebuild a sandboxed session, and one pruned turn is named in the singular', async () => {
  const { a, rebuilt } = app();
  expect((await a.request('/api/sessions/theirs/resummarize', owner)).status).toBe(404);
  const res = await a.request('/api/sessions/one/resummarize', owner);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/^1 turn of this session had/);
  expect(rebuilt).toEqual([]);
});

test('a run may rebuild its own sandboxed session', async () => {
  const { a, rebuilt } = app();
  expect((await a.request('/api/sessions/mine/resummarize', labelled('test-1', { method: 'POST', body: '{}' }))).status).toBe(202);
  expect(rebuilt).toEqual(['mine']);
});
