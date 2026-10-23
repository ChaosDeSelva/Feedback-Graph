import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openPostgresStore, type PostgresStore } from './store.ts';
import { recreateDatabase, withDatabase } from './testing/harness.ts';

/**
 * TEST_PG_OLD_VECTOR_URL: a server whose pgvector is older than 0.8 (e.g. pgvector/pgvector:0.7.4-pg17). Skipped
 * without it: the usual test servers run 0.8.7.
 */
const old = process.env.TEST_PG_OLD_VECTOR_URL;

describe.skipIf(!old)('pgvector older than 0.8', () => {
  let store: PostgresStore;
  beforeAll(async () => {
    const url = withDatabase(old!, (name) => `${name}_oldvector`);
    await recreateDatabase(url);
    store = await openPostgresStore({ url });
  });
  afterAll(async () => {
    await store?.close();
  });

  test('ensureSchema refuses with the version found and how to upgrade, before anything can fail on a search', async () => {
    await expect(store.ensureSchema()).rejects.toThrow(/pgvector 0\.8\.0 or newer.*found 0\.7\.4/);
  });
});
