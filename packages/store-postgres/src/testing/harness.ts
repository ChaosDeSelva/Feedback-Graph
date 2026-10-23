import type { TestStore } from '@fb/core/testing';
import pg from 'pg';
import { openPostgresStore } from '../store.ts';
import { PostgresProbe } from './probe.ts';

/** TEST_PG_URL, default docker-compose.test.yml's postgres-test. Give each parallel run its own database name. */
export const testPgUrl = (env: Record<string, string | undefined> = process.env) => env.TEST_PG_URL ?? 'postgres://fg:fg@localhost:5433/fg_test';

/** The database a URL names. Tests wipe it, so it must be a plain name containing "test". */
export function databaseOf(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`TEST_PG_URL: database name "${name}" must be letters, digits and _`);
  if (!name.includes('test')) throw new Error(`TEST_PG_URL: database "${name}" is wiped by the tests, so its name must contain "test"`);
  return name;
}

/** The same server and credentials, another database. */
export function withDatabase(url: string, name: (current: string) => string): string {
  const u = new URL(url);
  u.pathname = `/${name(decodeURIComponent(u.pathname.slice(1)))}`;
  return u.toString();
}

async function admin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: withDatabase(url, () => 'postgres') });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Create the database the URL names when it is missing. Safe when another run creates it at the same moment. */
export async function ensureDatabase(url: string): Promise<void> {
  const name = databaseOf(url);
  await admin(url, async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount) return;
    try {
      await c.query(`CREATE DATABASE "${name}"`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '42P04' && code !== '23505') throw err; // created meanwhile by another run
    }
  });
}

/** Drop (disconnecting whoever is on it) and create the database the URL names. */
export async function recreateDatabase(url: string): Promise<void> {
  const name = databaseOf(url);
  await admin(url, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${name}"`);
  });
}

/** The contract suites' Postgres store: TEST_PG_URL's database, created when missing, migrated. */
export async function openPostgresTestStore(): Promise<TestStore> {
  const url = testPgUrl();
  await ensureDatabase(url);
  const store = await openPostgresStore({ url, max: 4 });
  await store.ensureSchema();
  return { store, probe: new PostgresProbe(store.db) };
}
