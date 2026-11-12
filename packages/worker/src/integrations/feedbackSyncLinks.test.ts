import { IntegrationError, Integrations, type ExternalThread, type LinearComment, type PrContext } from '@fb/core';
import { expect, test } from 'vitest';
import { authorsCursor, feedbackCursor, linearThread, prThread, syncExternalFeedback, type FeedbackSyncDeps, type SyncProject } from './feedbackSync.ts';

const NOW = new Date('2026-10-22T12:00:00Z');
const shop: SyncProject = { key: 'shop', name: 'shop', repoPath: '/vibe/shop', remote: 'github.com/acme/shop' };
const comment = (id: string, createdAt: string, o: { path?: string; line?: number | null } = {}) => ({
  id, author: 'lead', body: `comment ${id}`, path: o.path ?? null, line: o.line ?? null, url: `u${id}`, createdAt, kind: o.path ? 'review_comment' as const : 'issue_comment' as const, diffHunk: null,
});
const pr = (n: number, o: Partial<PrContext> = {}): PrContext => ({
  repo: 'acme/shop', number: n, title: `PR ${n}`, url: `https://github.com/acme/shop/pull/${n}`, author: 'dev', state: 'open',
  updatedAt: '2026-10-22T11:00:00Z', headBranch: 'feat/cart', body: '', comments: [comment('1', '2026-10-22T10:00:00Z')], ...o,
});
const issue = { id: 'i1', identifier: 'ENG-1', title: 'Cart', url: 'u', branch: null, description: '', state: null, priority: null, labels: [], assignee: null };
const linear = (id: string, createdAt: string): LinearComment => ({ id, author: 'pm', body: `note ${id}`, url: `l${id}`, createdAt, issue });

function setup(env: Record<string, string> = { GITHUB_TOKEN: 'gh' }) {
  const m = new Map<string, string>();
  const store = { getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) };
  const integrations = new Integrations(store, env);
  const threads: ExternalThread[] = [];
  const logs: [string, object | undefined][] = [];
  const deps: FeedbackSyncDeps = {
    integrations,
    graph: { upsertExternalThread: async (_p, t) => { threads.push(t); return t.items.length; }, workSessions: async () => [] },
    cursors: store,
    projects: async () => [shop],
    fetchPrs: async () => [],
    fetchLinearIssues: async () => [],
    minIntervalMs: 60_000,
    now: () => NOW,
    log: (msg, x) => logs.push([msg, x]),
  };
  return { deps, m, integrations, threads, logs };
}

test('a PR comment with no branch, line or diff says only where it is', () => {
  const t = prThread(pr(1, { headBranch: null, comments: [comment('1', '2026-10-22T10:00:00Z', { path: 'src/a.ts' })] }), 0, []);
  expect(t.items[0].context).toBe('PR acme/shop#1 "PR 1" by dev (open)\nOn src/a.ts');
});

test('a Linear comment older than the window is left out, its later ones kept', () => {
  const t = linearThread([linear('a', '2026-10-01T00:00:00Z'), linear('b', '2026-10-21T00:00:00Z')], Date.parse('2026-10-10T00:00:00Z'), []);
  expect(t.items.map((i) => i.uuid)).toEqual(['linear:ENG-1/b']);
  expect(t.items[0].index).toBe(2);
});

test("a project limited to one author syncs only that author's pull requests, also when backfilling their state", async () => {
  const s = setup();
  await s.integrations.setLink('shop', { githubAuthor: 'Dev' });
  const refreshed: string[] = [];
  s.deps.graph.refreshExternalThreadState = async (id) => void refreshed.push(id);
  const asked: (string | undefined)[] = [];
  s.deps.fetchPrs = async (o) => {
    asked.push(o.author);
    const list = [pr(1), pr(2, { author: 'someone' })];
    if (o.metadataOnly) { for (const p of list) await o.onPr!(p); return list; } // the first one again: saved once
    return list;
  };
  await syncExternalFeedback(s.deps);
  expect(asked).toEqual(['Dev', 'Dev']);
  expect(refreshed).toEqual(['github:acme/shop#1']);
  expect(s.threads.map((t) => t.id)).toEqual(['github:acme/shop#1']);
});

