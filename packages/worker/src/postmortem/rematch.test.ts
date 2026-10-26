import type { ActivityInput, CommentLesson, ExternalRef, LessonCheck, PendingExternalItem, WorkSession } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { SESSION_MATCH_VERSION } from '../integrations/feedbackSync.ts';
import { rematchOnRuleChange, SESSION_MATCH_CURSOR } from './rematch.ts';

// acme/data-pipeline#12 (feat/batch-loader) was reviewed on 22 Oct. Nobody's session ran on that branch; the only session
// in the two days before the review built the web app's invite dialog, on main. The old rule took it.
const at = '2026-10-22T10:00:00Z';
const review = (o: Partial<ExternalRef> = {}): ExternalRef => ({
  source: 'github', kind: 'review', author: 'lead', url: 'u', thread: 'acme/data-pipeline#12', title: 'Batch loader', threadUrl: 'u',
  path: null, line: null, diffHunk: null, branch: 'feat/batch-loader', createdAt: at, linkedSessionIds: [], ...o,
});
const session = (id: string, gitBranch: string | null): WorkSession => ({ id, source: 'claude', gitBranch, cwd: '/Users/j/acme', startedAt: '2026-10-21T09:00:00Z', lastActivityAt: '2026-10-21T18:00:00Z', edits: 5, commits: 1 });
const edit = (path: string) => ({ path, edited: true });

function world(o: { sessions: WorkSession[]; files: Record<string, { path: string; edited: boolean }[]>; pending?: PendingExternalItem[]; lessons?: CommentLesson[] }) {
  const links: [string, string[]][] = [];
  const checks: [string, LessonCheck[]][] = [];
  const decided: [string, unknown, unknown][] = [];
  const activity: ActivityInput[] = [];
  const cursors = new Map<string, string>();
  const d = {
    graph: {
      workSessions: async (q: { branch: string | null }) => o.sessions.filter((s) => (q.branch ? s.gitBranch === q.branch : true)),
      pendingExternalItems: async (q: { limit: number; afterId?: string | null }) => (o.pending ?? []).filter((i) => !q.afterId || i.id > q.afterId).slice(0, q.limit),
      setExternalLinks: async (uuid: string, ids: string[]) => { links.push([uuid, ids]); return true; },
    },
    knowledge: {
      commentLessons: async (q: { limit: number; afterId?: string | null }) => (o.lessons ?? []).filter((l) => !q.afterId || l.id > q.afterId).slice(0, q.limit),
      setLessonChecks: async (id: string, c: LessonCheck[]) => { checks.push([id, c]); return true; },
      updateLesson: async (id: string, patch: unknown, opts: unknown) => { decided.push([id, patch, opts]); return { unscoped: false }; },
    },
    files: async (id: string) => o.files[id] ?? [],
    cursors: { getCursor: async (k: string) => cursors.get(k) ?? null, setCursor: async (k: string, v: string) => void cursors.set(k, v) },
    activity: { record: async (a: ActivityInput) => void activity.push(a) },
  };
  return { d, links, checks, decided, activity, cursors };
}

const lesson = (id: string, external: ExternalRef, o: Partial<CommentLesson> = {}): CommentLesson => ({
  id: `lesson:${id}`, feedbackId: id, projectKey: 'acme', text: 'The loader should stream rows; settings/users/invite.ts is unrelated.', external,
  checks: [], missed: 'reads the whole table', causeExplanation: 'implementation_error', ownerEdited: false, ...o,
});

