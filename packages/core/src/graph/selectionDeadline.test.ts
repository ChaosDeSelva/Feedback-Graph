import { expect, test } from 'vitest';
import { SelectionRepo } from './selection.ts';
import type { GraphRepo } from './repo.ts';
import { StoreDeadlineError, withStoreDeadline } from '../storeDeadline.ts';

test('a project lock released after its request deadline never starts the delete callback', async () => {
  let release!: () => void;
  let called = false, closed = 0, rolledBack = 0;
  const lock = new Promise<void>(resolve => { release = resolve; });
  const tx = { run: async () => { await lock; }, rollback: async () => { rolledBack++; }, commit: async () => {} };
  const session = { beginTransaction: (opts: { timeout: number }) => { expect(opts.timeout).toBeGreaterThan(0); expect(opts.timeout).toBeLessThanOrEqual(30_000); return tx; }, close: async () => { closed++; } };
  const selection = new SelectionRepo({ driver: { session: () => session } } as unknown as GraphRepo);
  const controller = new AbortController();
  const pending = withStoreDeadline({ signal: controller.signal, expiresAt: Date.now() + 30_000 }, () => selection.exclusive(async () => { called = true; }));
  controller.abort(); release();
  await expect(pending).rejects.toBeInstanceOf(StoreDeadlineError);
  expect(called).toBe(false); expect(closed).toBeGreaterThan(0); expect(rolledBack).toBe(1);
});
