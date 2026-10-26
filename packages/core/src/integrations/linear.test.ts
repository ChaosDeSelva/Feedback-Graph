import { describe, expect, test } from 'vitest';
import { linearIssueToChunk, searchLinearIssues, type LinearIssue } from './linear.ts';

const node = {
  identifier: 'ENG-123',
  title: 'Checkout must support coupons',
  description: 'Coupons stack with sales.',
  url: 'https://linear.app/acme/issue/ENG-123',
  state: { name: 'In Progress' },
  team: { id: 'team-eng', key: 'ENG' },
  updatedAt: '2026-10-20T00:00:00Z',
  comments: { nodes: [{ body: 'only one coupon per order', user: { name: 'Pat' } }, { body: 'from integration', user: null }] },
};

describe('searchLinearIssues', () => {
  test('posts a searchIssues query with the raw API key and maps nodes', async () => {
    let url = '';
    let init: RequestInit = {};
    const fetchImpl = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return Response.json({ data: { searchIssues: { nodes: [node, { ...node, identifier: 'ENG-9', description: null, comments: null }] } } });
    }) as unknown as typeof fetch;
    const out = await searchLinearIssues({ query: 'coupon', apiKey: 'lin_api_abc', first: 5, fetchImpl });
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('lin_api_abc');
    expect(h['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain('searchIssues(term: $term, first: $first)');
    expect(body.variables).toEqual({ term: 'coupon', first: 5 });
    expect(out[0]).toEqual({
      identifier: 'ENG-123',
      title: 'Checkout must support coupons',
      description: 'Coupons stack with sales.',
      url: 'https://linear.app/acme/issue/ENG-123',
      state: 'In Progress',
      team: 'ENG',
      teamId: 'team-eng',
      updatedAt: '2026-10-20T00:00:00Z',
      comments: [
        { author: 'Pat', body: 'only one coupon per order' },
        { author: 'unknown', body: 'from integration' },
      ],
    });
    expect(out[1]).toMatchObject({ identifier: 'ENG-9', description: '', comments: [] });
  });

  test('throws GraphQL errors', async () => {
    const fetchImpl = (async () => Response.json({ errors: [{ message: 'Authentication required' }, { message: 'second' }] })) as unknown as typeof fetch;
    await expect(searchLinearIssues({ query: 'x', apiKey: 'k', fetchImpl })).rejects.toThrow(/linear graphql: Authentication required; second/);
  });

  test('throws HTTP errors with status and truncated body, not the key', async () => {
    const fetchImpl = (async () => new Response('e'.repeat(3000), { status: 400 })) as unknown as typeof fetch;
    const err = (await searchLinearIssues({ query: 'x', apiKey: 'lin_api_secret', fetchImpl }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^linear 400/);
    expect(err.message.length).toBeLessThan(700);
    expect(err.message).not.toContain('lin_api_secret');
  });

  test('defaults first to 10', async () => {
    let body: any;
    const fetchImpl = (async (_u: string, i: RequestInit) => {
      body = JSON.parse(i.body as string);
      return Response.json({ data: { searchIssues: { nodes: [] } } });
    }) as unknown as typeof fetch;
    expect(await searchLinearIssues({ query: 'x', apiKey: 'k', fetchImpl })).toEqual([]);
    expect(body.variables.first).toBe(10);
  });
});

describe('linearIssueToChunk', () => {
  const issue: LinearIssue = {
    identifier: 'ENG-123',
    title: 'Checkout must support coupons',
    description: 'Coupons stack with sales.',
    url: 'https://linear.app/acme/issue/ENG-123',
    state: 'Done',
    team: 'ENG',
    teamId: 'team-eng',
    updatedAt: '2026-10-20T00:00:00Z',
    comments: [{ author: 'Pat', body: 'only one coupon per order' }],
  };

  test('ref and text', () => {
    const c = linearIssueToChunk(issue);
    expect(c.ref).toBe('linear:ENG-123');
    for (const s of ['ENG-123', 'Checkout must support coupons', 'Done', 'Coupons stack with sales.', 'Pat', 'only one coupon per order']) {
      expect(c.text).toContain(s);
    }
  });

  test('caps at 4000 chars', () => {
    const c = linearIssueToChunk({ ...issue, description: 'd'.repeat(10_000) });
    expect(c.text.length).toBe(4000);
  });
});
