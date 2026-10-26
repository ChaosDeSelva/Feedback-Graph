#!/usr/bin/env node
/**
 * Micro-benchmark of the searches behind get_task_context (and search_graph): lessons, misses, facts and documents
 * by embedding, on Neo4j and Postgres. Not a test: it prints numbers.
 *
 * It WIPES the databases it is pointed at, so it only takes test databases:
 *   FG_BENCH_NEO4J_URL   default bolt://127.0.0.1:7688 (docker-compose.test.yml's neo4j-test), user neo4j,
 *                        password FG_BENCH_NEO4J_PASSWORD (default testpassword)
 *   FG_BENCH_PG_URL      default postgres://fg:fg@localhost:5433/fg_bench_test (the name must contain "test")
 *
 *   node scripts/bench-search.ts [--store neo4j|postgres|both] [--n 2000] [--concurrency 32] [--requests 640]
 *
 * --n is the lessons per project; each project also gets n/2 misses, 10n facts and n document chunks, in two projects
 * (the one searched and another as large). Each request is one get_task_context's four searches, in parallel, with no
 * run label. Two phases: the control (no sandbox record anywhere) and the same after one sandbox run wrote a fact, a
 * document and a report (so the searches must filter by run).
 */
import { openNeo4jStore, type GraphRepo, type Project, type PostMortem, type Store } from '../packages/core/src/index.ts';
import { openPostgresStore } from '../packages/store-postgres/src/store.ts';
import { recreateDatabase } from '../packages/store-postgres/src/testing/harness.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1] ?? '');
const N = Number(args.get('n') ?? 2000);
const CONCURRENCY = Number(args.get('concurrency') ?? 32);
const REQUESTS = Number(args.get('requests') ?? 640);
const STORES = (args.get('store') ?? 'both') === 'both' ? ['neo4j', 'postgres'] : [args.get('store')!];
const DIMS = 768;

/** Seeded (mulberry32), so every run and both stores see the same vectors. */
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
let random = rng(7);
const vector = () => unit(Array.from({ length: DIMS }, random));

const pm = (i: number): PostMortem => ({
  taskTitle: `task ${i}`, missed: `missed ${i}`, cause: 'requirement_unstated', causeExplanation: 'never stated', outcome: 'approved',
  lesson: { title: `lesson ${i}`, rule: 'r', appliesWhen: 'w', scope: 'project', paths: [] },
  contextItems: [],
});

async function seed(s: Store, key: string) {
  const project: Project = { key, name: key, repoPath: `/bench/${key}` };
  for (let i = 0; i < N; i++) {
    await s.knowledge.upsertLesson({ id: `mem:${key}:${i}`, projectKey: key, title: `${key} lesson ${i}`, rule: 'r', appliesWhen: '', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: vector() });
  }
  for (let i = 0; i < N / 2; i++) {
    const id = await s.knowledge.createManualFeedback({ project, cwd: project.repoPath, text: `report ${i}`, whatWasDone: 'x' });
    await s.graph.decide(id, 'confirmed', null, 'operator:bench');
    await s.knowledge.savePostmortem(id, pm(i), { miss: vector(), lesson: vector() });
  }
  for (let f = 0; f < N / 5; f++) {
    const path = `src/f${f}.ts`;
    await s.facts.saveFileFacts(key, { path, hash: `h${f}`, summary: '' }, Array.from({ length: 50 }, (_, i) => ({
      kind: 'convention' as const, statement: `${key} fact ${f}.${i}`, path, lines: null, confidence: 1, why: '', embedding: vector(),
    })), 'bench');
  }
  for (let d = 0; d < N / 50; d++) {
    await s.docs.upsertDoc({ projectKey: key, source: 'upload', ref: `doc${d}.md`, title: `doc ${d}`, url: null }, Array.from({ length: 50 }, (_, i) => ({ text: `${key} chunk ${d}.${i}`, embedding: vector() })));
  }
}

