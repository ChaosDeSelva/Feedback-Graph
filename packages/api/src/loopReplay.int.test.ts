import { openNeo4jStore, type GraphRepo, type Store } from '@fb/core';
import { testStores } from '@fb/core/testing';
import { execResult } from '@fb/core/testing/exec';
import { openDb, openPostgresStore } from '@fb/store-postgres';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// scripts/loop-replay.ts --demo wipes its store. One holding projects or lessons it did not write may be an install's,
// whatever its port, so it is refused unless --wipe; a store the script wiped itself is its own to wipe again.
const script = fileURLToPath(new URL('../../../scripts/loop-replay.ts', import.meta.url));
const NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';

function target(kind: string): { url: string; args: string[]; open(): Promise<Store> } {
  if (kind === 'neo4j') {
    const url = process.env.NEO4J_TEST_URL ?? 'bolt://127.0.0.1:7688';
    return { url, args: ['--password', NEO4J_PASSWORD], open: () => openNeo4jStore({ url, user: process.env.NEO4J_TEST_USER ?? 'neo4j', password: NEO4J_PASSWORD }) };
  }
  // Its own database: the script drops and recreates it, which would cut off the contract suites' connections.
  const u = new URL(process.env.TEST_PG_URL ?? 'postgres://fg:fg@localhost:5433/fg_test');
  u.pathname = `${u.pathname}_replay_guard`;
  const url = u.toString();
  return { url, args: [], open: () => openPostgresStore({ url, max: 2 }) };
}

describe.each(testStores())('loop-replay on %s', (kind) => {
  const t = target(kind);
  const replay = (...extra: string[]) => execResult(process.execPath, [script, '--store', kind, '--url', t.url, ...t.args, '--demo', ...extra], { env: { PATH: process.env.PATH } });
  const projects = async () => {
    const s = await t.open();
    try {
      await s.ensureSchema();
      return (await s.facts.listProjects()).map((p) => p.key).sort();
    } finally {
      await s.close();
    }
  };

  test('refuses a store with data it did not write unless --wipe; wipes its own scratch store again without asking', async () => {
    // An install's store: emptied and given one project, as a live install's would be.
    if (kind === 'postgres') {
      const admin = new URL(t.url);
      const db = admin.pathname.slice(1);
      admin.pathname = '/postgres';
      const { pool } = openDb({ url: admin.toString(), max: 1 });
      await pool.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      await pool.query(`CREATE DATABASE "${db}"`);
      await pool.end();
    }
    const s = await t.open();
    try {
      if (kind === 'neo4j') await (s.graph as GraphRepo).wipeForTests();
      await s.ensureSchema();
      await s.facts.setPinned({ key: 'live-install', name: 'live-install', repoPath: '/projects/live-install' }, true);
    } finally {
      await s.close();
    }

    const refused = await replay();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/refusing to wipe .* holds 1 projects and 0 lessons that loop-replay did not write/);
    expect(await projects()).toEqual(['live-install']);

    const wiped = await replay('--wipe');
    expect(wiped.stderr).toMatch(/WARNING: --wipe deletes everything/);
    expect(wiped.status).toBe(0);
    expect(await projects()).toEqual(['replay-demo']);

    const again = await replay();
    expect(again.stderr).not.toMatch(/refusing|WARNING/);
    expect(again.status).toBe(0);
  });

  test('without --demo or --restore it reads the store in place and writes nothing to it, not even a schema upgrade', async () => {
    const inPlace = (...extra: string[]) => execResult(process.execPath, [script, '--store', kind, '--url', t.url, ...t.args, '--t0', '2026-11-01T00:00:00.000Z', ...extra], { env: { PATH: process.env.PATH } });
    if (kind === 'neo4j') {
      const s = await t.open();
      const g = s.graph as GraphRepo;
      const census = async () => (await g.run('MATCH (n) RETURN count(n) AS nodes, COUNT { ()-->() } AS edges'))[0]!.toObject();
      try {
        await g.wipeForTests();
        // An install's store from before 0.8.0: an Activity entry with targets and no (:ActivityTarget) key.
        await g.run(`CREATE (:Project {key: 'live-install'}), (:Activity {id: 'act:old', ts: '2026-10-01T00:00:00.000Z', order: 1, kind: 'context_served', actor: 'x', subject: 's', why: 'w', details: '{}', targets: ['lesson:1']})`);
        const before = await census();
        const r = await inPlace();
        expect(r.stderr).not.toMatch(/refusing|WARNING/);
        expect(r.status).toBe(0);
        expect(await census()).toEqual(before);
      } finally {
        await s.close();
      }
      return;
    }
    // A Postgres store not at the current migrations is refused, not migrated.
    const admin = new URL(t.url);
    const db = admin.pathname.slice(1);
    admin.pathname = '/postgres';
    const { pool } = openDb({ url: admin.toString(), max: 1 });
    await pool.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await pool.query(`CREATE DATABASE "${db}"`);
    await pool.end();
    const refused = await inPlace();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/is not at the current schema \(missing 0001_\w+\.sql and \d+ more\).*start this version of Feedback Graph on it once, or replay a copy/);
    const { pool: check } = openDb({ url: t.url, max: 1 });
    try {
      expect((await check.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0].t).toBeNull();
    } finally {
      await check.end();
    }
    // At the current schema it reads in place and the store is as it was.
    const s = await t.open();
    try {
      await s.ensureSchema();
      await s.facts.setPinned({ key: 'live-install', name: 'live-install', repoPath: '/projects/live-install' }, true);
    } finally {
      await s.close();
    }
    const r = await inPlace();
    expect(r.status).toBe(0);
    expect(await projects()).toEqual(['live-install']);
  });
});
