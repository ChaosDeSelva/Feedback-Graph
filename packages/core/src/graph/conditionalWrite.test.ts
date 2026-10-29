import { expect, test, vi } from 'vitest';
import { withStoreDeadline } from '../storeDeadline.ts';
import { conditionalWrite } from './conditionalWrite.ts';
import type { GraphRepo } from './repo.ts';

test('Neo conditional writes close the session when transaction creation throws', async () => {
  const close = vi.fn(async () => {});
  const beginTransaction = vi.fn(() => { throw new Error('connection unavailable'); });
  const graph = { driver: { session: () => ({ beginTransaction, close }) } } as unknown as GraphRepo;
  await expect(conditionalWrite(graph, async () => true, Boolean)).rejects.toThrow('connection unavailable');
  expect(close).toHaveBeenCalledTimes(1);
});

test('an already-expired request never starts a Neo transaction but closes its acquired session', async () => {
  const close = vi.fn(async () => {}), beginTransaction = vi.fn();
  const graph = { driver: { session: () => ({ beginTransaction, close }) } } as unknown as GraphRepo;
  await expect(withStoreDeadline({ signal: new AbortController().signal, expiresAt: Date.now() - 1 }, () => conditionalWrite(graph, async () => true, Boolean))).rejects.toThrow('deadline');
  expect(beginTransaction).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
});