/** One get_task_context's searches (searchProject in packages/api/src/context.ts), with its k's. */
async function request(s: Store, embedding: number[]) {
  await Promise.all([
    s.knowledge.searchLessons({ embedding, projectKey: 'bench', k: 6, projectKeys: ['bench', 'other'], run: null }),
    s.knowledge.relatedMisses({ embedding, projectKey: 'bench', k: 12, run: null }),
    s.facts.searchFacts({ embedding, projectKey: 'bench', k: 30, run: null }),
    s.docs.searchDocs({ embedding, projectKey: 'bench', k: 5, run: null }),
  ]);
}

async function measure(s: Store) {
  random = rng(99);
  const queries = Array.from({ length: 64 }, vector);
  for (let i = 0; i < CONCURRENCY; i++) await request(s, queries[i % queries.length]); // warm up plans and caches
  const times: number[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < REQUESTS) {
      const i = next++;
      const t = performance.now();
      await request(s, queries[i % queries.length]);
      times.push(performance.now() - t);
    }
  }));
  const seconds = (performance.now() - started) / 1000;
  times.sort((a, b) => a - b);
  const pct = (p: number) => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))]);
  return { rps: (REQUESTS / seconds).toFixed(1), p50: pct(0.5), p95: pct(0.95) };
}

async function open(kind: string): Promise<Store> {
  if (kind === 'neo4j') {
    const s = await openNeo4jStore({ url: process.env.FG_BENCH_NEO4J_URL ?? 'bolt://127.0.0.1:7688', user: 'neo4j', password: process.env.FG_BENCH_NEO4J_PASSWORD ?? 'testpassword' });
    // In batches: one transaction deleting a large seed runs out of transaction memory.
    await (s.graph as GraphRepo).run('MATCH (n) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS');
    await s.ensureSchema();
    return s;
  }
  const url = process.env.FG_BENCH_PG_URL ?? 'postgres://fg:fg@localhost:5433/fg_bench_test';
  await recreateDatabase(url);
  const s = await openPostgresStore({ url, max: 10 });
  await s.ensureSchema();
  return s;
}

for (const kind of STORES) {
  const s = await open(kind);
  const t = performance.now();
  random = rng(7);
  await seed(s, 'bench');
  await seed(s, 'other');
  if (kind === 'neo4j') await (s.graph as GraphRepo).run('CALL db.awaitIndexes(600)');
  else await (s as Store & { db: { pool: { query(q: string): Promise<unknown> } } }).db.pool.query('ANALYZE');
  console.log(`${kind}: seeded ${N} lessons, ${N / 2} misses, ${N * 10} facts, ${N} chunks per project, 2 projects, in ${((performance.now() - t) / 1000).toFixed(0)} s`);
  const control = await measure(s);
  console.log(`${kind}  control (no sandbox record)   ${control.rps} req/s  p50 ${control.p50} ms  p95 ${control.p95} ms`);
  // One sandbox run writes a fact, a document and a report: from now on the searches filter by run.
  const sbx = { id: 'bench-sbx', sandbox: true };
  await s.facts.addOwnerFact('bench', { kind: 'convention', statement: 'sandbox fact', path: '.', lines: null, confidence: 1, why: 'w', embedding: vector() }, 'operator:bench', sbx);
  await s.docs.upsertDoc({ projectKey: 'bench', source: 'upload', ref: 'sbx.md', title: 'sbx', url: null }, [{ text: 'sandbox chunk', embedding: vector() }], { run: sbx });
  await s.knowledge.createManualFeedback({ project: { key: 'bench', name: 'bench', repoPath: '/bench/bench' }, cwd: '/bench/bench', text: 'sandbox report', whatWasDone: 'x', run: sbx });
  const sandboxed = await measure(s);
  console.log(`${kind}  with a sandbox run           ${sandboxed.rps} req/s  p50 ${sandboxed.p50} ms  p95 ${sandboxed.p95} ms`);
  await s.close();
}
