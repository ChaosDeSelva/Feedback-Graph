import { testStores } from '@fb/core/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { tx, type Db } from './db.ts';
import { openPostgresStore, type PostgresStore } from './store.ts';
import { recreateDatabase, testPgUrl, withDatabase } from './testing/harness.ts';
import { relatedMissesQuery, searchDocsQuery, searchFactsQuery, searchLessonsQuery, type SqlQuery } from './vector.ts';
import { PostgresProbe } from './testing/probe.ts';

/** Its own database (the run's name + _vector), so it never disturbs the contract suites' one. */
const url = withDatabase(testPgUrl(), (name) => `${name}_vector`);
/** The same database, with every plan that could avoid the HNSW index made as costly as Postgres allows. */
const forced = `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c enable_seqscan=off -c enable_bitmapscan=off -c enable_sort=off')}`;

const DIMS = 768;
/** A seeded generator (mulberry32), so every run sees the same vectors. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const random = rng(42);
const query = unit(Array.from({ length: DIMS }, random));
/**
 * The query plus random noise of the given size: the bigger the noise, the farther. Spread-out vectors like real
 * embeddings; near-duplicates would starve the HNSW graph of links, which no real model produces.
 */
const near = (noise: number) => {
  const n = unit(Array.from({ length: DIMS }, random));
  return unit(query.map((x, i) => x + noise * n[i]));
};
const COLUMNS = 'x.id, x.statement';

