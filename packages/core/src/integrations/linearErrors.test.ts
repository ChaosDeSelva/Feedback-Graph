import { describe, expect, test } from 'vitest';
import { IntegrationError, integrationErrorKind } from './errors.ts';
import { fetchLinearIssues, linearIssueDocChunks, linearIssueToChunk, linearViewer, searchLinearIssues } from './linear.ts';

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () => (typeof body === 'string' ? new Response(body, { status, headers }) : Response.json(body, { status, headers }))) as unknown as typeof fetch;
const failure = (fetchImpl: typeof fetch) => linearViewer({ apiKey: 'lin_api_sekrit', fetchImpl }).then(() => null, (e: IntegrationError) => e);

describe('Linear failures are classified so a sync knows whether to stop, wait or retry', () => {
  test('HTTP: 401/403 and an authentication error body are auth; 429 and RATELIMITED are rate limits; anything else is other', async () => {
    for (const [status, body, kind] of [
      [401, 'nope', 'auth'], [403, 'forbidden', 'auth'], [400, '{"errors":[{"extensions":{"code":"AUTHENTICATION_ERROR"}}]}', 'auth'],
      [429, 'slow down', 'rate_limit'], [400, '{"errors":[{"extensions":{"code":"RATELIMITED"}}]}', 'rate_limit'], [500, 'oops', 'other'],
    ] as const) {
      const err = await failure(answer(status, body));
      expect(err, `${status} ${body}`).toMatchObject({ name: 'IntegrationError', kind, message: `linear ${status}: ${body}` });
      expect(err!.message).not.toContain('lin_api_sekrit');
    }
  });

  test('a rate limit carries when it lifts, when Linear says; an auth error never does', async () => {
    const reset = Date.UTC(2026, 10, 10, 12, 0);
    expect((await failure(answer(429, 'x', { 'x-ratelimit-requests-reset': String(reset) })))!.retryAt).toBe(new Date(reset).toISOString());
    expect((await failure(answer(429, 'x')))!.retryAt).toBeNull();
    expect((await failure(answer(429, 'x', { 'x-ratelimit-requests-reset': 'soon' })))!.retryAt).toBeNull();
    expect((await failure(answer(401, 'x', { 'x-ratelimit-requests-reset': String(reset) })))!.retryAt).toBeNull();
  });

  test('GraphQL errors: authentication by code or type is auth, others are other; no data at all is other', async () => {
    const byType = await failure(answer(200, { errors: [{ message: 'who are you', extensions: { type: 'authentication error' } }] }));
    expect(byType).toMatchObject({ kind: 'auth', message: 'linear graphql: who are you', retryAt: null });
    const plain = await failure(answer(200, { errors: [{ message: 'Argument Validation Error' }] }));
    expect(plain).toMatchObject({ kind: 'other', message: 'linear graphql: Argument Validation Error' });
    expect(await failure(answer(200, {}))).toMatchObject({ kind: 'other', message: 'linear graphql: response had no data' });
    expect(await failure(answer(200, { data: null }))).toMatchObject({ kind: 'other' });
  });

  test('integrationErrorKind reads network failures from any error, and everything unknown as other', () => {
    expect(integrationErrorKind(new IntegrationError('x', 'not_found'))).toBe('not_found');
    expect(integrationErrorKind(new TypeError('fetch failed'))).toBe('network');
    expect(integrationErrorKind(new DOMException('timed out', 'TimeoutError'))).toBe('network');
    expect(integrationErrorKind(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('network');
    expect(integrationErrorKind(new Error('getaddrinfo ENOTFOUND api.linear.app'))).toBe('network');
    expect(integrationErrorKind(new Error('connect ECONNREFUSED'))).toBe('network');
    expect(integrationErrorKind(new Error('Unexpected token < in JSON'))).toBe('other');
    expect(integrationErrorKind('fetch failed')).toBe('other');
  });
});

test('a search result missing its optional fields reads as empty values', async () => {
  const node = { identifier: 'ENG-1', title: 't', url: 'u', updatedAt: '2026-10-01T00:00:00Z', state: null, team: { key: 'ENG' }, comments: { nodes: [{ body: '  ', user: { name: 'Pat' } }, { body: null }] } };
  const [issue, teamless] = await searchLinearIssues({ query: 'q', apiKey: 'k', fetchImpl: answer(200, { data: { searchIssues: { nodes: [node, { ...node, team: null }] } } }) });
  expect(issue).toEqual({ identifier: 'ENG-1', title: 't', description: '', url: 'u', state: '', team: 'ENG', teamId: '', updatedAt: '2026-10-01T00:00:00Z', comments: [] });
  expect(teamless).toMatchObject({ team: '', teamId: '' });
});

test("a team's issue missing its optional fields reads as nulls, and comments fall back to the issue's link and the person's name", async () => {
  const issue = {
    id: 'i1', identifier: 'ENG-1', title: 't', url: 'https://linear.app/i/ENG-1', assignee: { name: 'jo' },
    comments: { nodes: [
      { id: 'c2', body: 'second', url: null, createdAt: '2026-10-02T00:00:00Z', user: { name: 'pat', displayName: '' } },
      { id: 'c1', body: 'first', createdAt: '2026-10-01T00:00:00Z', user: { name: 'sam', displayName: 'Sam' } },
      { id: 'c0', body: 'no author', createdAt: '2026-10-01T00:00:00Z' },
    ] },
  };
  // the last page has a next page flag but no cursor: reading stops there
  const out = await fetchLinearIssues({ apiKey: 'k', teamId: 't', since: '2026-01-01T00:00:00Z', fetchImpl: answer(200, { data: { issues: { pageInfo: { hasNextPage: true }, nodes: [issue] } } }) });
  expect(out).toEqual([{
    id: 'i1', identifier: 'ENG-1', title: 't', url: 'https://linear.app/i/ENG-1', branch: null, description: '', state: null, priority: null, labels: [], assignee: 'jo', updatedAt: null,
    comments: [
      { id: 'c1', author: 'Sam', body: 'first', url: 'https://linear.app/i/ENG-1', createdAt: '2026-10-01T00:00:00Z' },
      { id: 'c2', author: 'pat', body: 'second', url: 'https://linear.app/i/ENG-1', createdAt: '2026-10-02T00:00:00Z' },
    ],
  }]);
  const unassigned = await fetchLinearIssues({ apiKey: 'k', teamId: 't', since: 's', fetchImpl: answer(200, { data: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ ...issue, assignee: null }] } } }) });
  expect(unassigned[0].assignee).toBeNull();
});

test('reading a team stops after 10 pages even when Linear says there are more', async () => {
  let pages = 0;
  const endless = (async () => { pages++; return Response.json({ data: { issues: { pageInfo: { hasNextPage: true, endCursor: `c${pages}` }, nodes: [] } } }); }) as unknown as typeof fetch;
  expect(await fetchLinearIssues({ apiKey: 'k', teamId: 't', since: 's', fetchImpl: endless })).toEqual([]);
  expect(pages).toBe(10);
});

test('an issue with no details, assignee or description is one line and its link; one with no comments has no comment section', () => {
  const chunks = linearIssueDocChunks({ id: 'i', identifier: 'ENG-2', title: 'Bare', url: 'u', branch: null, description: '  ', state: null, priority: null, labels: [], assignee: null, updatedAt: null, comments: [] });
  expect(chunks).toEqual(['Linear ENG-2: Bare\nu']);
  const c = linearIssueToChunk({ identifier: 'ENG-3', title: 'T', description: 'D', url: 'u', state: 'Todo', team: 'ENG', teamId: 'x', updatedAt: 'd', comments: [] });
  expect(c.text).toBe('Linear ENG-3 [ENG] (Todo): T\nu\n\nD');
});
