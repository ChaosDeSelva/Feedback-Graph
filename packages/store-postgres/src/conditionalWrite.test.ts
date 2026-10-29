import { expect, test, vi } from 'vitest';
import { withStoreDeadline } from '@fb/core';
import type { Db } from './db.ts';
import { conditionalWrite } from './conditionalWrite.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const rows = { rows: [], rowCount: 0 };

test('a pool acquisition that outlives the request is rejected and its late connection is destroyed once without BEGIN', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const connection = deferred<unknown>();
    const query = vi.fn(async () => rows), release = vi.fn();
    const result = withStoreDeadline({ signal: new AbortController().signal, expiresAt: 100 }, () => conditionalWrite({ pool: { connect: () => connection.promise } } as unknown as Db, async () => true, Boolean));
    const rejected = expect(result).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    connection.resolve({ query, release }); await vi.advanceTimersByTimeAsync(0);
    expect(query).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledExactlyOnceWith(true);
  } finally { vi.useRealTimers(); }
});

test('an aborted in-flight mutation destroys the connection, never commits and never releases twice', async () => {
  const controller = new AbortController(); const hanging = deferred<typeof rows>();
  const query = vi.fn(async (sql: string) => sql.startsWith('UPDATE') ? hanging.promise : rows);
  const release = vi.fn();
  const result = withStoreDeadline({ signal: controller.signal, expiresAt: Date.now() + 5000 }, () => conditionalWrite({ pool: { connect: async () => ({ query, release }) } } as unknown as Db,
    async exec => { await exec('UPDATE lessons SET rule = $1', ['new']); return true; }, Boolean));
  const rejected = expect(result).rejects.toThrow('deadline');
  await vi.waitFor(() => expect(query).toHaveBeenCalledWith('UPDATE lessons SET rule = $1', ['new']));
  controller.abort(); await rejected;
  expect(query.mock.calls.map(call => call[0])).not.toContain('COMMIT');
  expect(query.mock.calls.map(call => call[0])).toEqual(['BEGIN', expect.stringMatching(/^SET LOCAL statement_timeout = \d+$/), 'UPDATE lessons SET rule = $1']);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  hanging.resolve(rows); await Promise.resolve(); await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);
});

test('remaining server timeout is configured before mutations and an expired preflight cannot issue a write', async () => {
  const controller = new AbortController();
  const query = vi.fn(async (sql: string) => { if (sql.startsWith('SET LOCAL')) controller.abort(); return rows; });
  const release = vi.fn();
  await expect(withStoreDeadline({ signal: controller.signal, expiresAt: Date.now() + 5000 }, () => conditionalWrite({ pool: { connect: async () => ({ query, release }) } } as unknown as Db,
    exec => exec('DELETE FROM lessons'), result => result.rowCount !== 0))).rejects.toThrow('deadline');
  expect(query.mock.calls.map(call => call[0])).toEqual(['BEGIN', expect.stringMatching(/^SET LOCAL statement_timeout = \d+$/)]);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

test('no-op rolls back, returns its result and closes the query capability before returning its connection', async () => {
  const query = vi.fn(async () => rows), release = vi.fn();
  let retained!: Parameters<Parameters<typeof conditionalWrite>[1]>[0];
  expect(await conditionalWrite({ pool: { connect: async () => ({ query, release }) } } as unknown as Db, async exec => { retained = exec; return false; }, Boolean)).toBe(false);
  expect(query.mock.calls).toEqual([['BEGIN'], ['ROLLBACK']]);
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
  await expect(retained('UPDATE lessons SET rule = $1', ['late'])).rejects.toThrow('deadline');
  expect(query.mock.calls).toHaveLength(2);
});
