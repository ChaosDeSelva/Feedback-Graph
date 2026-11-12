import { describe, expect, test } from 'vitest';
import { fetchPullRequestContext, githubViewer, parsePrBacklog, prBacklogKey, prContextToChunks, type PrContext } from './github.ts';

const API = 'https://api.github.com';
/** A fetch answering by path (`?page=N` included when present); unknown paths are empty lists. */
function routes(map: Record<string, (url: URL) => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    calls.push(input);
    const url = new URL(input);
    const r = map[url.pathname + (url.searchParams.has('page') ? `?page=${url.searchParams.get('page')}` : '')] ?? map[url.pathname];
    return r ? r(url) : Response.json([]);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const json = (v: unknown, headers: Record<string, string> = {}) => () => Response.json(v, { headers });
const pull = (n: number, extra: object = {}) => ({ number: n, title: `PR ${n}`, html_url: `https://github.com/acme/demo/pull/${n}`, user: { login: 'alice' }, state: 'open', updated_at: '2026-10-20T00:00:00Z', ...extra });
const viewerError = async (r: Response) => githubViewer({ token: 'tok', fetchImpl: (async () => r) as unknown as typeof fetch }).then(() => null, (e) => e);

describe('GitHub failures are classified so a sync knows whether to stop, wait or retry', () => {
  test('a 403 without a rate limit is a token without access; a 5xx is other', async () => {
    expect(await viewerError(new Response('Resource not accessible by personal access token', { status: 403 })))
      .toMatchObject({ kind: 'auth', message: expect.stringMatching(/^github 403: the token cannot read this/) });
    expect(await viewerError(new Response('boom', { status: 502 }))).toMatchObject({ kind: 'other', message: 'github 502: boom' });
  });

  test('a 403 that says "rate limit" is a rate limit, with or without a time it lifts', async () => {
    const secondary = await viewerError(new Response('You have exceeded a secondary rate limit', { status: 403 }));
    expect(secondary).toMatchObject({ kind: 'rate_limit', retryAt: null, message: 'github 403 rate limit exceeded: You have exceeded a secondary rate limit' });
    const bad = await viewerError(new Response('x', { status: 429, headers: { 'x-ratelimit-reset': 'later', 'retry-after': '0' } }));
    expect(bad).toMatchObject({ kind: 'rate_limit', retryAt: null });
  });
});

describe('fetchPullRequestContext edges', () => {
  test('comments without ids take them from their links (or their position), and missing fields read as empty', async () => {
    const hunk = `@@ -1 +1 @@\n${'x'.repeat(2000)}END`;
    const { fetchImpl } = routes({
      '/repos/acme/demo/pulls': json([pull(1, { body: null, head: null })]),
      '/repos/acme/demo/pulls/1/comments': json([
        { user: { login: 'bob' }, body: 'cents', path: 'a.ts', original_line: 7, diff_hunk: hunk, html_url: 'https://github.com/acme/demo/pull/1#discussion_r77', created_at: 'c1', pull_request_review_id: 999 },
      ]),
      '/repos/acme/demo/issues/1/comments': json([
        { user: null, body: 'from a deleted account', html_url: 'https://github.com/acme/demo/pull/1', created_at: 'c2' },
      ]),
      '/repos/acme/demo/pulls/1/reviews': json([
        { id: 5, state: 'pending_magic', user: { login: 'carol' }, body: 'looks fine' },
      ]),
    });
    const [pr] = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl, includeFiles: false });
    expect(pr).toMatchObject({ body: '', headBranch: null, author: 'alice', state: 'open' });
    expect(pr.files).toBeUndefined();
    const [review, issue, body] = pr.comments;
    expect(review).toMatchObject({ id: '77', line: 7, path: 'a.ts' });
    // a review comment of a review GitHub did not list has no verdict
    expect(review.reviewState).toBeUndefined();
    expect(review.diffHunk).toHaveLength(1500);
    expect(review.diffHunk!.endsWith('END')).toBe(true);
    expect(issue).toMatchObject({ id: '1', author: 'ghost', kind: 'issue_comment' });
    expect(body).toEqual({ id: '5', author: 'carol', body: 'looks fine', path: null, line: null, url: '', createdAt: '', kind: 'review', diffHunk: null });
  });

  test('a PR\'s file list is capped at 300; an auth failure reading it stops the sync', async () => {
    const files = (url: URL) => {
      const page = Number(url.searchParams.get('page') ?? 1);
      return Response.json(Array.from({ length: 100 }, (_, i) => ({ filename: `f${page}-${i}.ts` })), { headers: { link: `<${API}/repos/acme/demo/pulls/1/files?per_page=100&page=${page + 1}>; rel="next"` } });
    };
    const big = routes({ '/repos/acme/demo/pulls': json([pull(1)]), '/repos/acme/demo/pulls/1/files': files });
    const [pr] = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl: big.fetchImpl });
    expect(pr.files).toHaveLength(300);
    expect(big.calls.filter((c) => c.includes('/files'))).toHaveLength(3);
    const denied = routes({ '/repos/acme/demo/pulls': json([pull(1)]), '/repos/acme/demo/pulls/1/files': () => new Response('Bad credentials', { status: 401 }) });
    await expect(fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl: denied.fetchImpl })).rejects.toMatchObject({ kind: 'auth' });
  });

  test('a Link header without a next page ends the listing', async () => {
    const { fetchImpl, calls } = routes({
      '/repos/acme/demo/pulls': json([pull(1)], { link: `<${API}/repos/acme/demo/pulls?page=1>; rel="first", <${API}/repos/acme/demo/pulls?page=9>; rel="last"` }),
    });
    expect((await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl, includeFiles: false })).map((p) => p.number)).toEqual([1]);
    expect(calls.filter((c) => new URL(c).pathname === '/repos/acme/demo/pulls')).toHaveLength(1);
  });

  test('bad arguments are refused before any request', async () => {
    const { fetchImpl, calls } = routes({});
    await expect(fetchPullRequestContext({ repo: 'acme/demo', token: 't', since: 'yesterday', fetchImpl })).rejects.toThrow('github: invalid since "yesterday"');
    await expect(fetchPullRequestContext({ repo: 'acme/demo', token: 't', until: 'soon', fetchImpl })).rejects.toThrow('github: invalid until "soon"');
    await expect(fetchPullRequestContext({ repo: 'acme/demo', token: 't', numbers: [0], fetchImpl })).rejects.toThrow('github: invalid PR number');
    await expect(fetchPullRequestContext({ repo: 'acme/demo', token: 't', metadataOnly: true, metadataPage: 1.5, fetchImpl })).rejects.toThrow('github: invalid metadata page');
    expect(calls).toEqual([]);
  });

  test('targeted reads fetch each PR once even when named twice', async () => {
    const { fetchImpl, calls } = routes({ '/repos/acme/demo/pulls/7': json(pull(7)) });
    expect((await fetchPullRequestContext({ repo: 'acme/demo', token: 't', numbers: [7, 7], metadataOnly: true, fetchImpl })).map((p) => p.number)).toEqual([7]);
    expect(calls).toEqual([`${API}/repos/acme/demo/pulls/7`]);
  });

  test('the last metadata page reports no next page, and bot or other authors\' PRs are left out', async () => {
    const { fetchImpl } = routes({ '/repos/acme/demo/pulls?page=4': json([pull(1), pull(2, { user: { login: 'dependabot[bot]', type: 'Bot' } }), pull(3, { user: { login: 'bob' } }), pull(4, { user: null })]) });
    let next: number | null | undefined;
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', metadataOnly: true, metadataPage: 4, author: 'alice', fetchImpl, onMetadataPage: (n) => { next = n; } });
    expect(out.map((p) => p.number)).toEqual([1]);
    expect(next).toBeNull();
    const all = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', metadataOnly: true, metadataPage: 4, fetchImpl });
    expect(all.map((p) => [p.number, p.author])).toEqual([[1, 'alice'], [3, 'bob'], [4, 'ghost']]);
  });
});

