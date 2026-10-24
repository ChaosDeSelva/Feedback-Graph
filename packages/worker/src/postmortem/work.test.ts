import type { HumanTurn, PostMortemInput, WorkSession } from '@fb/core';
import { expect, test } from 'vitest';
import { attachWorkSession } from './work.ts';

const turn: HumanTurn = { uuid: 'c1', sessionId: 'github:acme/demo#9', ts: '2026-10-02T10:00:00Z', index: 1, text: 'wrong', precedingAssistantText: '', precedingToolCalls: [] };
const external = {
  source: 'github' as const, kind: 'review_comment' as const, author: 'lead', url: 'u', thread: 'acme/demo#9', title: 't', threadUrl: 'u', path: null, line: null,
  diffHunk: null, branch: 'feat/search', createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: ['b'],
};
const input: PostMortemInput = { feedbackId: 'c1', projectKey: 'demo', repoPath: '/vibe/demo', cwd: '', sessionId: 'github:acme/demo#9', feedback: { ...turn, external }, turns: [turn], note: null, source: 'github' };
const ws = (id: string): WorkSession => ({ id, source: 'codex', gitBranch: 'feat/search', cwd: `/Users/j/${id}`, startedAt: null, lastActivityAt: null });

test('a transcript item is left alone', async () => {
  const plain = { ...input, feedback: turn };
  expect(await attachWorkSession(plain, { graph: { workSessions: async () => [] }, sessions: { turns: async () => [] } })).toBe(plain);
});

test('the linked session is preferred; its turns, cwd and agent stand in for the transcript', async () => {
  const work = [{ ...turn, uuid: 'w1', sessionId: 'b', index: 0, text: 'build search' }];
  const out = await attachWorkSession(input, { graph: { workSessions: async () => [ws('a'), ws('b')] }, sessions: { turns: async (id) => (id === 'b' ? work : []) } });
  expect(out).toMatchObject({ sessionId: 'b', cwd: '/Users/j/b', source: 'codex', work: { sessionId: 'b', turns: work } });
});

test('no session found: work is null', async () => {
  const out = await attachWorkSession(input, { graph: { workSessions: async () => [] }, sessions: { turns: async () => [] } });
  expect(out.work).toBeNull();
  expect(out.sessionId).toBe('github:acme/demo#9');
});
