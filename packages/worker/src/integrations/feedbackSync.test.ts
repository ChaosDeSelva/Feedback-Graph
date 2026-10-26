import { IntegrationError, Integrations, type ActivityInput, type ExternalThread, type LinearComment, type LinearTeamIssue, type PrContext, type WorkSession } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { authorsCursor, feedbackCursor, findWorkSessions, linkWorkSessions, prThread, syncExternalFeedback, type FeedbackSyncDeps, type SyncProject } from './feedbackSync.ts';

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

/** Comments back as the issues they are on, the way fetchLinearIssues answers. */
function issuesOf(comments: LinearComment[]): LinearTeamIssue[] {
  const by = new Map<string, LinearTeamIssue>();
  for (const { issue, ...c } of comments) {
    const i = by.get(issue.id) ?? { ...issue, updatedAt: c.createdAt, comments: [] };
    i.comments.push(c);
    by.set(issue.id, i);
  }
  return [...by.values()];
}

function setup(o: { env?: Record<string, string>; prs?: () => Promise<PrContext[]>; linear?: () => Promise<LinearComment[]>; issues?: () => Promise<LinearTeamIssue[]>; sessions?: WorkSession[]; projects?: SyncProject[] } = {}) {
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
    fetchLinearIssues: async () => (o.issues ? o.issues() : issuesOf(o.linear ? await o.linear() : [])),
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
    s.store.m.set(authorsCursor('shop'), '2026-10-21T00:00:00Z');
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
      issue: {
        id: issue, identifier: `ENG-${issue}`, title: `Issue ${issue}`, url: `https://linear.app/i/${issue}`, branch: `pat/eng-${issue}`,
        description: `Prices are integers in cents. key ghp_${'a'.repeat(36)}\n${'x'.repeat(5000)}`, state: 'In Progress', priority: 'High', labels: ['billing'], assignee: 'jo',
      },
    });
    const s = setup({ env: { LINEAR_API_KEY: 'lin' }, linear: async () => [comment('a', '1', '2026-10-21T00:00:00Z'), comment('b', '2', '2026-10-21T01:00:00Z'), comment('c', '1', '2026-10-21T02:00:00Z')] });
    await s.integrations.setLink('shop', { linearTeamId: 'team-1', linearTeamName: 'Web' });
    expect(await syncExternalFeedback(s.deps)).toEqual({ github: 0, linear: 3 });
    expect(s.threads.map((t) => [t.id, t.items.map((i) => i.index)])).toEqual([['linear:ENG-1', [1, 2]], ['linear:ENG-2', [1]]]);
    expect(s.threads[0].items[0].external).toMatchObject({ source: 'linear', kind: 'linear_comment', thread: 'ENG-1', branch: 'pat/eng-1' });
    // The ticket itself rides along, for the Inbox card and the post-mortem: redacted, clipped, with its details.
    const ext = s.threads[0].items[0].external;
    expect(ext.ticket).toEqual({ state: 'In Progress', priority: 'High', labels: ['billing'], assignee: 'jo' });
    expect(ext.description).toMatch(/^Prices are integers in cents\./);
    expect(ext.description).not.toContain('ghp_');
    expect(ext.description!.length).toBeLessThanOrEqual(4001);
  });

  test('a ticket\'s details are redacted and capped like its description', async () => {
    const long = 'y'.repeat(1000);
    const s = setup({ env: { LINEAR_API_KEY: 'lin' }, linear: async () => [{
      id: 'a', author: 'Pat', body: 'c', url: 'https://linear.app/c/a', createdAt: '2026-10-21T00:00:00Z',
      issue: { id: '1', identifier: 'ENG-1', title: 'T', url: 'https://linear.app/i/1', branch: null, description: '',
        state: long, priority: `ghp_${'a'.repeat(36)}`, labels: Array.from({ length: 50 }, (_, i) => `l${i}${'z'.repeat(200)}`), assignee: long },
    }] });
    await s.integrations.setLink('shop', { linearTeamId: 'team-1', linearTeamName: 'Web' });
    await syncExternalFeedback(s.deps);
    const t = s.threads[0].items[0].external.ticket!;
    expect(t.state!.length).toBeLessThanOrEqual(201);
    expect(t.assignee!.length).toBeLessThanOrEqual(201);
    expect(t.priority).not.toContain('ghp_');
    expect(t.labels).toHaveLength(20);
    expect(Math.max(...t.labels.map((l) => l.length))).toBeLessThanOrEqual(61);
    expect(s.activity[0].subject).toContain('Linear team Web');
  });
});