test('a stored PR backlog reads back only when it has both ends; anything else is none', () => {
  expect(prBacklogKey('shop')).not.toBe(prBacklogKey('shop2'));
  expect(parsePrBacklog(JSON.stringify({ since: 'a', until: 'b', extra: 1 }))).toEqual({ since: 'a', until: 'b' });
  for (const raw of [null, '', '{', '{"since":"a"}', '{"since":1,"until":"b"}', 'null']) expect(parsePrBacklog(raw), String(raw)).toBeNull();
});

test('a review comment on a file but no line names just the file; a conversation comment is a "comment"', () => {
  const pr: PrContext = { repo: 'a/b', number: 1, title: 'T', url: 'u', author: 'x', state: 'open', updatedAt: 'd', headBranch: null, body: '', comments: [
    { id: '1', author: 'y', body: 'whole file', path: 'a.ts', line: null, url: 'u', createdAt: 'c', kind: 'review_comment', diffHunk: null },
    { id: '2', author: 'z', body: 'hi', path: null, line: null, url: 'u', createdAt: 'c', kind: 'issue_comment', diffHunk: null },
  ] };
  const [, file, comment] = prContextToChunks(pr);
  expect(file.text).toBe('review comment by y on a.ts on PR a/b#1 (T):\nwhole file');
  expect(comment.text).toBe('comment by z on PR a/b#1 (T):\nhi');
});
