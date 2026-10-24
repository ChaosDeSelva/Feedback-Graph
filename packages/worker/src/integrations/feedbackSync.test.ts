import { IntegrationError, Integrations, type ActivityInput, type ExternalThread, type LinearComment, type PrContext, type WorkSession } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { feedbackCursor, linkWorkSessions, prThread, syncExternalFeedback, type FeedbackSyncDeps, type SyncProject } from './feedbackSync.ts';

const NOW = new Date('2026-10-22T12:00:00Z');
const shop: SyncProject = { key: 'shop', name: 'shop', repoPath: '/vibe/shop', remote: 'github.com/acme/shop' };
const local: SyncProject = { key: 'notes', name: 'notes', repoPath: '/vibe/notes', remote: 'local/notes' };

const pr = (n: number, comments: { id: string; createdAt: string; body?: string; path?: string }[]): PrContext => ({
  repo: 'acme/shop', number: n, title: `PR ${n}`, url: `https://github.com/acme/shop/pull/${n}`, author: 'dev', state: 'open',
  updatedAt: '2026-10-22T11:00:00Z', headBranch: 'feat/cart', body: '',
  comments: comments.map((c) => ({
    id: c.id, author: 'lead', body: c.body ?? `comment ${c.id}`, path: c.path ?? null, line: c.path ? 4 : null,
    url: `https://github.com/acme/shop/pull/${n}#discussion_r${c.id}`, createdAt: c.createdAt, kind: c.path ? 'review_comment' : 'issue_comment', diffHunk: c.path ? '@@ +1 @@' : null,
  })),
});

function kv() {
  const m = new Map<string, string>();
  return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) };
}

function setup(o: { env?: Record<string, string>; prs?: () => Promise<PrContext[]>; linear?: () => Promise<LinearComment[]>; sessions?: WorkSession[]; projects?: SyncProject[] } = {}) {
  const store = kv();
  const integrations = new Integrations(store, o.env ?? { GITHUB_TOKEN: 'gh-token' });
  const threads: ExternalThread[] = [];
  const fetchCalls: { repo: string; since?: string }[] = [];
  const activity: ActivityInput[] = [];
  const deps: FeedbackSyncDeps = {
    integrations,
    graph: {
      upsertExternalThread: async (_p, t) => { threads.push(t); return t.items.length; },
      workSessions: async (q) => (o.sessions ?? []).filter((s) => (q.branch ? s.gitBranch === q.branch : true)),
    },
    cursors: store,
    projects: async () => o.projects ?? [shop, local],
    fetchPrs: async (f) => { fetchCalls.push({ repo: f.repo, since: f.since }); return o.prs ? o.prs() : [pr(7, [{ id: '1', createdAt: '2026-10-22T10:00:00Z', path: 'src/cart.ts' }])]; },
    fetchLinear: async () => (o.linear ? o.linear() : []),
    activity: { record: async (a) => void activity.push(a) },
    minIntervalMs: 10 * 60_000,
    now: () => NOW,
  };
  return { deps, store, integrations, threads, fetchCalls, activity };
}

