import type { HumanTurn, PostMortemInput, WorkSession } from '@fb/core';
import { expect, test } from 'vitest';
import { attachWorkSession } from './work.ts';

const turn: HumanTurn = { uuid: 'c1', sessionId: 'github:acme/demo#9', ts: '2026-10-02T10:00:00Z', index: 1, text: 'wrong', precedingAssistantText: '', precedingToolCalls: [] };
const external = {
  source: 'github' as const, kind: 'review_comment' as const, author: 'lead', url: 'u', thread: 'acme/demo#9', title: 't', threadUrl: 'u', path: null, line: null,
  diffHunk: null, branch: 'feat/search', createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: ['b'],
};
const input: PostMortemInput = { feedbackId: 'c1', projectKey: 'demo', repoPath: '/vibe/demo', cwd: '', sessionId: 'github:acme/demo#9', feedback: { ...turn, external }, turns: [turn], note: null, source: 'github' };
const ws = (id: string, edits = 2): WorkSession => ({ id, source: 'codex', gitBranch: 'feat/search', cwd: `/Users/j/${id}`, startedAt: null, lastActivityAt: null, edits, commits: 0 });

test('a transcript item is left alone', async () => {
  const plain = { ...input, feedback: turn };
  expect(await attachWorkSession(plain, { graph: { workSessions: async () => [] }, sessions: { turns: async () => [] } })).toBe(plain);
});

test('the linked session is preferred; its turns, cwd and agent stand in for the transcript', async () => {
  const work = [{ ...turn, uuid: 'w1', sessionId: 'b', index: 0, text: 'build search' }];
  const out = await attachWorkSession(input, { graph: { workSessions: async () => [ws('a'), ws('b')] }, sessions: { turns: async (id) => (id === 'b' ? work : []) } });
  expect(out).toMatchObject({ sessionId: 'b', cwd: '/Users/j/b', source: 'codex', work: { sessionId: 'b', turns: work } });
});

test('a link stored before to a session that only read is not followed: no work session, the comment alone', async () => {
  const stale = { ...input, feedback: { ...turn, external: { ...external, linkedSessionIds: ['review'] } } };
  const out = await attachWorkSession(stale, { graph: { workSessions: async () => [ws('review', 0)] }, sessions: { turns: async () => [turn] } });
  expect(out.work).toBeNull();
  expect(out.sessionId).toBe('github:acme/demo#9');
});

test('no session found: work is null', async () => {
  const out = await attachWorkSession(input, { graph: { workSessions: async () => [] }, sessions: { turns: async () => [] } });
  expect(out.work).toBeNull();
  expect(out.sessionId).toBe('github:acme/demo#9');
});

test('a session that never touched the file a review comment is on is not the work; the next one that did is', async () => {
  const onFile = { ...input, feedback: { ...turn, external: { ...external, path: 'api/search.ts', linkedSessionIds: [] } } };
  const files = async (id: string) => (id === 'a' ? ['src/settings/users.ts'] : id === 'b' ? ['api/search.ts', 'api/db.ts'] : []);
  const d = (list: WorkSession[]) => ({ graph: { workSessions: async () => list }, sessions: { turns: async () => [] }, files });
  expect((await attachWorkSession(onFile, d([ws('a'), ws('b')]))).work?.sessionId).toBe('b');
  const none = await attachWorkSession(onFile, d([ws('a')]));
  expect(none.work).toBeNull();
  expect(none.sessionId).toBe('github:acme/demo#9');
  expect(none.cwd).toBe('');
  // No files recorded for a session (read before files were): it is not ruled out.
  expect((await attachWorkSession(onFile, d([ws('c')]))).work?.sessionId).toBe('c');
});
