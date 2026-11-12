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
      'activity', 'candidates', 'causes', 'chat_conversations', 'chat_turns', 'chunks', 'claim_links', 'claims', 'code_files', 'code_imports', 'code_maps', 'code_symbols', 'code_tests', 'commit_feedback', 'commits', 'conflict_sides', 'conflicts', 'context_item_misses',
      'context_item_sessions', 'context_items', 'decision_deps', 'decision_notes', 'decision_targets', 'decisions', 'distinct_pairs', 'doc_blobs', 'docs', 'facts', 'feedback', 'graph_config', 'intake_sources', 'lesson_signals', 'lesson_supersedes', 'lessons',
      'loop_calibration', 'miss_links', 'misses', 'people', 'person_aliases', 'predone_check_lessons', 'predone_checks', 'project_candidates', 'project_links', 'project_selection', 'projects', 'questions', 'read_resets', 'run_owners',
      'scan_jobs', 'schema_migrations', 'session_commits', 'session_files', 'session_run_tags', 'session_summary_updates', 'sessions', 'source_people', 'supersessions', 'sync_cursors', 'tasks', 'turns', 'worker_status',
    ]);
    for (const t of ['sessions', 'turns', 'candidates', 'feedback', 'tasks', 'misses', 'lessons', 'context_items', 'predone_checks', 'code_files', 'facts', 'scan_jobs', 'docs', 'chunks', 'activity', 'code_symbols', 'code_imports', 'code_tests', 'code_maps', 'session_files', 'session_summary_updates', 'chat_conversations', 'chat_turns', 'decisions']) {
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

  test('a 0.7.5 database (through 0051) upgrades to 0.8.0: 0052 to 0059 in order, its data kept, the loop\'s columns usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-migrations-'));
    const all = await migrationIds();
    const upTo075 = all.slice(0, all.indexOf('0051_codemap_failures.sql') + 1);
    for (const f of upTo075) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    const p = pool();
    await migrate(p, { dir });
    await p.query(`INSERT INTO projects (key) VALUES ('demo')`);
    await p.query(`INSERT INTO lessons (id, project_key, title, rule, applies_when, scope, status, source, created_at)
                   VALUES ('lesson:1', 'demo', 't', 'r', 'a', 'project', 'approved', 'postmortem', now())`);
    const to080 = all.slice(upTo075.length, all.indexOf('0059_code_file_namespaces.sql') + 1);
    for (const f of to080) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    expect(await migrate(p, { dir })).toEqual(['0052_codemap_checked.sql', '0053_lesson_triggers.sql', '0054_decisions.sql', '0055_loop_weights.sql', '0056_loop_facts_and_splits.sql', '0057_loop_scale.sql', '0058_decision_notes_seq.sql', '0059_code_file_namespaces.sql']);
    expect(to080).toHaveLength(8);
    // The lesson is kept, and the loop's columns take its writes (and refuse a weight out of range).
    await p.query(`UPDATE lessons SET serving_weight = 1.2, split_from = 'lesson:0' WHERE id = 'lesson:1'`);
    expect((await p.query(`SELECT title, serving_weight, split_from FROM lessons`)).rows).toEqual([{ title: 't', serving_weight: 1.2, split_from: 'lesson:0' }]);
    await expect(p.query(`UPDATE lessons SET serving_weight = 2 WHERE id = 'lesson:1'`)).rejects.toThrow(/lessons_serving_weight_check/);
    await p.query(`UPDATE projects SET similarity_floor = 0.75, fact_rank_floor = 0.8 WHERE key = 'demo'`);
    // A loop fact, filed under its project like yours, with the loop's relevance.
    await p.query(`INSERT INTO facts (id, project_key, kind, statement, path, source, current, created_at, valid_from, origin, relevance, relevance_by)
                   VALUES ('fact:loop:1', 'demo', 'convention', 's', '.', 'loop', true, now(), now(), 'loop', 0.6, 'loop:1')`);
    expect((await p.query(`SELECT count(*)::int AS n FROM decisions`)).rows).toEqual([{ n: 0 }]);
    expect(await migrate(p, { dir })).toEqual([]);
  });

  test('a 0.8.2 database (through 0059) upgrades to 0.8.3: 0060 then 0061; 0060 stamps no trigger version, so every derived trigger is derived again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-migrations-'));
    const all = await migrationIds();
    const upTo082 = all.slice(0, all.indexOf('0059_code_file_namespaces.sql') + 1);
    for (const f of upTo082) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    const p = pool();
    await migrate(p, { dir });
    await p.query(`INSERT INTO lessons (id, title, rule, applies_when, scope, status, source, created_at, triggers)
                   VALUES ('lesson:1', 't', 'r', 'a', 'project', 'approved', 'postmortem', now(), '{"paths":["**/*.sql"],"patterns":[],"symbols":[]}')`);
    const to083 = all.slice(upTo082.length, all.indexOf('0061_scan_parked_at.sql') + 1);
    expect(to083).toEqual(['0060_trigger_version.sql', '0061_scan_parked_at.sql']);
    for (const f of to083) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    expect(await migrate(p, { dir })).toEqual(to083);
    expect((await p.query(`SELECT title, triggers, triggers_version FROM lessons`)).rows).toEqual([{ title: 't', triggers: { paths: ['**/*.sql'], patterns: [], symbols: [] }, triggers_version: null }]);
    expect((await p.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'scan_jobs' AND column_name = 'parked_at'`)).rows)
      .toEqual([{ data_type: 'timestamp with time zone' }]);
    expect(await migrate(p, { dir })).toEqual([]);
  });

  test('a 0.8.3 database (through 0061) upgrades to 0.9.0: 0062 adds intake, its data kept, the widened checks usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-migrations-'));
    const all = await migrationIds();
    const upTo083 = all.slice(0, all.indexOf('0061_scan_parked_at.sql') + 1);
    for (const f of upTo083) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    const p = pool();
    await migrate(p, { dir });
    await p.query(`INSERT INTO projects (key) VALUES ('demo')`);
    await p.query(`INSERT INTO lessons (id, project_key, title, rule, applies_when, scope, status, source, created_at, triggers_version)
                   VALUES ('lesson:1', 'demo', 't', 'r', 'a', 'project', 'approved', 'postmortem', now(), 3)`);
    await p.query(`INSERT INTO decisions (id, type, project_key, status, tier, mode, score, confidence, band, rationale, policy_version, created_at)
                   VALUES ('dec:1', 'approve_lesson', 'demo', 'applied', 'A', 'auto', 0.9, '{}', 4, 'r', 1, now())`);
    const to090 = all.slice(upTo083.length, all.indexOf('0062_intake.sql') + 1);
    expect(to090).toEqual(['0062_intake.sql']);
    for (const f of to090) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    expect(await migrate(p, { dir })).toEqual(to090);
    expect((await p.query(`SELECT title, triggers_version FROM lessons`)).rows).toEqual([{ title: 't', triggers_version: 3 }]);
    // A decision made before is the loop's; the owner's resolve_conflict on a claim and a conflict is taken.
    expect((await p.query(`SELECT author FROM decisions`)).rows).toEqual([{ author: 'loop' }]);
    await p.query(`INSERT INTO decisions (id, type, project_key, status, tier, mode, score, confidence, band, rationale, policy_version, created_at, author)
                   VALUES ('dec:2', 'resolve_conflict', 'demo', 'applied', 'P', 'propose', 1, '{}', 4, 'r', 1, now(), 'owner')`);
    await p.query(`INSERT INTO decision_targets (decision_id, idx, kind, target_id, role) VALUES ('dec:2', 0, 'conflict', 'conflict:1', 'primary'), ('dec:2', 1, 'claim', 'claim:1', 'merged')`);
    // The widened activity check takes intake's kinds.
    await p.query(`INSERT INTO activity (id, ts, kind, actor, subject, why) VALUES ('a1', now(), 'conflict_resolved', 'you', 'conflict:1', 's')`);
    expect((await p.query(`SELECT count(*)::int AS n FROM claims`)).rows).toEqual([{ n: 0 }]);
    expect(await migrate(p, { dir })).toEqual([]);
  });

  test('a 0.9.0 database (through 0062) upgrades to 0.9.1: 0063 takes the claim loop types and questions as targets, its decisions kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-migrations-'));
    const all = await migrationIds();
    const upTo090 = all.slice(0, all.indexOf('0062_intake.sql') + 1);
    for (const f of upTo090) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    const p = pool();
    await migrate(p, { dir });
    await p.query(`INSERT INTO decisions (id, type, project_key, status, tier, mode, score, confidence, band, rationale, policy_version, created_at, author)
                   VALUES ('dec:1', 'resolve_conflict', null, 'applied', 'P', 'propose', 1, '{}', 4, 'r', 1, now(), 'owner')`);
    writeFileSync(join(dir, '0063_claim_loop_types.sql'), readFileSync(new URL('0063_claim_loop_types.sql', MIGRATIONS), 'utf8'));
    expect(await migrate(p, { dir })).toEqual(['0063_claim_loop_types.sql']);
    expect((await p.query(`SELECT id, type FROM decisions`)).rows).toEqual([{ id: 'dec:1', type: 'resolve_conflict' }]);
    await p.query(`INSERT INTO decisions (id, type, project_key, status, tier, mode, score, confidence, band, rationale, policy_version, created_at)
                   VALUES ('dec:2', 'close_question', null, 'proposed', 'P', 'propose', 0.7, '{}', 3, 'r', 1, now())`);
    await p.query(`INSERT INTO decision_targets (decision_id, idx, kind, target_id, role) VALUES ('dec:2', 0, 'question', 'question:1', 'primary')`);
    await p.query(`INSERT INTO loop_calibration (type, band, policy_version, alpha, beta, n, updated_at) VALUES ('accept_claim', 4, 1, 1, 1, 0, now())`);
    // The owner's own types are still never calibrated.
    await expect(p.query(`INSERT INTO loop_calibration (type, band, policy_version, alpha, beta, n, updated_at) VALUES ('resolve_conflict', 4, 1, 1, 1, 0, now())`)).rejects.toThrow(/loop_calibration_type_check/);
    expect(await migrate(p, { dir })).toEqual([]);
  });

  test('0057: a label the loop counted before labelled_at existed (a loop-kept:<id> cursor) is carried over; the others wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-migrations-'));
    const all = await migrationIds();
    const upTo = all.slice(0, all.indexOf('0056_loop_facts_and_splits.sql') + 1);
    for (const f of upTo) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    const p = pool();
    await migrate(p, { dir });
    for (const id of ['dec:kept', 'dec:waiting']) {
      await p.query(`INSERT INTO decisions (id, type, project_key, status, tier, mode, score, confidence, band, rationale, policy_version, created_at, applied_at)
                     VALUES ($1, 'link_misses', 'demo', 'applied', 'H', 'auto', 0.9, '{}', 4, 'r', 1, now(), now())`, [id]);
    }
    await p.query(`INSERT INTO sync_cursors (key, value) VALUES ('loop-kept:dec:kept', '2026-11-01T00:00:00.000Z')`);
    writeFileSync(join(dir, '0057_loop_scale.sql'), readFileSync(new URL('0057_loop_scale.sql', MIGRATIONS), 'utf8'));
    expect(await migrate(p, { dir })).toEqual(['0057_loop_scale.sql']);
    const { rows } = await p.query('SELECT id, labelled_at IS NOT NULL AS labelled FROM decisions ORDER BY id');
    expect(rows).toEqual([{ id: 'dec:kept', labelled: true }, { id: 'dec:waiting', labelled: false }]);
  });

  test('0058: notes written before it are numbered in their table order, and new ones after them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-migrations-'));
    const all = await migrationIds();
    const upTo = all.slice(0, all.indexOf('0057_loop_scale.sql') + 1);
    for (const f of upTo) writeFileSync(join(dir, f), readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    const p = pool();
    await migrate(p, { dir });
    await p.query(`INSERT INTO decisions (id, type, project_key, status, tier, mode, score, confidence, band, rationale, policy_version, created_at)
                   VALUES ('dec:1', 'link_misses', 'demo', 'proposed', 'H', 'propose', 0.9, '{}', 4, 'r', 1, now())`);
    await p.query(`INSERT INTO decision_notes (id, decision_id, ts, by, text) VALUES ('dnote:b', 'dec:1', now(), 'you', 'first'), ('dnote:a', 'dec:1', now(), 'you', 'second')`);
    writeFileSync(join(dir, '0058_decision_notes_seq.sql'), readFileSync(new URL('0058_decision_notes_seq.sql', MIGRATIONS), 'utf8'));
    expect(await migrate(p, { dir })).toEqual(['0058_decision_notes_seq.sql']);
    await p.query(`INSERT INTO decision_notes (id, decision_id, ts, by, text) VALUES ('dnote:0', 'dec:1', now(), 'you', 'third')`);
    expect((await p.query('SELECT text FROM decision_notes ORDER BY seq')).rows.map((r) => r.text)).toEqual(['first', 'second', 'third']);
  });

  test('embeddings are pgvector columns with an HNSW cosine index over the configured dimension', async () => {
    const p = pool();
    await migrate(p, { embeddingDimensions: 1024 });
    const { rows } = await p.query(
      `SELECT c.table_name, c.udt_name FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'embedding' ORDER BY 1`,
    );
    expect(rows).toEqual(['chunks', 'claims', 'facts', 'lessons', 'misses'].map((table_name) => ({ table_name, udt_name: 'vector' })));
    const idx = await p.query(`SELECT tablename, indexdef FROM pg_indexes WHERE indexdef LIKE '%hnsw%' ORDER BY tablename`);
    expect(idx.rows.map((r) => r.tablename)).toEqual(['chunks', 'claims', 'facts', 'lessons', 'misses']);
    for (const r of idx.rows) expect(r.indexdef).toMatch(/vector\(1024\).*vector_cosine_ops/);
  });
});
