import { testStores } from '@fb/core/testing';
import { describe, expect, test } from 'vitest';
import { openPostgresStore } from './store.ts';
import { ensureDatabase, testPgUrl, withDatabase } from './testing/harness.ts';

/** Its own database (the run's name + _open), so it never disturbs the contract suites' one. */
const url = withDatabase(testPgUrl(), (name) => `${name}_open`);

describe.skipIf(!testStores().includes('postgres'))('openPostgresStore', () => {
  test('connects, answers ping, and pings false once closed', async () => {
    await ensureDatabase(url);
    const store = await openPostgresStore({ url, max: 1 });
    expect(store.kind).toBe('postgres');
    expect(await store.ping()).toBe(true);
    await store.close();
    expect(await store.ping()).toBe(false);
  });

  test('refuses to open a database that does not answer instead of failing at the first query', async () => {
    await expect(openPostgresStore({ url: withDatabase(url, (name) => `${name}_missing`), max: 1 })).rejects.toThrow(/does not exist/);
  });

  test('a query given as a config object loses its NUL characters too', async () => {
    await ensureDatabase(url);
    const store = await openPostgresStore({ url, max: 1 });
    try {
      const { rows } = await store.db.pool.query<{ v: string }>({ text: 'SELECT $1::text AS v', values: ['a\0b'] });
      expect(rows).toEqual([{ v: 'ab' }]);
    } finally {
      await store.close();
    }
  });
});
