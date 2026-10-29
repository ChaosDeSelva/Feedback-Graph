import { expect, test, vi } from 'vitest';
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


test('a long worker section holds its lock until the callback settles, without the HTTP default timeout', async () => {
  const events: string[] = [];
  const tx = { run: async () => { events.push('locked'); }, rollback: async () => { events.push('rollback'); }, commit: async () => { events.push('commit'); } };
  const session = { beginTransaction: (opts: { timeout: number }) => { expect(opts.timeout).toBe(0); return tx; }, close: async () => { events.push('closed'); } };
  const selection = new SelectionRepo({ driver: { session: () => session } } as unknown as GraphRepo);
  const now = Date.now();
  try {
    await selection.exclusive(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
      expect(events).toEqual(['locked']);
      events.push('work done');
    });
    expect(events).toEqual(['locked', 'work done', 'commit', 'closed']);
  } finally { vi.restoreAllMocks(); }
});

test('transaction creation failure closes the session and never runs work', async () => {
  let closed = false, called = false;
  const selection = new SelectionRepo({ driver: { session: () => ({ beginTransaction: () => { throw Error('offline'); }, close: async () => { closed = true; } }) } } as unknown as GraphRepo);
  await expect(selection.exclusive(async () => { called = true; })).rejects.toThrow('offline');
  expect(closed).toBe(true); expect(called).toBe(false);
});
