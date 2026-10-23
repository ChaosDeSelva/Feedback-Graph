import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const cand = { id: 'c1', projectKey: 'shop', classification: { label: 'pushback', confidence: 1 } };
const repo = {
  listCandidates: async () => [], stats: async () => [], decide: async () => {},
  candidateDetail: async () => ({ candidate: cand, turn: { text: 't' }, before: [], after: [], commits: [] }),
} as unknown as ApiRepo;
const lesson = { id: 'l1', projectKey: 'shop', title: 'T', rule: 'R', appliesWhen: 'W', scope: 'project', status: 'proposed' };
const app = createApp(repo, {
  knowledge: { listLessons: async () => [], lessonDetail: async () => ({ lesson }), updateLesson: async () => ({ unscoped: false }), retryPostmortem: async () => true } as never,
});
const req = (method: string, body: object, origin?: string) => ({
  method, body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
});

test('approving a lesson or deciding feedback needs the UI (a browser Origin); a bare local client is refused', async () => {
  expect((await app.request('/api/lessons/l1', req('PATCH', { status: 'approved' }))).status).toBe(403);
  expect((await app.request('/api/candidates/c1/decision', req('POST', { status: 'confirmed' }))).status).toBe(403);
  const body = await (await app.request('/api/lessons/l1', req('PATCH', { status: 'approved' }))).json();
  expect(body.error).toMatch(/only you can/i);
});

test('the same requests from the UI origin are accepted', async () => {
  expect((await app.request('/api/lessons/l1', req('PATCH', { status: 'approved' }, 'http://localhost'))).status).toBe(204);
  expect((await app.request('/api/candidates/c1/decision', req('POST', { status: 'confirmed' }, 'http://localhost'))).status).toBe(204);
});

test('a given-up post-mortem can be retried from the UI', async () => {
  expect((await app.request('/api/feedback/f1/retry', req('POST', {}, 'http://localhost'))).status).toBe(202);
  expect((await app.request('/api/feedback/f1/retry', req('POST', {}))).status).toBe(403);
});

test('turns the classifier gave up on are re-queued from the UI only, and the re-queue is logged', async () => {
  const logged: { kind: string; actor: string; subject: string }[] = [];
  let requeued = 0;
  const a = createApp(repo, {
    classifyQueue: { givenUpTurns: async () => 4, requeueGivenUpTurns: async () => { requeued++; return 4; } },
    activity: { record: async (e: { kind: string; actor: string; subject: string }) => { logged.push(e); }, list: async () => [] } as never,
  });
  expect((await a.request('/api/turns/requeue', req('POST', {}))).status).toBe(403);
  expect(requeued).toBe(0);
  const res = await a.request('/api/turns/requeue', req('POST', {}, 'http://localhost'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ requeued: 4 });
  expect(logged).toEqual([expect.objectContaining({ kind: 'turns_requeued', actor: 'you', subject: 're-queued 4 turns the classifier had given up on' })]);
});