/** Which index the plan reads, from EXPLAIN (FORMAT JSON). */
async function indexesUsed(db: Db, q: SqlQuery, o: { force?: boolean } = {}): Promise<string[]> {
  return tx(db, async (c) => {
    if (o.force) for (const s of ['enable_seqscan', 'enable_bitmapscan', 'enable_sort']) await c.query(`SET LOCAL ${s} = off`);
    const { rows } = await c.query(`EXPLAIN (FORMAT JSON) ${q.sql}`, q.params);
    const found: string[] = [];
    const walk = (n: Record<string, unknown>) => {
      if (typeof n['Index Name'] === 'string') found.push(n['Index Name']);
      for (const child of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    walk(rows[0]['QUERY PLAN'][0].Plan);
    return found;
  });
}

describe.skipIf(!testStores().includes('postgres'))('Postgres vector searches use the HNSW indexes', () => {
  let store: PostgresStore;
  let pinned: PostgresStore;

  beforeAll(async () => {
    await recreateDatabase(url);
    store = await openPostgresStore({ url, max: 2 });
    await store.ensureSchema();
    pinned = await openPostgresStore({ url: forced, max: 2 });
    // demo: three facts / chunks / lessons a little off the query; other: 150 of each, all nearer to it.
    for (let i = 0; i < 150; i++) {
      await store.facts.saveFileFacts('other', { path: `o${i}.ts`, hash: 'h', summary: '' }, [
        { kind: 'convention', statement: `other ${i}`, path: `o${i}.ts`, lines: null, confidence: 1, why: '', embedding: near(0.5) },
      ], 'p');
    }
    for (let i = 0; i < 3; i++) {
      await store.facts.saveFileFacts('demo', { path: `d${i}.ts`, hash: 'h', summary: '' }, [
        { kind: 'convention', statement: `demo ${i}`, path: `d${i}.ts`, lines: null, confidence: 1, why: '', embedding: near(2 + i) },
      ], 'p');
    }
    await store.docs.upsertDoc({ projectKey: 'other', source: 'upload', ref: 'upload:o', title: 'o', url: null }, Array.from({ length: 150 }, (_, i) => ({ text: `other ${i}`, embedding: near(0.5) })));
    await store.docs.upsertDoc({ projectKey: 'demo', source: 'upload', ref: 'upload:d', title: 'd', url: null }, [0, 1, 2].map((i) => ({ text: `demo ${i}`, embedding: near(2 + i) })));
    for (let i = 0; i < 150; i++) {
      await store.knowledge.upsertLesson({ id: `mem:o${i}`, projectKey: 'other', title: `other ${i}`, rule: 'r', appliesWhen: '', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: near(0.5) });
    }
    for (let i = 0; i < 3; i++) {
      await store.knowledge.upsertLesson({ id: `mem:d${i}`, projectKey: 'demo', title: `demo ${i}`, rule: 'r', appliesWhen: '', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: near(2 + i) });
    }
    const probe = new PostgresProbe(store.db);
    for (let i = 0; i < 40; i++) await probe.seedEmbedded({ kind: 'Miss', id: `miss:${i}`, missed: `m ${i}`, causeExplanation: '', embedding: near(0.4) });
    await store.db.pool.query('ANALYZE');
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await pinned?.close();
  });

  const searches = (db: Db, length = DIMS): [string, SqlQuery][] => {
    const embedding = length === DIMS ? query : query.slice(0, length);
    return [
      ['facts_embedding', searchFactsQuery(db, { embedding, projectKey: 'demo', k: 2 }, COLUMNS)],
      ['chunks_embedding', searchDocsQuery(db, { embedding, projectKey: 'demo', k: 2 })],
      ['lessons_embedding', searchLessonsQuery(db, { embedding, projectKey: 'demo', k: 2 })],
      ['misses_embedding', relatedMissesQuery(db, { embedding, projectKey: null, k: 2 })],
    ];
  };

  test('every search is written so its HNSW index can serve it', async () => {
    for (const [index, q] of searches(store.db)) expect(await indexesUsed(store.db, q, { force: true }), index).toContain(index);
  });

  test('a query vector of another length cannot use the index, and is answered by an exact scan', async () => {
    for (const [index, q] of searches(store.db, 384)) {
      expect(q.sql).not.toContain('::vector(');
      expect(await indexesUsed(store.db, q, { force: true }), index).not.toContain(index);
    }
  });

  test('with enough rows the planner picks the index on its own', async () => {
    await store.db.pool.query(`INSERT INTO docs (id, project_key, source, ref, title, added_at) VALUES ('doc:big', 'big', 'upload', 'big', 'big', now())`);
    await store.db.pool.query(
      `INSERT INTO chunks (id, doc_id, project_key, idx, text, embedding)
       SELECT 'doc:big#' || g, 'doc:big', 'big', g, 't', ARRAY(SELECT random() FROM generate_series(1, ${DIMS}) WHERE g > 0)::vector
       FROM generate_series(1, 2000) g`,
    );
    await store.db.pool.query('ANALYZE chunks');
    expect(await indexesUsed(store.db, searchDocsQuery(store.db, { embedding: query, projectKey: 'big', k: 5 }))).toContain('chunks_embedding');
  }, 60_000);

  test('the index path returns what the exact scan returns, even when the nearest rows belong to other projects', async () => {
    const run = async (s: PostgresStore) => ({
      facts: (await s.facts.searchFacts({ embedding: query, projectKey: 'demo', k: 2 })).map((h) => [h.fact.statement, h.score.toFixed(6)]),
      docs: (await s.docs.searchDocs({ embedding: query, projectKey: 'demo', k: 2 })).map((h) => [h.text, h.score.toFixed(6)]),
      lessons: (await s.knowledge.searchLessons({ embedding: query, projectKey: 'demo', k: 2 })).map((h) => [h.lesson.title, h.score.toFixed(6)]),
    });
    const exact = await run(store);
    expect(exact.facts.map((f) => f[0])).toEqual(['demo 0', 'demo 1']);
    expect(exact.docs.map((f) => f[0])).toEqual(['demo 0', 'demo 1']);
    expect(exact.lessons.map((f) => f[0])).toEqual(['demo 0', 'demo 1']);
    expect(await run(pinned)).toEqual(exact);
    // And the forced store's plan really is the index (so the comparison above compared the two paths).
    expect(await indexesUsed(pinned.db, searchFactsQuery(pinned.db, { embedding: query, projectKey: 'demo', k: 2 }, COLUMNS))).toContain('facts_embedding');
  });

  // Last: it adds chunks to demo.
  test("another run's sandbox chunks, nearer than the project's own, are left out before the k nearest, through the index too", async () => {
    await store.docs.upsertDoc({ projectKey: 'demo', source: 'upload', ref: 'upload:sbx', title: 's', url: null }, Array.from({ length: 5 }, (_, i) => ({ text: `sandbox ${i}`, embedding: near(0.3) })), { run: { id: 'sbx-1', sandbox: true } });
    const docs = (s: PostgresStore, run?: string) => s.docs.searchDocs({ embedding: query, projectKey: 'demo', k: 2, run }).then((r) => r.map((h) => h.text));
    for (const s of [store, pinned]) {
      expect(await docs(s)).toEqual(['demo 0', 'demo 1']);
      expect(await docs(s, 'other-run')).toEqual(['demo 0', 'demo 1']);
      expect((await docs(s, 'sbx-1')).every((t) => t.startsWith('sandbox'))).toBe(true);
    }
    expect(await indexesUsed(pinned.db, searchDocsQuery(pinned.db, { embedding: query, projectKey: 'demo', k: 2, run: 'other-run' }))).toContain('chunks_embedding');
  });
});
