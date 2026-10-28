import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { storeTimeLeft } from '@fb/core';

const repo = (listCandidates: () => Promise<unknown[]>) => ({ listCandidates, stats: async () => [], candidateDetail: async () => null, decide: async () => {} }) as unknown as ApiRepo;
test('a wedged store cannot hold an API response forever', async () => {
  const app = createApp(repo(() => new Promise(() => {})), { requestTimeoutMs: 15 });
  const response = await app.request('/api/candidates');
  expect(response.status).toBe(504);
  expect(await response.json()).toMatchObject({ retryable: true });
});
test('an expired request cannot start a later mutation after its store wait releases', async () => {
  let release!: () => void;
  let writes = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const app = createApp(repo(async () => { await wait; storeTimeLeft(); writes++; return []; }), { requestTimeoutMs: 15 });
  expect((await app.request('/api/candidates')).status).toBe(504);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(writes).toBe(0);
});
