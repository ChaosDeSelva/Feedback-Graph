import { expect, test } from 'vitest';
import { githubBudgetFetch } from './githubBudget.ts';

const kv = (init: Record<string, string> = {}) => {
  const values = new Map(Object.entries(init));
  return { values, getCursor: async (key: string) => values.get(key) ?? null, setCursor: async (key: string, value: string) => { values.set(key, value); } };
};
const T0 = Date.parse('2026-11-10T12:00:00Z');

test('a 403 with an HTTP-date Retry-After blocks until that date', async () => {
  const cursors = kv();
  let requests = 0;
  const wrapped = githubBudgetFetch(cursors, async () => { requests++; return new Response('{}', { status: 403, headers: { 'retry-after': 'Tue, 10 Nov 2026 12:10:00 GMT' } }); }, { now: () => T0 });
  await wrapped('https://api.github.com/a', { headers: { authorization: 'Bearer t' } });
  await expect(wrapped('https://api.github.com/b', { headers: { authorization: 'Bearer t' } })).rejects.toMatchObject({ kind: 'rate_limit', retryAt: '2026-11-10T12:10:00.000Z' });
  expect(requests).toBe(1);
});

test('a 429 saying nothing about when waits a minute; a 403 without Retry-After is not a rate limit', async () => {
  const cursors = kv();
  let status = 429;
  const wrapped = githubBudgetFetch(cursors, async () => new Response('{}', { status }), { now: () => T0 });
  await wrapped('https://api.github.com/a');
  await expect(wrapped('https://api.github.com/b')).rejects.toMatchObject({ kind: 'rate_limit', retryAt: '2026-11-10T12:01:00.000Z' });

  const other = kv();
  status = 403;
  const forbidden = githubBudgetFetch(other, async () => new Response('{}', { status }), { now: () => T0 });
  expect((await forbidden('https://api.github.com/a')).status).toBe(403);
  expect((await forbidden('https://api.github.com/b')).status).toBe(403);
});

test('an unreadable stored budget starts a fresh hour rather than blocking sync', async () => {
  const cursors = kv();
  const wrapped = githubBudgetFetch(cursors, async () => Response.json({}), { maxPerHour: 1, now: () => T0 });
  await wrapped('https://api.github.com/a'); // records the (anonymous) budget's key
  const [key] = cursors.values.keys();
  for (const corrupt of ['{not json', JSON.stringify({ start: 'yesterday', used: 1 })]) {
    cursors.values.set(key, corrupt);
    expect((await wrapped('https://api.github.com/b')).status).toBe(200);
  }
});

test('the default budget leaves headroom: 1200 requests an hour per token', async () => {
  const cursors = kv();
  let requests = 0;
  const wrapped = githubBudgetFetch(cursors, async () => { requests++; return Response.json({}); }, { now: () => T0 });
  const [key] = (await wrapped('https://api.github.com/a'), [...cursors.values.keys()]);
  cursors.values.set(key, JSON.stringify({ start: T0, used: 1199 }));
  await wrapped('https://api.github.com/b');
  await expect(wrapped('https://api.github.com/c')).rejects.toMatchObject({ kind: 'rate_limit' });
  expect(requests).toBe(2);
});

test('on the wall clock, a 429 with no hint blocks the next request for about a minute', async () => {
  const cursors = kv();
  const wrapped = githubBudgetFetch(cursors, async () => new Response('{}', { status: 429 }));
  const before = Date.now();
  await wrapped('https://api.github.com/a');
  const err = await wrapped('https://api.github.com/b').catch((e: { retryAt: string }) => e);
  expect(Date.parse((err as { retryAt: string }).retryAt) - before).toBeGreaterThanOrEqual(60_000);
  expect(Date.parse((err as { retryAt: string }).retryAt) - Date.now()).toBeLessThanOrEqual(60_000);
});
