import { describe, expect, test } from 'vitest';
import { IntegrationError } from './errors.ts';
import { fetchPullRequestContext, githubRepoOfRemote, githubViewer, parseGithubRepos, prContextToChunks, type PrContext } from './github.ts';

describe('parseGithubRepos', () => {
  test('parses project=owner/repo pairs, trimming and skipping blanks', () => {
    const m = parseGithubRepos(' demo-shop = acme/demo-shop , ,other_app=me/other-app,');
    expect([...m]).toEqual([
      ['demo-shop', 'acme/demo-shop'],
      ['other_app', 'me/other-app'],
    ]);
  });

  test('empty spec gives an empty map', () => {
    expect(parseGithubRepos('').size).toBe(0);
    expect(parseGithubRepos('  ').size).toBe(0);
  });

  test.each(['demo-shop', 'demo-shop=acme', 'demo-shop=acme/repo/extra', '=acme/repo', 'p=ac me/repo', 'p=acme/../x', 'p=-acme/repo'])(
    'throws on malformed entry %j',
    (spec) => {
      expect(() => parseGithubRepos(spec)).toThrow(/GITHUB_REPOS/);
    },
  );
});

type Route = (url: URL, init: RequestInit) => Response;

function mockFetch(routes: Record<string, Route | unknown>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    calls.push({ url: input, init });
    const url = new URL(input);
    const key = url.pathname + (url.searchParams.has('page') ? `?page=${url.searchParams.get('page')}` : '');
    const r = routes[key] ?? routes[url.pathname];
    if (r === undefined) return Response.json([], { status: 200 });
    if (typeof r === 'function') return (r as Route)(url, init);
    return Response.json(r);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const human = (login: string) => ({ login, type: 'User' });

function pr(n: number, updated: string, extra: Record<string, unknown> = {}) {
  return {
    number: n,
    title: `PR ${n}`,
    html_url: `https://github.com/acme/demo/pull/${n}`,
    user: human('alice'),
    state: 'open',
    merged_at: null,
    updated_at: updated,
    body: `body ${n}`,
    ...extra,
  };
}

describe('fetchPullRequestContext', () => {
  test("each PR carries the files it changed (renamed files by their new path), what a session is matched to it by", async () => {
    const { fetchImpl, calls } = mockFetch({
      '/repos/acme/data-pipeline/pulls': [pr(12, '2026-10-20T00:00:00Z', { head: { ref: 'feat/batch-loader' } })],
      '/repos/acme/data-pipeline/pulls/12/files': [
        { filename: 'pipeline/load.py', status: 'modified' },
        { filename: 'pipeline/retry.py', status: 'renamed', previous_filename: 'pipeline/backoff.py' },
        { filename: 'tests/test_load.py', status: 'added' },
      ],
    });
    const [out] = await fetchPullRequestContext({ repo: 'acme/data-pipeline', token: 'tok', fetchImpl });
    expect(out.files).toEqual(['pipeline/load.py', 'pipeline/retry.py', 'tests/test_load.py']);
    expect(calls.some((c) => c.url === 'https://api.github.com/repos/acme/data-pipeline/pulls/12/files?per_page=100')).toBe(true);
  });

  test('a PR whose file list cannot be read still syncs, with no files', async () => {
    const { fetchImpl } = mockFetch({
      '/repos/acme/data-pipeline/pulls': [pr(12, '2026-10-20T00:00:00Z')],
      '/repos/acme/data-pipeline/pulls/12/files': () => new Response('server error', { status: 500 }),
    });
    const [out] = await fetchPullRequestContext({ repo: 'acme/data-pipeline', token: 'tok', fetchImpl });
    expect(out.files).toBeUndefined();
  });

  test('sends GitHub headers and collects review, issue, and review-body comments without bots or empties', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/repos/acme/demo/pulls': [pr(7, '2026-10-20T00:00:00Z', { head: { ref: 'feat/dark' } })],
      '/repos/acme/demo/pulls/7/comments': [
        { id: 1, diff_hunk: '@@ -1 +1 @@', user: human('bob'), body: 'use the existing helper', path: 'src/a.ts', line: 12, original_line: 10, html_url: 'u1', created_at: '2026-10-19T00:00:00Z' },
        { id: 2, user: { login: 'renovate[bot]', type: 'User' }, body: 'bump', path: 'x', line: 1, html_url: 'u2', created_at: '2026-10-19T00:00:00Z' },
        { id: 3, user: human('bob'), body: '   ', path: 'x', line: 1, html_url: 'u3', created_at: '2026-10-19T00:00:00Z' },
      ],
      '/repos/acme/demo/issues/7/comments': [
        { id: 4, user: { login: 'ci', type: 'Bot' }, body: 'coverage report', html_url: 'u4', created_at: '2026-10-19T00:00:00Z' },
        { id: 5, user: human('carol'), body: 'we need dark mode too', html_url: 'u5', created_at: '2026-10-19T01:00:00Z' },
      ],
      '/repos/acme/demo/pulls/7/reviews': [
        { id: 6, user: human('dave'), body: 'changes requested: no new deps', html_url: 'u6', submitted_at: '2026-10-19T02:00:00Z' },
        { id: 8, user: human('dave'), body: '', html_url: 'u8', submitted_at: '2026-10-19T03:00:00Z' },
      ],
    });
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 'tok', fetchImpl });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok');
    expect(h.accept).toBe('application/vnd.github+json');
    expect(h['x-github-api-version']).toBe('2022-11-28');
    expect(h['user-agent']).toBe('feedback-graph');
    expect(calls[0].url).toContain('https://api.github.com/repos/acme/demo/pulls?state=all&sort=updated&direction=desc&per_page=');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo: 'acme/demo', number: 7, title: 'PR 7', author: 'alice', state: 'open', body: 'body 7', headBranch: 'feat/dark' });
    expect(out[0].comments).toEqual([
      { id: '1', author: 'bob', body: 'use the existing helper', path: 'src/a.ts', line: 12, url: 'u1', createdAt: '2026-10-19T00:00:00Z', kind: 'review_comment', diffHunk: '@@ -1 +1 @@' },
      { id: '5', author: 'carol', body: 'we need dark mode too', path: null, line: null, url: 'u5', createdAt: '2026-10-19T01:00:00Z', kind: 'issue_comment', diffHunk: null },
      { id: '6', author: 'dave', body: 'changes requested: no new deps', path: null, line: null, url: 'u6', createdAt: '2026-10-19T02:00:00Z', kind: 'review', diffHunk: null },
    ]);
  });

  test('a reply in a review thread says so, and comments carry the verdict of the review they belong to', async () => {
    const { fetchImpl } = mockFetch({
      '/repos/acme/demo/pulls': [pr(7, '2026-10-20T00:00:00Z')],
      '/repos/acme/demo/pulls/7/comments': [
        { id: 1, pull_request_review_id: 60, user: human('bob'), body: 'nit: rename', path: 'a.ts', line: 1, html_url: 'u1', created_at: '2026-10-19T00:00:00Z' },
        { id: 2, in_reply_to_id: 1, pull_request_review_id: 61, user: human('alice'), body: 'Fixed in 3f2a9c1', path: 'a.ts', line: 1, html_url: 'u2', created_at: '2026-10-19T01:00:00Z' },
      ],
      '/repos/acme/demo/pulls/7/reviews': [
        { id: 60, user: human('bob'), body: 'LGTM, one LOW nit', state: 'APPROVED', html_url: 'u60', submitted_at: '2026-10-19T00:00:00Z' },
        { id: 61, user: human('alice'), body: '', state: 'COMMENTED', html_url: 'u61', submitted_at: '2026-10-19T01:00:00Z' },
      ],
    });
    const [p] = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl });
    expect(p.comments.map((c) => [c.id, c.inReplyTo ?? null, c.reviewState ?? null])).toEqual([
      ['1', null, 'APPROVED'],
      ['2', '1', 'COMMENTED'],
      ['60', null, 'APPROVED'],
    ]);
  });

  test('skips PRs authored by bots', async () => {
    const { fetchImpl } = mockFetch({
      '/repos/acme/demo/pulls': [pr(1, '2026-10-20T00:00:00Z', { user: { login: 'dependabot[bot]', type: 'Bot' } }), pr(2, '2026-10-19T00:00:00Z')],
    });
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl });
    expect(out.map((p) => p.number)).toEqual([2]);
  });

  test('detects merged vs closed vs open state', async () => {
    const { fetchImpl } = mockFetch({
      '/repos/acme/demo/pulls': [
        pr(1, '2026-10-20T00:00:00Z', { state: 'closed', merged_at: '2026-10-20T00:00:00Z' }),
        pr(2, '2026-10-19T00:00:00Z', { state: 'closed', merged_at: null }),
        pr(3, '2026-10-18T00:00:00Z'),
      ],
    });
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl });
    expect(out.map((p) => p.state)).toEqual(['merged', 'closed', 'open']);
  });

  test('stops at the since cutoff', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/repos/acme/demo/pulls': [pr(3, '2026-10-20T00:00:00Z'), pr(2, '2026-10-10T00:00:00Z'), pr(1, '2026-10-01T00:00:00Z')],
    });
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', since: '2026-10-05T00:00:00Z', fetchImpl });
    expect(out.map((p) => p.number)).toEqual([3, 2]);
    expect(calls.some((c) => c.url.includes('/pulls/1/'))).toBe(false);
  });

  test('an incremental sync takes every PR updated since the cursor, not just the first 30', async () => {
    const many = Array.from({ length: 45 }, (_, i) => pr(100 - i, `2026-10-20T00:${String(59 - i).padStart(2, '0')}:00Z`));
    const { fetchImpl } = mockFetch({ '/repos/acme/demo/pulls': [...many, pr(1, '2026-10-01T00:00:00Z')] });
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', since: '2026-10-19T00:00:00Z', fetchImpl });
    expect(out).toHaveLength(45);
  });

  test('a first sync (no cursor) still takes only the 30 most recent', async () => {
    const many = Array.from({ length: 45 }, (_, i) => pr(100 - i, `2026-10-20T00:${String(59 - i).padStart(2, '0')}:00Z`));
    const { fetchImpl } = mockFetch({ '/repos/acme/demo/pulls': many });
    expect(await fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl })).toHaveLength(30);
  });

  test('an incremental sync stopped by its cap says how far back it read; a complete one says nothing', async () => {
    const five = [5, 4, 3, 2, 1].map((n) => pr(n, `2026-10-2${n}T00:00:00Z`));
    const { fetchImpl } = mockFetch({ '/repos/acme/demo/pulls': five });
    const caps: string[] = [];
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', since: '2026-10-01T00:00:00Z', maxPrs: 3, fetchImpl, onCap: (t) => caps.push(t) });
    expect(out.map((p) => p.number)).toEqual([5, 4, 3]);
    // PRs updated after the cursor and before 10-23 were not read
    expect(caps).toEqual(['2026-10-23T00:00:00Z']);
    const done: string[] = [];
    await fetchPullRequestContext({ repo: 'acme/demo', token: 't', since: '2026-10-01T00:00:00Z', maxPrs: 10, fetchImpl, onCap: (t) => done.push(t) });
    expect(done).toEqual([]);
  });

  test('until skips the PRs a capped sync already read, without counting them against the cap', async () => {
    const five = [5, 4, 3, 2, 1].map((n) => pr(n, `2026-10-2${n}T00:00:00Z`));
    const { fetchImpl } = mockFetch({ '/repos/acme/demo/pulls': five });
    const caps: string[] = [];
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', since: '2026-10-01T00:00:00Z', until: '2026-10-23T00:00:00Z', maxPrs: 2, fetchImpl, onCap: (t) => caps.push(t) });
    // 10-23 itself was read (the cap stopped after it): reading it again is harmless, skipping one is not
    expect(out.map((p) => p.number)).toEqual([3, 2]);
    expect(caps).toEqual(['2026-10-22T00:00:00Z']);
  });

  test('follows Link rel=next pagination and respects maxPrs', async () => {
    const next = '<https://api.github.com/repos/acme/demo/pulls?state=all&page=2>; rel="next", <https://api.github.com/repos/acme/demo/pulls?state=all&page=2>; rel="last"';
    const { fetchImpl, calls } = mockFetch({
      '/repos/acme/demo/pulls': () => Response.json([pr(5, '2026-10-20T00:00:00Z'), pr(4, '2026-10-19T00:00:00Z')], { headers: { link: next } }),
      '/repos/acme/demo/pulls?page=2': [pr(3, '2026-10-18T00:00:00Z'), pr(2, '2026-10-17T00:00:00Z')],
      '/repos/acme/demo/pulls/5/comments': () =>
        Response.json([{ id: 1, user: human('bob'), body: 'p1', path: 'a', line: 1, html_url: 'u', created_at: 'c' }], {
          headers: { link: '<https://api.github.com/repos/acme/demo/pulls/5/comments?page=2>; rel="next"' },
        }),
      '/repos/acme/demo/pulls/5/comments?page=2': [{ id: 2, user: human('bob'), body: 'p2', path: 'a', line: 2, html_url: 'u', created_at: 'c' }],
    });
    const out = await fetchPullRequestContext({ repo: 'acme/demo', token: 't', maxPrs: 3, fetchImpl });
    expect(out.map((p) => p.number)).toEqual([5, 4, 3]);
    expect(out[0].comments.map((c) => c.body)).toEqual(['p1', 'p2']);
    expect(calls.filter((c) => new URL(c.url).pathname === '/repos/acme/demo/pulls')).toHaveLength(2);
  });

  test('refuses to follow Link to a foreign host', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/repos/acme/demo/pulls': () => Response.json([pr(1, '2026-10-20T00:00:00Z')], { headers: { link: '<https://evil.example/steal>; rel="next"' } }),
    });
    await expect(fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl })).rejects.toThrow(/api\.github\.com/);
    expect(calls.some((c) => c.url.includes('evil'))).toBe(false);
  });

  test('rate limit error includes the reset time', async () => {
    const { fetchImpl } = mockFetch({
      '/repos/acme/demo/pulls': () =>
        new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793000000' } }),
    });
    await expect(fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl })).rejects.toThrow(
      new RegExp(`rate limit.*${new Date(1793000000 * 1000).toISOString()}`),
    );
  });

  test('429 without reset header still reports rate limit', async () => {
    const { fetchImpl } = mockFetch({ '/repos/acme/demo/pulls': () => new Response('slow down', { status: 429 }) });
    await expect(fetchPullRequestContext({ repo: 'acme/demo', token: 't', fetchImpl })).rejects.toThrow(/github 429 rate limit/);
  });

  test('other errors throw status and truncated body, never the token', async () => {
    const { fetchImpl } = mockFetch({ '/repos/acme/demo/pulls': () => new Response('x'.repeat(5000), { status: 404 }) });
    const err = await fetchPullRequestContext({ repo: 'acme/demo', token: 'secret-token', fetchImpl }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^github 404/);
    expect((err as Error).message.length).toBeLessThan(700);
    expect((err as Error).message).not.toContain('secret-token');
  });

  test('rejects a malformed repo before any request', async () => {
    const { fetchImpl, calls } = mockFetch({});
    await expect(fetchPullRequestContext({ repo: 'acme/demo/../x', token: 't', fetchImpl })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('prContextToChunks', () => {
  const base: PrContext = {
    repo: 'acme/demo-shop',
    number: 12,
    title: 'Add checkout',
    url: 'https://github.com/acme/demo-shop/pull/12',
    author: 'alice',
    state: 'merged',
    updatedAt: '2026-10-20T00:00:00Z',
    headBranch: 'feat/checkout',
    body: 'Implements checkout',
    comments: [
      { id: '991', author: 'bob', body: 'keep prices in cents', path: 'src/cart.ts', line: 40, url: 'https://github.com/acme/demo-shop/pull/12#discussion_r991', createdAt: 'c', kind: 'review_comment', diffHunk: null },
      { id: '55', author: 'carol', body: 'y'.repeat(9000), path: null, line: null, url: 'https://github.com/acme/demo-shop/pull/12#issuecomment-55', createdAt: 'c', kind: 'issue_comment', diffHunk: null },
      { id: '2', author: 'dave', body: 'lgtm', path: null, line: null, url: '', createdAt: 'c', kind: 'review', diffHunk: null },
    ],
  };

  test('one chunk for the PR plus one per comment, with refs', () => {
    const chunks = prContextToChunks(base);
    expect(chunks.map((c) => c.ref)).toEqual([
      'github:acme/demo-shop#12',
      'github:acme/demo-shop#12/comment/991',
      'github:acme/demo-shop#12/comment/55',
      'github:acme/demo-shop#12/comment/2',
    ]);
    expect(chunks[0].text).toContain('Add checkout');
    expect(chunks[0].text).toContain('Implements checkout');
    expect(chunks[0].text).toContain('alice');
    expect(chunks[1].text).toContain('bob');
    expect(chunks[1].text).toContain('src/cart.ts:40');
    expect(chunks[1].text).toContain('keep prices in cents');
  });

  test('caps each chunk at 4000 chars', () => {
    const chunks = prContextToChunks({ ...base, body: 'z'.repeat(10_000) });
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(4000);
    expect(chunks[0].text.length).toBe(4000);
    expect(chunks[2].text.length).toBe(4000);
  });
});

describe('githubViewer', () => {
  test('one GET /user call returns the login', async () => {
    const { fetchImpl, calls } = mockFetch({ '/user': { login: 'octo', id: 1 } });
    expect(await githubViewer({ token: 'tok', fetchImpl })).toEqual({ login: 'octo' });
    expect(calls.map((c) => c.url)).toEqual(['https://api.github.com/user']);
  });

  test('a revoked token is an auth error; a rate limit carries when it lifts', async () => {
    const revoked = mockFetch({ '/user': () => new Response('{"message":"Bad credentials"}', { status: 401 }) });
    const err = await githubViewer({ token: 'sekrit-value', fetchImpl: revoked.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).toMatchObject({ kind: 'auth' });
    expect(String(err)).not.toContain('sekrit-value');
    const limited = mockFetch({ '/user': () => new Response('slow down', { status: 429, headers: { 'retry-after': '60' } }) });
    const e2 = await githubViewer({ token: 'tok', fetchImpl: limited.fetchImpl }).catch((e) => e);
    expect(e2).toMatchObject({ kind: 'rate_limit' });
    expect(Date.parse(e2.retryAt)).toBeGreaterThan(Date.now());
  });
});

describe('githubRepoOfRemote', () => {
  test('only github.com remotes map to owner/repo', () => {
    expect(githubRepoOfRemote('github.com/acme/shop')).toBe('acme/shop');
    expect(githubRepoOfRemote('gitlab.com/acme/shop')).toBeNull();
    expect(githubRepoOfRemote('local/shop')).toBeNull();
    expect(githubRepoOfRemote('github.com/acme/group/shop')).toBeNull();
    expect(githubRepoOfRemote(null)).toBeNull();
  });
});