describe('rematchOnRuleChange', () => {
  test('a proposed lesson worked out from the session the old rule borrowed is flagged wrong-session; one the new rule still matches is not', async () => {
    const ui = session('s-ui', 'main');
    const loader = session('s-loader', 'feat/batch-loader');
    const w = world({
      sessions: [ui],
      files: { 's-ui': [edit('src/settings/users/invite.ts')] },
      lessons: [lesson('github:acme/data-pipeline#12/review/77', review(), { checks: [{ name: 'needs-path', why: 'x' }] })],
    });
    const r = await rematchOnRuleChange(w.d);
    expect(r).toMatchObject({ flagged: 1 });
    expect(w.checks).toEqual([['lesson:github:acme/data-pipeline#12/review/77', [{ name: 'needs-path', why: 'x' }, { name: 'wrong-session', why: expect.stringContaining('s-ui') }]]]);

    // On the PR's branch: the old and the new rule agree, nothing is flagged.
    const ok = world({ sessions: [loader, ui], files: {}, lessons: [lesson('github:acme/data-pipeline#12/review/78', review())] });
    expect(await rematchOnRuleChange(ok.d)).toMatchObject({ flagged: 0 });
    expect(ok.checks).toEqual([]);
  });

  test('a lesson already flagged wrong-session is left as it is', async () => {
    const w = world({ sessions: [session('s-ui', 'main')], files: { 's-ui': [edit('src/settings/users/invite.ts')] }, lessons: [lesson('c1', review(), { checks: [{ name: 'wrong-session', why: 'earlier' }] })] });
    await rematchOnRuleChange(w.d);
    expect(w.checks).toEqual([]);
  });

  test('a proposed lesson whose own miss says there was none is rejected, by the post-mortem, with why', async () => {
    const w = world({ sessions: [], files: {}, lessons: [lesson('c2', review(), { missed: 'The agent did not miss any defects; the comment is an approval.' })] });
    expect(await rematchOnRuleChange(w.d)).toMatchObject({ rejected: 1 });
    expect(w.decided).toEqual([['lesson:c2', { status: 'rejected' }, { by: 'postmortem', note: expect.stringContaining('no miss') }]]);
  });

  test("one the owner already edited is never rejected: it is flagged no-miss for the owner, and Activity says so", async () => {
    const said = 'The agent did not miss any defects; the comment is an approval.';
    const w = world({ sessions: [], files: {}, lessons: [lesson('c3', review(), { missed: said, ownerEdited: true, checks: [{ name: 'needs-path', why: 'x' }] })] });
    expect(await rematchOnRuleChange(w.d)).toEqual({ relinked: 0, flagged: 0, rejected: 0, held: 1 });
    expect(w.decided).toEqual([]);
    expect(w.checks).toEqual([['lesson:c3', [{ name: 'needs-path', why: 'x' }, { name: 'no-miss', why: expect.stringContaining(said) }]]]);
    expect(w.activity[0]).toMatchObject({ subject: expect.stringMatching(/1 edited by you flagged no-miss/), targets: ['lesson:c3'] });
  });

  test('pending comments are matched again: a link the new rule does not make is removed, one it makes is set', async () => {
    const loader = session('s-loader', 'feat/batch-loader');
    const w = world({
      sessions: [loader, session('s-ui', 'main')],
      files: {},
      pending: [
        { id: 'k1', turnUuid: 't1', projectKey: 'acme', text: 'stream rows', external: review({ linkedSessionIds: [] }) },
        { id: 'k2', turnUuid: 't2', projectKey: 'acme', text: 'toast copy', external: review({ thread: 'acme/web#3', branch: 'feat/toast', linkedSessionIds: ['s-ui'] }) },
        { id: 'k3', turnUuid: 't3', projectKey: 'acme', text: 'again', external: review({ linkedSessionIds: ['s-loader'] }) },
      ],
    });
    const r = await rematchOnRuleChange(w.d);
    expect(w.links).toEqual([['t1', ['s-loader']], ['t2', []]]);
    expect(r).toMatchObject({ relinked: 2 });
  });

  test('runs once per rule version, logged in Activity; a failure leaves the version unrecorded', async () => {
    const w = world({ sessions: [session('s-ui', 'main')], files: { 's-ui': [edit('src/settings/users/invite.ts')] }, lessons: [lesson('c1', review())] });
    expect(await rematchOnRuleChange(w.d)).not.toBeNull();
    expect(w.cursors.get(SESSION_MATCH_CURSOR)).toBe(`v${SESSION_MATCH_VERSION}`);
    expect(w.activity).toEqual([expect.objectContaining({
      kind: 'sessions_rematched', actor: 'session-match', projectKey: null,
      subject: expect.stringMatching(/1 proposed lesson flagged wrong-session/),
      details: expect.objectContaining({ version: SESSION_MATCH_VERSION, flagged: 1, rejected: 0, relinked: 0 }),
      targets: ['lesson:c1'],
    })]);
    expect(await rematchOnRuleChange(w.d)).toBeNull();

    const broken = world({ sessions: [], files: {} });
    broken.d.graph.pendingExternalItems = async () => { throw new Error('db down'); };
    await expect(rematchOnRuleChange(broken.d)).rejects.toThrow('db down');
    expect(broken.cursors.has(SESSION_MATCH_CURSOR)).toBe(false);
  });

  test('nothing changed: the version is recorded and nothing is logged', async () => {
    const w = world({ sessions: [], files: {} });
    expect(await rematchOnRuleChange(w.d)).toEqual({ relinked: 0, flagged: 0, rejected: 0, held: 0 });
    expect(w.activity).toEqual([]);
    expect(w.cursors.get(SESSION_MATCH_CURSOR)).toBe(`v${SESSION_MATCH_VERSION}`);
  });
});
