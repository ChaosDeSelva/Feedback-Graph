import { afterEach, expect, test, vi } from 'vitest';
import { fetchPullRequestContext, githubRepoOfRemote, githubViewer } from './github.ts';
import { fetchLinearIssues, linearViewer, listLinearTeams, searchLinearIssues } from './linear.ts';

afterEach(() => vi.unstubAllGlobals());

/** The global fetch, answering by path and recording what was asked. */
function globalFetch(answer: (url: URL, body: string) => unknown) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    calls.push(input);
    return Response.json(answer(new URL(input), String(init?.body ?? '')));
  });
  return calls;
}

test('GitHub reads go through the global fetch when given none', async () => {
  const calls = globalFetch((url) => (url.pathname === '/user' ? { login: 'alice' } : []));
  expect(await githubViewer({ token: 't' })).toEqual({ login: 'alice' });
  expect(await fetchPullRequestContext({ repo: 'acme/demo', token: 't' })).toEqual([]);
  expect(calls.map((c) => new URL(c).pathname)).toEqual(['/user', '/repos/acme/demo/pulls']);
});

test('Linear reads go through the global fetch when given none; search takes ten issues by default', async () => {
  const bodies: string[] = [];
  globalFetch((_url, body) => {
    bodies.push(body);
    const q = JSON.parse(body) as { query: string };
    if (q.query.includes('searchIssues')) return { data: { searchIssues: { nodes: [] } } };
    if (q.query.includes('viewer')) return { data: { viewer: { name: 'Ann' }, organization: null } };
    if (q.query.includes('teams(')) return { data: { teams: { nodes: [] } } };
    return { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
  });
  expect(await searchLinearIssues({ apiKey: 'k', query: 'checkout' })).toEqual([]);
  expect(JSON.parse(bodies[0]).variables).toEqual({ term: 'checkout', first: 10 });
  expect(await linearViewer({ apiKey: 'k' })).toEqual({ name: 'Ann', organization: null });
  expect(await listLinearTeams({ apiKey: 'k' })).toEqual([]);
  expect(await fetchLinearIssues({ apiKey: 'k', teamId: 't', since: '2026-10-01T00:00:00Z' })).toEqual([]);
});

test('a Linear comment from a deleted user is by "unknown"; an empty one is left out', async () => {
  const fetchImpl = (async () => Response.json({ data: { searchIssues: { nodes: [{
    identifier: 'ENG-1', title: 'T', url: 'u', updatedAt: '2026-10-01', comments: { nodes: [{ body: 'still broken', user: null }, { body: '  ' }, { body: null }] },
  }] } } })) as unknown as typeof fetch;
  const [issue] = await searchLinearIssues({ apiKey: 'k', query: 'q', fetchImpl });
  expect(issue.comments).toEqual([{ author: 'unknown', body: 'still broken' }]);
});

test('a github.com remote whose owner or name GitHub would not accept is not a repo', () => {
  expect(githubRepoOfRemote('github.com/acme/demo')).toBe('acme/demo');
  expect(githubRepoOfRemote('github.com/ac me/demo')).toBeNull();
});

test('a page that fills the PR cap exactly is the last one read', async () => {
  const pull = (n: number) => ({ number: n, title: `PR ${n}`, html_url: `https://github.com/acme/demo/pull/${n}`, user: { login: 'alice' }, state: 'open', updated_at: '2026-10-20T00:00:00Z' });
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    calls.push(input);
    return Response.json(new URL(input).pathname === '/repos/acme/demo/pulls' ? [pull(1), pull(2)] : [], { headers: { link: '<https://api.github.com/repos/acme/demo/pulls?page=2>; rel="next"' } });
  }) as unknown as typeof fetch;
  const prs = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl, maxPrs: 2, metadataOnly: true });
  expect(prs.map((p) => p.number)).toEqual([1, 2]);
  expect(calls.filter((c) => new URL(c).pathname === '/repos/acme/demo/pulls')).toHaveLength(1);
});

test('review comments and reviews with a deleted author, no place in the diff, or a link and time', async () => {
  const fetchImpl = (async (input: string) => {
    const path = new URL(input).pathname;
    if (path === '/repos/acme/demo/pulls') return Response.json([{ number: 1, title: 'T', html_url: 'h', user: { login: 'alice' }, state: 'open', updated_at: '2026-10-20T00:00:00Z' }]);
    if (path === '/repos/acme/demo/pulls/1/comments') return Response.json([{ id: 7, in_reply_to_id: null, pull_request_review_id: null, user: null, body: 'outdated now', html_url: 'u7', created_at: 'c' }]);
    if (path === '/repos/acme/demo/pulls/1/reviews') return Response.json([{ id: 9, state: 'COMMENTED', user: null, body: 'see inline', html_url: 'u9', submitted_at: 's9' }]);
    return Response.json([]);
  }) as unknown as typeof fetch;
  const [pr] = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl, includeFiles: false });
  expect(pr.comments).toEqual([
    { id: '7', author: 'ghost', body: 'outdated now', path: null, line: null, url: 'u7', createdAt: 'c', kind: 'review_comment', diffHunk: null },
    expect.objectContaining({ id: '9', author: 'ghost', url: 'u9', createdAt: 's9', kind: 'review' }),
  ]);
});
