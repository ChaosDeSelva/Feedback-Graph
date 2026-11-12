import type { SessionDetail } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

test('session evidence: an Inbox item with no lesson yet shows none, and the agent\'s own report on it', async () => {
  const session = {
    id: 's1', projectKey: 'demo', source: 'claude', state: 'idle', turnCount: 2, lastActivityAt: 't', startedAt: 't',
    inbox: [{ id: 's1-t1', status: 'pending', label: 'pushback', summary: 'wrong currency', lessonId: null, lessonStatus: null }],
  } as unknown as SessionDetail;
  const app = createApp(repo, { evidence: {
    sessions: { detail: async () => session, turnEvidence: async () => [] },
    inScope: () => true,
    candidateDetail: async (id) => ({
      candidate: { id, projectKey: 'demo', status: 'pending', decidedBy: null, decidedAt: null, note: null, origins: ['agent'], agentReport: { text: 'I used USD', whatWasDone: 'formatted totals', reportedAt: 't', session: 'private' } },
      turn: {}, before: [], after: [], commits: [], postmortem: null,
    }) as never,
    lessonDetail: async () => { throw new Error('no lesson to read'); },
  } });
  const e = (await (await app.request('/api/sessions/s1/evidence')).json()) as Record<string, any>;
  expect(e.inbox).toEqual([expect.objectContaining({
    id: 's1-t1', lesson: null, miss: null, postmortem: null, origins: ['agent'],
    agentReport: { text: 'I used USD', whatWasDone: 'formatted totals', reportedAt: 't' },
  })]);
});
