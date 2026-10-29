import { expect, test, vi } from 'vitest';
import { SessionsRepo } from './sessions.ts';
import type { GraphRepo } from './repo.ts';
import { withStoreWriteAuthorizer } from '../storeWrites.ts';
import { withStoreDeadline } from '../storeDeadline.ts';

test('session registration closes its driver session when beginning a transaction fails', async () => {
  const close = vi.fn(async () => {});
  const repo = new SessionsRepo({ driver: { session: () => ({ beginTransaction: async () => { throw new Error('begin failed'); }, close }) } } as unknown as GraphRepo);
  await expect(repo.claimRun('fixture', { id: 'run', sandbox: true })).rejects.toThrow('begin failed');
  expect(close).toHaveBeenCalledOnce();
});

test('an expired request never commits owner and binding after authorization waits', async () => {
  const abort = new AbortController();
  const commit = vi.fn(async () => {}), rollback = vi.fn(async () => {}), close = vi.fn(async () => {});
  const transaction = { commit, rollback, run: vi.fn(async () => ({ records: [{ get: (key: string) => key === 'existing' ? false : null }] })) };
  const repo = new SessionsRepo({ driver: { session: () => ({ beginTransaction: () => transaction, close }) }, sandbox: { wrote: vi.fn() } } as unknown as GraphRepo);
  await expect(withStoreDeadline({ signal: abort.signal, expiresAt: Date.now() + 10_000 }, () => withStoreWriteAuthorizer(async () => { abort.abort(); }, () => repo.claimRun('fixture', { id: 'run', sandbox: true })))).rejects.toThrow(/deadline/);
  expect(commit).not.toHaveBeenCalled(); expect(rollback).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
});
