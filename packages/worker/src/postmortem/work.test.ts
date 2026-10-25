import type { ExternalRef, HumanTurn, PostMortemInput, WorkSession } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { attachWorkSession } from './work.ts';

const turn: HumanTurn = { uuid: 'c1', sessionId: 'github:acme/demo#9', ts: '2026-10-02T10:00:00Z', index: 1, text: 'wrong', precedingAssistantText: '', precedingToolCalls: [] };
const external: ExternalRef = {
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
  const files = async (id: string) => (id === 'a' ? [read('src/settings/users.ts')] : id === 'b' ? [read('api/search.ts'), edit('api/db.ts')] : []);
  const d = (list: WorkSession[]) => ({ graph: { workSessions: async () => list }, sessions: { turns: async () => [] }, files });
  expect((await attachWorkSession(onFile, d([ws('a'), ws('b')]))).work?.sessionId).toBe('b');
  const none = await attachWorkSession(onFile, d([ws('a')]));
  expect(none.work).toBeNull();
  expect(none.sessionId).toBe('github:acme/demo#9');
  expect(none.cwd).toBe('');
  // No files recorded for a session on the PR's branch (read before files were): it is not ruled out.
  expect((await attachWorkSession(onFile, d([ws('c')]))).work?.sessionId).toBe('c');
});

const read = (path: string) => ({ path, edited: false });
const edit = (path: string) => ({ path, edited: true });

describe('a session found by time alone (none on the PR branch) needs evidence it did this work', () => {
  // Nothing on the PR's branch; one session that did work in the two days before the comment, on main.
  const near = (s: WorkSession) => ({ workSessions: async (q: { branch: string | null }) => (q.branch ? [] : [s]) });
  const onMain = (id: string): WorkSession => ({ ...ws(id), gitBranch: 'main' });
  const deps = (s: WorkSession, files: Record<string, { path: string; edited: boolean }[]>) => ({ graph: near(s), sessions: { turns: async () => [] }, files: async (id: string) => files[id] ?? [] });
  const comment = (extra: Partial<ExternalRef>, text = 'wrong') => ({ ...input, feedback: { ...turn, text, external: { ...external, linkedSessionIds: [], ...extra } } });

  test('a review comment: only when the session edited the commented file (reading it is not doing it)', async () => {
    const c = comment({ path: 'api/search.ts' });
    expect((await attachWorkSession(c, deps(onMain('w'), { w: [edit('api/search.ts')] }))).work?.sessionId).toBe('w');
    expect((await attachWorkSession(c, deps(onMain('w'), { w: [read('api/search.ts'), edit('src/settings/users/invite.ts')] }))).work).toBeNull();
  });

  test('no files recorded is no evidence: the comment is worked out alone', async () => {
    expect((await attachWorkSession(comment({ path: 'api/search.ts' }), deps(onMain('w'), {}))).work).toBeNull();
  });

  test('a review or issue comment with no file: only when the comment, its diff or the description names a file the session edited', async () => {
    const files = { w: [edit('src/settings/users/invite.ts')] };
    expect((await attachWorkSession(comment({ kind: 'review' }, 'Atlas partial hashes in cmd/migrate/main.go'), deps(onMain('w'), files))).work).toBeNull();
    expect((await attachWorkSession(comment({ kind: 'review', description: 'Fixes the error in settings/users/invite.ts' }), deps(onMain('w'), files))).work?.sessionId).toBe('w');
  });

  test('without a files lookup at all, a time-only match is not trusted', async () => {
    const out = await attachWorkSession(comment({ path: 'api/search.ts' }), { graph: near(onMain('w')), sessions: { turns: async () => [] } });
    expect(out.work).toBeNull();
  });
});
