import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testStores } from '@fb/core/testing';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { migrate, migrationIds } from './migrate.ts';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
import { recreateDatabase, testPgUrl, withDatabase } from './testing/harness.ts';

/** Its own database (the run's name + _migrate), so it never disturbs the contract suites' one. */
const url = withDatabase(testPgUrl(), (name) => `${name}_migrate`);
const pools: pg.Pool[] = [];
const pool = () => {
  const p = new pg.Pool({ connectionString: url, max: 2 });
  pools.push(p);
  return p;
};

describe.skipIf(!testStores().includes('postgres'))('Postgres migrations', () => {
  beforeEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()));
    await recreateDatabase(url);
  });
  afterAll(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()));
  });

  test('a fresh database gets every migration once, in order; running again applies nothing', async () => {
    const p = pool();
    const all = await migrationIds();
    expect(all[0]).toBe('0001_init.sql');
    expect(await migrate(p)).toEqual(all);
    expect(await migrate(p)).toEqual([]);
    const { rows } = await p.query('SELECT id FROM schema_migrations ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(all);
  });

  test('the api and the worker migrating at the same moment apply each migration exactly once', async () => {
    const [a, b] = await Promise.all([migrate(pool()), migrate(pool())]);
    expect([...a, ...b].sort()).toEqual(await migrationIds());
  });

  test('a migration that fails leaves nothing of itself behind, and the next run tries it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-migrations-'));
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE ok_table (id int);');
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE half_table (id int); SELECT no_such_column FROM ok_table;');
    const p = pool();
    await expect(migrate(p, { dir })).rejects.toThrow(/no_such_column/);
    const tables = async () => (await p.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
    expect(await tables()).toEqual(['ok_table', 'schema_migrations']);
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE half_table (id int);');
    expect(await migrate(p, { dir })).toEqual(['0002_bad.sql']);
  });

  test('every node kind and relationship of the graph has its table, and project data carries project_key', async () => {
    const p = pool();
    await migrate(p);
    const { rows } = await p.query(
      `SELECT table_name, array_agg(column_name::text) AS columns FROM information_schema.columns
       WHERE table_schema = 'public' GROUP BY table_name ORDER BY table_name`,
    );
    const columns = Object.fromEntries(rows.map((r) => [r.table_name, r.columns as string[]]));
    expect(Object.keys(columns).sort()).toEqual([
      'activity', 'candidates', 'causes', 'chunks', 'code_files', 'code_imports', 'code_maps', 'code_symbols', 'code_tests', 'commit_feedback', 'commits', 'context_item_misses',
      'context_item_sessions', 'context_items', 'doc_blobs', 'docs', 'facts', 'feedback', 'graph_config', 'lesson_supersedes', 'lessons',
      'misses', 'predone_check_lessons', 'predone_checks', 'project_candidates', 'project_links', 'project_selection', 'projects', 'read_resets',
      'scan_jobs', 'schema_migrations', 'session_commits', 'session_files', 'session_summary_updates', 'sessions', 'sync_cursors', 'tasks', 'turns', 'worker_status',
    ]);
    for (const t of ['sessions', 'turns', 'candidates', 'feedback', 'tasks', 'misses', 'lessons', 'context_items', 'predone_checks', 'code_files', 'facts', 'scan_jobs', 'docs', 'chunks', 'activity', 'code_symbols', 'code_imports', 'code_tests', 'code_maps', 'session_files', 'session_summary_updates']) {
      expect(columns[t], t).toContain('project_key');
    }
  });

  test('0009 gives sessions stored before it their turn count, last turn and last activity, so summaries can find them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-migrations-'));
    const all = await migrationIds();
    const before = all.slice(0, all.indexOf('0009_session_summaries.sql'));
    for (const f of before) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    const p = pool();
    await migrate(p, { dir });
    await p.query(`INSERT INTO sessions (id, project_key, ended_at) VALUES ('s1', 'demo', '2026-10-01T10:30:00Z'), ('s2', 'demo', NULL)`);
    await p.query(
      `INSERT INTO turns (uuid, session_id, project_key, ts, ts_text, idx, text) VALUES
         ('a', 's1', 'demo', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 0, 'x'),
         ('b', 's1', 'demo', '2026-10-01T10:05:00Z', '2026-10-01T10:05:00+00:00', 1, 'y'),
         ('c', 's2', 'demo', '2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z', 0, 'z')`,
    );
    writeFileSync(join(dir, '0009_session_summaries.sql'), readFileSync(new URL('0009_session_summaries.sql', MIGRATIONS), 'utf8'));
    expect(await migrate(p, { dir })).toEqual(['0009_session_summaries.sql']);
    const { rows } = await p.query(`SELECT id, turn_count, last_turn_idx, last_turn_ts_text, last_activity_at, summary_version FROM sessions ORDER BY id`);
    expect(rows).toEqual([
      { id: 's1', turn_count: 2, last_turn_idx: 1, last_turn_ts_text: '2026-10-01T10:05:00+00:00', last_activity_at: new Date('2026-10-01T10:30:00Z'), summary_version: 0 },
      { id: 's2', turn_count: 1, last_turn_idx: 0, last_turn_ts_text: '2026-10-02T09:00:00Z', last_activity_at: new Date('2026-10-02T09:00:00Z'), summary_version: 0 },
    ]);
  });

  test('embeddings are pgvector columns with an HNSW cosine index over the configured dimension', async () => {
    const p = pool();
    await migrate(p, { embeddingDimensions: 1024 });
    const { rows } = await p.query(
      `SELECT c.table_name, c.udt_name FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'embedding' ORDER BY 1`,
    );
    expect(rows).toEqual(['chunks', 'facts', 'lessons', 'misses'].map((table_name) => ({ table_name, udt_name: 'vector' })));
    const idx = await p.query(`SELECT tablename, indexdef FROM pg_indexes WHERE indexdef LIKE '%hnsw%' ORDER BY tablename`);
    expect(idx.rows.map((r) => r.tablename)).toEqual(['chunks', 'facts', 'lessons', 'misses']);
    for (const r of idx.rows) expect(r.indexdef).toMatch(/vector\(1024\).*vector_cosine_ops/);
  });
});
