import { describe, expect, test } from 'vitest';
import { testStores } from '../testing/index.ts';
import { openNeo4jStore } from './neo4j-store.ts';

const config = { url: process.env.NEO4J_TEST_URL ?? 'bolt://127.0.0.1:7688', user: process.env.NEO4J_TEST_USER ?? 'neo4j', password: process.env.NEO4J_TEST_PASSWORD ?? 'testpassword' };

describe.skipIf(!testStores().includes('neo4j'))('openNeo4jStore', () => {
  test('connects, answers ping, and pings false once closed', async () => {
    const store = await openNeo4jStore(config);
    expect(store.kind).toBe('neo4j');
    expect(await store.ping()).toBe(true);
    await store.close();
    expect(await store.ping()).toBe(false);
  });

  test('refuses to open with the wrong password instead of failing at the first query', async () => {
    await expect(openNeo4jStore({ ...config, password: 'not-the-password' })).rejects.toThrow(/auth/i);
  });
});