describe('syncExternalFeedback', () => {
  test('syncs only tracked projects with a github.com remote; first sync looks back 14 days', async () => {
    const s = setup();
    expect(await syncExternalFeedback(s.deps)).toEqual({ github: 1, linear: 0 });
    expect(s.fetchCalls).toEqual([{ repo: 'acme/shop', since: '2026-10-08T12:00:00.000Z' }]);
    expect(s.threads[0].id).toBe('github:acme/shop#7');
    expect(s.threads[0].items[0]).toMatchObject({ uuid: 'github:acme/shop#7/review_comment/1', index: 1, external: { path: 'src/cart.ts', branch: 'feat/cart', author: 'lead' } });
    expect(s.store.m.get(feedbackCursor('github', 'shop'))).toBe(NOW.toISOString());
    const state = await s.integrations.sync('github');
    expect(state).toMatchObject({ lastSyncAt: NOW.toISOString(), lastError: null, projects: { shop: { items: 1, error: null, target: 'acme/shop' } } });
    expect(s.activity[0]).toMatchObject({ kind: 'feedback_synced', actor: 'github', projectKey: 'shop' });
  });

  test('nothing happens without a token; GITHUB_REPOS overrides the remote; a project switched off is skipped', async () => {
    const none = setup({ env: {} });
    expect(await syncExternalFeedback(none.deps)).toEqual({ github: 0, linear: 0 });
    expect(none.fetchCalls).toEqual([]);

    const s = setup({ projects: [shop, local] });
    s.deps.githubOverride = new Map([['notes', 'me/notes']]);
    await s.integrations.setLink('shop', { github: false });
    await syncExternalFeedback(s.deps);
    expect(s.fetchCalls.map((c) => c.repo)).toEqual(['me/notes']);
  });

  test('waits the interval between syncs, then passes the cursor', async () => {
    const s = setup();
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:55:00Z');
    await syncExternalFeedback(s.deps);
    expect(s.fetchCalls).toEqual([]);
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
    await syncExternalFeedback(s.deps);
    expect(s.fetchCalls).toEqual([{ repo: 'acme/shop', since: '2026-10-22T11:00:00Z' }]);
  });

  test('a revoked token stops the service until the token changes', async () => {
    let calls = 0;
    const s = setup({ prs: async () => { calls++; throw new IntegrationError('github 401: the token was rejected', 'auth'); } });
    await syncExternalFeedback(s.deps);
    const state = await s.integrations.sync('github');
    expect(state).toMatchObject({ errorKind: 'auth', lastError: expect.stringContaining('401') });
    expect(state.authFailedFor).toBeTruthy();
    expect(s.store.m.has(feedbackCursor('github', 'shop'))).toBe(false);
    await syncExternalFeedback(s.deps);
    expect(calls).toBe(1);
    s.deps.integrations = new Integrations(s.store, { GITHUB_TOKEN: 'new-token' });
    await syncExternalFeedback(s.deps);
    expect(calls).toBe(2);
  });

  test('a rate limit pauses the service until it lifts', async () => {
    let calls = 0;
    const s = setup({ prs: async () => { calls++; throw new IntegrationError('github 429 rate limit exceeded', 'rate_limit', '2026-10-22T13:00:00.000Z'); } });
    await syncExternalFeedback(s.deps);
    expect(await s.integrations.sync('github')).toMatchObject({ errorKind: 'rate_limit', rateLimitedUntil: '2026-10-22T13:00:00.000Z' });
    await syncExternalFeedback(s.deps);
    expect(calls).toBe(1);
    s.deps.now = () => new Date('2026-10-22T13:30:00Z');
    await syncExternalFeedback(s.deps);
    expect(calls).toBe(2);
  });

  test('another failure is recorded on the project and the cursor stays', async () => {
    const s = setup({ prs: async () => { throw new IntegrationError('github 404: not found', 'not_found'); } });
    await syncExternalFeedback(s.deps);
    const state = await s.integrations.sync('github');
    expect(state.projects.shop.error).toMatch(/404/);
    expect(state.errorKind).toBeNull();
    expect(s.store.m.has(feedbackCursor('github', 'shop'))).toBe(false);
  });

  test('Linear comments of the mapped team become one thread per issue', async () => {
    const comment = (id: string, issue: string, createdAt: string): LinearComment => ({
      id, author: 'Pat', body: `c ${id}`, url: `https://linear.app/c/${id}`, createdAt,
      issue: { id: issue, identifier: `ENG-${issue}`, title: `Issue ${issue}`, url: `https://linear.app/i/${issue}`, branch: `pat/eng-${issue}` },
    });
    const s = setup({ env: { LINEAR_API_KEY: 'lin' }, linear: async () => [comment('a', '1', '2026-10-21T00:00:00Z'), comment('b', '2', '2026-10-21T01:00:00Z'), comment('c', '1', '2026-10-21T02:00:00Z')] });
    await s.integrations.setLink('shop', { linearTeamId: 'team-1', linearTeamName: 'Web' });
    expect(await syncExternalFeedback(s.deps)).toEqual({ github: 0, linear: 3 });
    expect(s.threads.map((t) => [t.id, t.items.map((i) => i.index)])).toEqual([['linear:ENG-1', [1, 2]], ['linear:ENG-2', [1]]]);
    expect(s.threads[0].items[0].external).toMatchObject({ source: 'linear', kind: 'linear_comment', thread: 'ENG-1', branch: 'pat/eng-1' });
    expect(s.activity[0].subject).toContain('Linear team Web');
  });
});

describe('prThread', () => {
  test('indexes follow creation order over every comment, so a later sync keeps them; old comments stay out', () => {
    const p = pr(3, [{ id: 'b', createdAt: '2026-10-20T00:00:00Z' }, { id: 'a', createdAt: '2026-09-01T00:00:00Z' }]);
    const t = prThread(p, Date.parse('2026-10-01T00:00:00Z'), ['s1']);
    expect(t.items.map((i) => [i.uuid, i.index])).toEqual([['github:acme/shop#3/issue_comment/b', 2]]);
    expect(t.items[0].external.linkedSessionIds).toEqual(['s1']);
    expect(t.items[0].context).toContain('PR acme/shop#3 "PR 3"');
  });
});

describe('linkWorkSessions', () => {
  const ws = (id: string, gitBranch: string | null): WorkSession => ({ id, source: 'claude', gitBranch, cwd: '/x', startedAt: null, lastActivityAt: null });

  test('sessions on the branch win; else exactly one session in the window; several is none', async () => {
    const graph = (list: WorkSession[]) => ({
      upsertExternalThread: async () => 0,
      workSessions: async (q: { branch: string | null }) => list.filter((s) => (q.branch ? s.gitBranch === q.branch : true)),
    });
    expect(await linkWorkSessions(graph([ws('a', 'feat'), ws('b', 'main')]), 'shop', 'feat', NOW.toISOString())).toEqual(['a']);
    expect(await linkWorkSessions(graph([ws('b', 'main')]), 'shop', 'feat', NOW.toISOString())).toEqual(['b']);
    expect(await linkWorkSessions(graph([ws('b', 'main'), ws('c', 'x')]), 'shop', 'feat', NOW.toISOString())).toEqual([]);
  });
});