test('an open PR with no new comments is skipped; a closed one is refreshed from its last comment, or its update time without any', async () => {
  const s = setup();
  s.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
  s.m.set(authorsCursor('shop'), '2026-10-22T11:00:00Z');
  const old = [comment('1', '2026-09-01T00:00:00Z')]; // before the look-back window
  s.deps.fetchPrs = async () => [pr(1, { comments: old }), pr(2, { state: 'closed', comments: old }), pr(3, { state: 'merged', comments: [] })];
  const windows: string[] = [];
  s.deps.graph.workSessions = async (q) => { if (q.branch) windows.push(q.before); return []; };
  await syncExternalFeedback(s.deps);
  expect(s.threads.map((t) => t.id)).toEqual(['github:acme/shop#2', 'github:acme/shop#3']);
  expect(windows).toEqual(['2026-09-01T00:00:00Z', '2026-10-22T11:00:00Z']);
});

test('PR state progress that is unreadable or of the wrong shape starts again from page 1', async () => {
  for (const saved of ['{oops', JSON.stringify({ page: 0, completed: 'x' })]) {
    const s = setup();
    s.m.set(feedbackCursor('github', 'shop'), '2026-10-20T00:00:00Z');
    s.m.set(authorsCursor('shop'), '2026-10-20T00:00:00Z');
    s.m.set('feedback-github-pr-state-v2:shop', saved);
    s.deps.graph.refreshExternalThreadState = async () => {};
    const pages: (number | undefined)[] = [];
    s.deps.fetchPrs = async (o) => { if (o.metadataOnly) pages.push(o.metadataPage); return []; };
    await syncExternalFeedback(s.deps);
    expect(pages).toEqual([1]);
    expect(s.m.get('feedback-github-pr-state-v2:shop')).toBe('done');
  }
});

test('a Linear team linked without its name is named by its id; an issue with no new comments adds nothing', async () => {
  const s = setup({ LINEAR_API_KEY: 'lin' });
  await s.integrations.setLink('shop', { github: false, linearTeamId: 'team-1' });
  s.m.set(feedbackCursor('linear', 'shop'), '2026-10-22T11:00:00Z');
  s.deps.fetchLinearIssues = async () => [{ ...issue, updatedAt: '2026-10-22T11:30:00Z', comments: [{ id: 'old', author: 'pm', body: 'x', url: 'l', createdAt: '2026-09-01T00:00:00Z' }] }];
  expect(await syncExternalFeedback(s.deps)).toEqual({ github: 0, linear: 0 });
  expect((await s.integrations.sync('linear')).projects.shop).toMatchObject({ target: 'team-1', error: null });
});

test('a rate limit that does not say when it lifts pauses the service for 15 minutes, and a failure is logged redacted', async () => {
  const s = setup();
  s.deps.fetchPrs = async () => { throw new IntegrationError('github 429', 'rate_limit'); };
  await syncExternalFeedback(s.deps);
  expect((await s.integrations.sync('github')).rateLimitedUntil).toBe('2026-10-22T12:15:00.000Z');
  expect(s.logs).toEqual([['github feedback sync failed', { projectKey: 'shop', kind: 'rate_limit', error: 'github 429' }]]);
});

test('something thrown that is not an Error is recorded as what it is', async () => {
  const s = setup();
  s.deps.fetchPrs = () => Promise.reject('socket closed');
  await syncExternalFeedback(s.deps);
  expect((await s.integrations.sync('github')).projects.shop.error).toBe('socket closed');
});

test('a project no longer tracked loses its sync state', async () => {
  const s = setup();
  await syncExternalFeedback(s.deps);
  expect((await s.integrations.sync('github')).projects.shop).toBeTruthy();
  s.deps.projects = async () => [];
  await syncExternalFeedback(s.deps);
  expect((await s.integrations.sync('github')).projects.shop).toBeUndefined();
});

test('on the wall clock, a first sync looks back from now', async () => {
  const s = setup();
  delete s.deps.now;
  const since: string[] = [];
  s.deps.fetchPrs = async (o) => { since.push(o.since!); return []; };
  const before = Date.now();
  await syncExternalFeedback(s.deps);
  expect(Date.parse(since[0])).toBeGreaterThanOrEqual(before - 14 * 86_400_000);
  expect(Date.parse(since[0])).toBeLessThanOrEqual(Date.now() - 14 * 86_400_000);
});
