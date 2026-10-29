import { expect, test } from 'vitest';
import { githubBudgetFetch } from './githubBudget.ts';

const kv = () => { const values = new Map<string, string>(); return { values, getCursor: async (key: string) => values.get(key) ?? null, setCursor: async (key: string, value: string) => { values.set(key, value); } }; };
test('docs and state walks share durable token budget across restarts', async () => {
  const cursors = kv(); let requests = 0; let now = 1000;
  const fetcher: typeof fetch = async () => { requests++; return Response.json({}); };
  const first = githubBudgetFetch(cursors, fetcher, { maxPerHour: 2, now: () => now });
  const options = { headers: { authorization: 'Bearer private-token' } };
  await first('https://api.github.com/repos/a/b/pulls', options);
  const restarted = githubBudgetFetch(cursors, fetcher, { maxPerHour: 2, now: () => now });
  await restarted('https://api.github.com/repos/a/b/pulls/1', options);
  await expect(restarted('https://api.github.com/repos/a/b/pulls/2', options)).rejects.toMatchObject({ kind: 'rate_limit' });
  expect(requests).toBe(2);
  expect([...cursors.values.keys()].join()).not.toContain('private-token');
  now += 3600_000;
  await restarted('https://api.github.com/repos/a/b/pulls/2', options);
  expect(requests).toBe(3);
});
test('low shared GitHub quota pauses before sending the next HTTP request', async () => {
  const cursors = kv(); let requests = 0;
  const wrapped = githubBudgetFetch(cursors, async () => { requests++; return new Response('{}', { headers: { 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '3600' } }); }, { now: () => 1000 });
  const options = { headers: { authorization: 'Bearer token' } };
  await wrapped('https://api.github.com/a', options);
  await expect(wrapped('https://api.github.com/b', options)).rejects.toMatchObject({ kind: 'rate_limit', retryAt: '1970-01-01T01:00:00.000Z' });
  expect(requests).toBe(1);
});

test('concurrent callers cannot exceed the shared reservation limit', async () => {
  const cursors = kv(); let requests = 0;
  const wrapped = githubBudgetFetch(cursors, async () => { requests++; return Response.json({}); }, { maxPerHour: 2, now: () => 1000 });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => wrapped('https://api.github.com/a', { headers: { authorization: 'Bearer same-token' } })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
  expect(requests).toBe(2);
});
test('Retry-After is persisted when a rate limit omits primary quota headers', async () => {
  const cursors = kv(); let requests = 0;
  const wrapped = githubBudgetFetch(cursors, async () => { requests++; return new Response('{}', { status: 429, headers: { 'retry-after': '300' } }); }, { now: () => 1000 });
  const options = { headers: { authorization: 'Bearer token' } };
  await wrapped('https://api.github.com/a', options);
  await expect(wrapped('https://api.github.com/b', options)).rejects.toMatchObject({ kind: 'rate_limit', retryAt: '1970-01-01T00:05:01.000Z' });
  expect(requests).toBe(1);
});