describe('Linear tickets as context', () => {
  const ticket = (id: string, comments: LinearTeamIssue['comments'], extra: Partial<LinearTeamIssue> = {}): LinearTeamIssue => ({
    id, identifier: `ENG-${id}`, title: `Issue ${id}`, url: `https://linear.app/acme/issue/ENG-${id}`, branch: `pat/eng-${id}`,
    description: `Prices are integers in cents. key ghp_${'a'.repeat(36)}`, state: 'In Progress', priority: 'High', labels: ['billing'], assignee: 'jo',
    updatedAt: '2026-10-21T00:00:00Z', comments, ...extra,
  });
  const said = (id: string, body: string): LinearTeamIssue['comments'][number] => ({ id, author: 'Pat', body, url: `https://linear.app/c/${id}`, createdAt: '2026-10-21T01:00:00Z' });

  function withDocs(issues: LinearTeamIssue[]) {
    const s = setup({ env: { LINEAR_API_KEY: 'x'.repeat(30) }, issues: async () => issues });
    const docs: { doc: { projectKey: string; source: string; ref: string; title: string; url: string | null }; chunks: { text: string; embedding: number[] }[] }[] = [];
    s.deps.docs = { upsertDoc: async (doc, chunks) => { docs.push({ doc, chunks }); return `doc:${doc.projectKey}:${doc.source}:${doc.ref}`; } };
    s.deps.embed = async (texts) => texts.map((_, i) => [i]);
    return { ...s, docs };
  }

  test('every issue of the mapped team updated in the window is stored as a document, with or without comments', async () => {
    const s = withDocs([ticket('1', [said('a', 'Totals must round half up.')]), ticket('2', [])]);
    await s.integrations.setLink('shop', { linearTeamId: 'team-1', linearTeamName: 'Web' });
    expect(await syncExternalFeedback(s.deps)).toEqual({ github: 0, linear: 1 });
    expect(s.docs.map((d) => d.doc)).toEqual([
      { projectKey: 'shop', source: 'linear', ref: 'linear:ENG-1', title: 'ENG-1: Issue 1', url: 'https://linear.app/acme/issue/ENG-1' },
      { projectKey: 'shop', source: 'linear', ref: 'linear:ENG-2', title: 'ENG-2: Issue 2', url: 'https://linear.app/acme/issue/ENG-2' },
    ]);
    const text = s.docs[0].chunks.map((c) => c.text).join('\n');
    expect(text).toContain('Linear ENG-1 (In Progress, High, billing): Issue 1');
    expect(text).toContain('Totals must round half up.');
    expect(text).not.toContain('ghp_');
    expect(s.docs[0].chunks.every((c) => c.embedding.length === 1)).toBe(true);
    // Only the comments go to the Inbox's classifier, as before; the issue without any is context alone.
    expect(s.threads.map((t) => t.id)).toEqual(['linear:ENG-1']);
    expect(s.activity.find((a) => a.kind === 'doc_added')).toMatchObject({ actor: 'linear', projectKey: 'shop', subject: 'synced 2 Linear tickets from Linear team Web', targets: ['doc:shop:linear:linear:ENG-1', 'doc:shop:linear:linear:ENG-2'] });
  });

  test('a later sync passes the cursor, so only issues updated since are read', async () => {
    const s = withDocs([ticket('1', [])]);
    const asked: { since: string }[] = [];
    s.deps.fetchLinearIssues = async (q) => { asked.push(q); return [ticket('1', [])]; };
    await s.integrations.setLink('shop', { linearTeamId: 'team-1', linearTeamName: 'Web' });
    s.store.m.set(feedbackCursor('linear', 'shop'), '2026-10-22T11:00:00Z');
    await syncExternalFeedback(s.deps);
    expect(asked.map((a) => a.since)).toEqual(['2026-10-22T11:00:00Z']);
  });

  test('a failure storing a ticket leaves the cursor, so the next sync reads the window again', async () => {
    const s = withDocs([ticket('1', [])]);
    s.deps.embed = async () => { throw new Error('embedder down'); };
    await s.integrations.setLink('shop', { linearTeamId: 'team-1', linearTeamName: 'Web' });
    await syncExternalFeedback(s.deps);
    expect(s.store.m.get(feedbackCursor('linear', 'shop'))).toBeUndefined();
    expect((await s.integrations.sync('linear')).projects.shop.error).toMatch(/embedder down/);
  });

  test('without a docs store, tickets are not stored and comments still sync', async () => {
    const s = setup({ env: { LINEAR_API_KEY: 'x'.repeat(30) }, issues: async () => [ticket('1', [said('a', 'Wrong rounding')])] });
    await s.integrations.setLink('shop', { linearTeamId: 'team-1', linearTeamName: 'Web' });
    expect(await syncExternalFeedback(s.deps)).toEqual({ github: 0, linear: 1 });
    expect(s.activity.some((a) => a.kind === 'doc_added')).toBe(false);
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

  // A data-pipeline PR reviewed with two inline comments and a summary that repeats them.
  const reviewed = (summary: string): PrContext => ({
    repo: 'acme/data-pipeline', number: 12, title: 'Batch loader', url: 'https://github.com/acme/data-pipeline/pull/12', author: 'dev', state: 'open',
    updatedAt: '2026-10-22T11:00:00Z', headBranch: 'feat/batch-loader', body: '', files: ['pipeline/load.py', 'pipeline/retry.py'],
    comments: [
      { id: '9', author: 'lead', body: 'The batch size is hard-coded to 500; read it from `PIPELINE_BATCH_SIZE`.', path: 'pipeline/load.py', line: 40, url: 'u9', createdAt: '2026-10-22T10:00:00Z', kind: 'review_comment', diffHunk: '@@', reviewState: 'CHANGES_REQUESTED' },
      { id: '10', author: 'lead', body: 'This retry loop never backs off, so a down warehouse gets hammered.', path: 'pipeline/retry.py', line: 12, url: 'u10', createdAt: '2026-10-22T10:00:01Z', kind: 'review_comment', diffHunk: '@@', reviewState: 'CHANGES_REQUESTED' },
      { id: '77', author: 'lead', body: summary, path: null, line: null, url: 'u77', createdAt: '2026-10-22T10:00:02Z', kind: 'review', diffHunk: null, reviewState: 'CHANGES_REQUESTED' },
    ],
  });

  test("a review summary that repeats its inline comments folds into them: it is marked, so the review-folded rule skips it", () => {
    const t = prThread(reviewed('Batch size is hard-coded to 500, read it from PIPELINE_BATCH_SIZE. The retry loop never backs off, so a down warehouse gets hammered.'), 0, []);
    const summary = t.items.find((i) => i.external.kind === 'review')!;
    expect(summary.external.foldedInto).toBe('github:acme/data-pipeline#12/review_comment/9');
    expect(t.items.filter((i) => i.external.kind === 'review_comment').every((i) => !i.external.foldedInto)).toBe(true);
  });

  test('a summary that says more than its inline comments stays its own item', () => {
    const t = prThread(reviewed('Besides the inline notes: the whole job should run inside one transaction, otherwise a failed batch leaves half an import behind.'), 0, []);
    expect(t.items.find((i) => i.external.kind === 'review')!.external.foldedInto ?? null).toBeNull();
  });

  test("each comment carries the files the PR changed, what a session is matched by", () => {
    const t = prThread(reviewed('x'), 0, []);
    expect(t.items.map((i) => i.external.prFiles)).toEqual(Array(3).fill(['pipeline/load.py', 'pipeline/retry.py']));
    expect(prThread(pr(3, [{ id: 'b', createdAt: '2026-10-20T00:00:00Z' }]), 0, []).items[0].external.prFiles ?? null).toBeNull();
  });
});

describe('linkWorkSessions', () => {
  const ws = (id: string, gitBranch: string | null, edits = 1, commits = 0): WorkSession => ({ id, source: 'claude', gitBranch, cwd: '/x', startedAt: null, lastActivityAt: null, edits, commits });
  const graph = (list: WorkSession[]) => ({
    upsertExternalThread: async () => 0,
    workSessions: async (q: { branch: string | null }) => list.filter((s) => (q.branch ? s.gitBranch === q.branch : true)),
  });

  const found = async (list: WorkSession[], branch: string | null) => (await findWorkSessions(graph(list), 'shop', branch, NOW.toISOString())).map((s) => [s.id, s.by]);

  test('sessions on the branch win; else the sessions that did work in the window, as candidates the post-mortem checks by their files', async () => {
    expect(await found([ws('a', 'feat'), ws('b', 'main')], 'feat')).toEqual([['a', 'branch']]);
    expect(await found([ws('b', 'main')], 'feat')).toEqual([['b', 'window']]);
    // Several in the window are all candidates now: none is picked for being nearest (postmortem/work.ts wants evidence).
    expect(await found([ws('b', 'main'), ws('c', null)], 'feat')).toEqual([['b', 'window'], ['c', 'window']]);
  });

  test('a session in the window on another feature branch is not a candidate', async () => {
    expect(await found([ws('other', 'feat/billing')], 'feat/cart')).toEqual([]);
    // Unknown, the default branch, or no branch to compare with: it may have been the work (the post-mortem asks for evidence).
    expect(await found([ws('u', null)], 'feat/cart')).toEqual([['u', 'window']]);
    expect(await found([ws('m', 'master')], 'feat/cart')).toEqual([['m', 'window']]);
    expect(await found([ws('o', 'feat/billing')], null)).toEqual([['o', 'window']]);
  });

  test("a PR from a default branch says nothing about which session did it: no branch match, only candidates", async () => {
    expect(await found([ws('m', 'main')], 'main')).toEqual([['m', 'window']]);
    expect(await linkWorkSessions(graph([ws('m', 'main')]), 'shop', 'main', NOW.toISOString())).toEqual([]);
  });

  test('the sync links only sessions on the branch: a match by time alone is not shown as the work', async () => {
    expect(await linkWorkSessions(graph([ws('a', 'feat'), ws('b', 'main')]), 'shop', 'feat', NOW.toISOString())).toEqual(['a']);
    expect(await linkWorkSessions(graph([ws('b', 'main')]), 'shop', 'feat', NOW.toISOString())).toEqual([]);
  });

  test('a session that only read (a security review on the branch) is never linked; one that only committed is', async () => {
    expect(await linkWorkSessions(graph([ws('review', 'feat', 0, 0)]), 'shop', 'feat', NOW.toISOString())).toEqual([]);
    expect(await found([ws('review', 'feat', 0, 0), ws('coder', 'main')], 'feat')).toEqual([['coder', 'window']]);
    expect(await linkWorkSessions(graph([ws('review', 'feat', 0, 0), ws('commit', 'feat', 0, 1)]), 'shop', 'feat', NOW.toISOString())).toEqual(['commit']);
  });
});

test('a PR comment carries the PR description, redacted and clipped; a PR without one has none', () => {
  const p = { ...pr(7, [{ id: '1', createdAt: '2026-10-22T10:00:00Z' }]), body: `## Why\nCheckout must keep cents. token ghp_${'b'.repeat(36)}\n${'y'.repeat(5000)}` };
  const ext = prThread(p, 0, []).items[0].external;
  expect(ext.description).toMatch(/^## Why\nCheckout must keep cents\./);
  expect(ext.description).not.toContain('ghp_');
  expect(ext.description!.length).toBeLessThanOrEqual(4001);
  expect(ext.ticket ?? null).toBeNull();
  expect(prThread({ ...p, body: '  ' }, 0, []).items[0].external.description).toBeNull();
});

test('a PR whose branch only had a review session syncs with no work session linked', async () => {
  const s = setup({ sessions: [{ id: 'review', source: 'claude', gitBranch: 'feat/cart', cwd: '/x', startedAt: null, lastActivityAt: null, edits: 0, commits: 0 }] });
  await syncExternalFeedback(s.deps);
  expect(s.threads[0].items[0].external.linkedSessionIds).toEqual([]);
});

test('a PR comment says who wrote it: the PR author, whether it is a thread reply, the review verdict and the author kind', () => {
  const base = pr(7, [{ id: '1', createdAt: '2026-10-22T10:00:00Z', path: 'src/cart.ts' }]);
  const comments = [
    { ...base.comments[0], author: 'dev', body: 'Fixed in 3f2a9c1', inReplyTo: '0', reviewState: 'COMMENTED' as const },
    { ...base.comments[0], id: '2', author: 'lead', body: '[P2] totals ignore discounts', reviewState: 'APPROVED' as const },
    { ...base.comments[0], id: '3', author: 'docs-check', body: 'Docs out of date (HIGH)' },
  ];
  const items = prThread({ ...base, comments }, 0, [], { botLogins: ['docs-check'] }).items.map((i) => i.external);
  expect(items[0]).toMatchObject({ threadAuthor: 'dev', isReply: true, reviewState: 'COMMENTED', authorKind: 'human' });
  expect(items[1]).toMatchObject({ isReply: false, reviewState: 'APPROVED', authorKind: 'agent' });
  expect(items[2]).toMatchObject({ authorKind: 'bot', reviewState: null });
});

test('a Linear comment is labelled by author kind too', async () => {
  const s = setup({
    env: { LINEAR_API_KEY: 'lin' },
    linear: async () => [{
      id: 'c1', author: 'jo', body: '[claude] the migration is missing', url: 'u', createdAt: '2026-10-21T00:00:00Z',
      issue: { id: 'i1', identifier: 'ENG-1', title: 'T', url: 'u', branch: null, description: '', state: null, priority: null, labels: [], assignee: null },
    }],
  });
  await s.integrations.setLink('shop', { linearTeamId: 'team-1', linearTeamName: 'Web' });
  await syncExternalFeedback(s.deps);
  expect(s.threads.flatMap((t) => t.items.map((i) => i.external.authorKind))).toEqual(['agent']);
});

test('the configured bot and agent logins reach the threads', async () => {
  const s = setup({ prs: async () => [{ ...pr(7, [{ id: '1', createdAt: '2026-10-22T10:00:00Z' }]), comments: [{ ...pr(7, [{ id: '1', createdAt: '2026-10-22T10:00:00Z' }]).comments[0], author: 'Review-Agent' }] }] });
  await syncExternalFeedback({ ...s.deps, agentLogins: ['review-agent'] });
  expect(s.threads[0].items[0].external.authorKind).toBe('agent');
});

test('a reply says whose comment it answers, so the PR author replying in their own thread is not taken for an answer to a reviewer', () => {
  const base = pr(8, [{ id: '1', createdAt: '2026-10-22T10:00:00Z', path: 'src/cart.ts' }]);
  const comments = [
    { ...base.comments[0], id: '10', author: 'dev', body: 'This still skips the tenant filter.' },
    { ...base.comments[0], id: '11', author: 'dev', body: 'And the test is missing, again.', inReplyTo: '10' },
    { ...base.comments[0], id: '12', author: 'lead', body: 'totals ignore discounts' },
    { ...base.comments[0], id: '13', author: 'dev', body: 'good catch, see the next commit', inReplyTo: '12' },
    { ...base.comments[0], id: '14', author: 'dev', body: 'answering something older', inReplyTo: '999' },
  ];
  const items = prThread({ ...base, author: 'dev', comments }, 0, []).items.map((i) => i.external);
  expect(items.map((e) => e.repliesTo ?? null)).toEqual([null, 'dev', null, 'lead', null]);
});

describe('comments synced before their authors were kept', () => {
  // PR 9 by dev: lead's review comment (9 days ago), and dev's "Fixed in" reply to it, already in the Inbox as pending.
  const old = (): PrContext => {
    const p = pr(9, [{ id: '1', createdAt: '2026-10-13T10:00:00Z', path: 'src/cart.ts' }]);
    return { ...p, comments: [p.comments[0], { ...p.comments[0], id: '2', author: 'dev', body: 'Fixed in ada836b. The cart now keeps cents.', inReplyTo: '1', createdAt: '2026-10-13T11:00:00Z' }] };
  };
  const reply = 'github:acme/shop#9/review_comment/2';

  test('the next sync fetches the last 14 days again once, so stored comments get their author details', async () => {
    const s = setup({ prs: async () => [old()] });
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
    await syncExternalFeedback(s.deps);
    expect(s.fetchCalls).toEqual([{ repo: 'acme/shop', since: '2026-10-08T12:00:00.000Z' }]);
    expect(s.threads[0].items.find((i) => i.uuid === reply)?.external).toMatchObject({ threadAuthor: 'dev', isReply: true, repliesTo: 'lead', authorKind: 'human' });
    // Once: later syncs go on from the cursor.
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
    await syncExternalFeedback(s.deps);
    expect(s.fetchCalls[1]).toEqual({ repo: 'acme/shop', since: '2026-10-22T11:00:00Z' });
  });

  test('a backfill that fails waits the sync interval before the whole window again, and is given up after three tries', async () => {
    let fail = true;
    const s = setup({ prs: async () => { if (fail) throw new IntegrationError('github 502: bad gateway', 'network'); return [old()]; } });
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
    const at = (iso: string) => { s.deps.now = () => new Date(iso); };
    await syncExternalFeedback(s.deps);
    // Within the interval: the next cycle only fetches from the cursor (cheap), not the 14 days again; that incremental
    // sync working does not count as the backfill.
    at('2026-10-22T12:01:00Z');
    fail = false;
    await syncExternalFeedback(s.deps);
    fail = true;
    expect(s.fetchCalls.map((c) => c.since)).toEqual(['2026-10-08T12:00:00.000Z', '2026-10-22T11:00:00Z']);
    expect(s.store.m.get(authorsCursor('shop'))).toBeUndefined();
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
    // Two more failed backfills, an interval apart, and it stops trying: the next syncs are incremental.
    at('2026-10-22T12:20:00Z');
    await syncExternalFeedback(s.deps);
    at('2026-10-22T12:40:00Z');
    await syncExternalFeedback(s.deps);
    expect(s.fetchCalls.filter((c) => c.since?.startsWith('2026-10-0'))).toHaveLength(3);
    expect(s.store.m.get(authorsCursor('shop'))).toBeTruthy();
    fail = false;
    at('2026-10-22T13:00:00Z');
    await syncExternalFeedback(s.deps);
    expect(s.fetchCalls.at(-1)?.since).toBe('2026-10-22T11:00:00Z');
  });

  test('a first sync already has them: no second fetch', async () => {
    const s = setup({ prs: async () => [old()] });
    await syncExternalFeedback(s.deps);
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
    await syncExternalFeedback(s.deps);
    expect(s.fetchCalls.map((c) => c.since)).toEqual(['2026-10-08T12:00:00.000Z', '2026-10-22T11:00:00Z']);
  });

  test('pending Inbox items that a skip rule matches once their authors are known are skipped, with the rule as the reason', async () => {
    const s = setup({ prs: async () => [old()] });
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
    const skipped: { id: string; rule: string }[] = [];
    // Both comments are pending in the Inbox; the store holds what the backfill just rewrote.
    s.deps.graph = {
      ...s.deps.graph,
      pendingExternalItems: async (q) => (q.afterId ? [] : s.threads.flatMap((t) => t.items.map((i) => ({ id: i.uuid, turnUuid: i.uuid, projectKey: 'shop', text: i.text, external: i.external })))),
      skipPendingItem: async (id, r) => { skipped.push({ id, rule: r.rule }); return true; },
    };
    await syncExternalFeedback(s.deps);
    expect(skipped).toEqual([{ id: reply, rule: 'pr-author-reply' }]);
    const note = s.activity.find((a) => a.kind === 'comments_skipped');
    expect(note).toMatchObject({ projectKey: 'shop', targets: [reply], details: { rules: { 'pr-author-reply': 1 }, pending: 1 } });
    expect(note?.why).toMatch(/author details/);
  });

  test('an incremental sync does not look at the pending items again', async () => {
    const s = setup({ prs: async () => [old()] });
    s.store.m.set(feedbackCursor('github', 'shop'), '2026-10-22T11:00:00Z');
    s.store.m.set(authorsCursor('shop'), '2026-10-20T11:00:00Z');
    let asked = 0;
    s.deps.graph = { ...s.deps.graph, pendingExternalItems: async () => { asked++; return []; }, skipPendingItem: async () => true };
    await syncExternalFeedback(s.deps);
    expect(asked).toBe(0);
  });
});
