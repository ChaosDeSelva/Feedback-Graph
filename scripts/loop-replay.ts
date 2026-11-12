#!/usr/bin/env node
/**
 * The learning loop's held-out time-split replay (docs/operations.md "Measuring the learning loop").
 * For each cut T0 it runs the loop in observe over a store as it was at T0 and scores the decisions it would have made
 * against what the owner actually did after T0: precision and recall per decision type, for the tuning set and for a
 * frozen held-out set apart. Not a test: it prints a report.
 *
 * Without --restore or --demo it only reads the store it replays: no schema change, no start-up backfill, and every
 * store write refused (a Postgres store must already be at the current migrations). --restore and --demo first WIPE it, so it takes throwaway databases only
 * (as scripts/bench-search.ts): a Postgres database whose name contains "test", or a Neo4j on none of an install's bolt
 * ports (7687, 7689, .env's NEO4J_BOLT_PORT). A store this script did not wipe before that holds projects or lessons
 * is refused unless --wipe is given (asked again on a terminal): it may be an install's.
 *
 *   node scripts/loop-replay.ts --store postgres --url postgres://fg:fg@localhost:5433/fg_replay_test \
 *     [--restore backups/<timestamp> [--pg-container <container>]] | [--demo]
 *     [--t0 <ISO time>]... [--horizon-days 30] [--types approve_lesson,reject_lesson]
 *     [--split split.json | --freeze-split split.json --heldout-share 0.3] [--llm ollama:gemma4] [--json out.json] [--wipe]
 *   node scripts/loop-replay.ts --store neo4j --url bolt://127.0.0.1:7799 [--password testpassword] ...
 *
 * --restore loads a Postgres backup (scripts/backup.sh's postgres.dump) with pg_restore, run on this machine or in
 * --pg-container. A Neo4j backup is loaded into its own throwaway container first (docs/operations.md shows how).
 * --demo seeds a small synthetic history instead (packages/worker/src/loop/eval/demo.ts) and cuts it where the demo says.
 * --split: a frozen held-out set {"projects": [...], "months": ["YYYY-MM"]}; --freeze-split writes one (never over an
 * existing file) with --heldout-share of the store's projects, chosen by a fixed hash.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DECISION_TYPES, guardStore, makeProvider, neo4jStore, GraphRepo, withStoreWriteAuthorizer, type DecisionType, type Store } from '../packages/core/src/index.ts';
import { migrationIds } from '../packages/store-postgres/src/migrate.ts';
import { openPostgresStore } from '../packages/store-postgres/src/store.ts';
import { seedReplayDemo } from '../packages/worker/src/loop/eval/demo.ts';
import { formatReplayReport, freezeSplit, NO_SPLIT, runReplay, type ReplaySplit } from '../packages/worker/src/loop/eval/index.ts';
import { LOOP_TYPES } from '../packages/worker/src/loop/types/index.ts';

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

// The test harness's helpers import vitest, so the database is recreated here (pg is store-postgres's dependency).
type PgClient = { connect(): Promise<void>; query(q: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };
const pg = createRequire(new URL('../packages/store-postgres/package.json', import.meta.url))('pg') as {
  Client: new (o: { connectionString: string }) => PgClient;
};
/** Marks a store this script wiped: one it may wipe again without --wipe (a Postgres database comment, a Neo4j node). */
const SCRATCH = 'feedback-graph loop-replay scratch';
/** The database a URL names: wiped here, so a plain name containing "test". */
function databaseOf(u: string): string {
  const name = decodeURIComponent(new URL(u).pathname.slice(1));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !name.includes('test')) die(`database "${name}" is wiped first, so it must be a plain name containing "test"`);
  return name;
}
async function withPg<T>(u: string, db: string, fn: (c: PgClient) => Promise<T>): Promise<T> {
  const at = new URL(u);
  at.pathname = `/${db}`;
  const c = new pg.Client({ connectionString: at.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
async function recreateDatabase(u: string) {
  const name = databaseOf(u);
  await withPg(u, 'postgres', async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${name}"`);
    await c.query(`COMMENT ON DATABASE "${name}" IS '${SCRATCH}'`);
  });
}
/** What a wipe would delete that this script did not make: null when the store is empty or its own scratch store. */
async function foreignData(u: string): Promise<{ projects: number; lessons: number } | null> {
  const name = databaseOf(u);
  const [db] = (await withPg(u, 'postgres', (c) => c.query('SELECT shobj_description(oid, \'pg_database\') AS note FROM pg_database WHERE datname = $1', [name]))).rows;
  if (!db || db.note === SCRATCH) return null;
  const count = async (c: PgClient, table: string) =>
    (await c.query(`SELECT to_regclass('public.${table}') IS NOT NULL AS present`)).rows[0].present ? Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n) : 0;
  const found = await withPg(u, name, async (c) => ({ projects: await count(c, 'projects'), lessons: await count(c, 'lessons') }));
  return found.projects || found.lessons ? found : null;
}
async function foreignGraph(g: GraphRepo): Promise<{ projects: number; lessons: number } | null> {
  const [r] = await g.run('OPTIONAL MATCH (s:LoopReplayScratch) WITH count(s) AS s OPTIONAL MATCH (p:Project) WITH s, count(p) AS p OPTIONAL MATCH (l:Lesson) RETURN s, p, count(l) AS l');
  const n = (k: string) => Number(r.get(k));
  return n('s') || !(n('p') || n('l')) ? null : { projects: n('p'), lessons: n('l') };
}

const FLAGS = new Set(['demo', 'wipe']);
const OPTIONS = new Set(['store', 'url', 'user', 'password', 'restore', 'pg-container', 't0', 'horizon-days', 'types', 'split', 'freeze-split', 'heldout-share', 'llm', 'json']);
const args = new Map<string, string[]>();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  if (!FLAGS.has(k) && !OPTIONS.has(k)) die(`unknown option ${process.argv[i]}`);
  const v = FLAGS.has(k) ? 'true' : process.argv[++i];
  if (v === undefined) die(`--${k} needs a value`);
  args.set(k, [...(args.get(k) ?? []), v]);
}
const one = (k: string) => args.get(k)?.at(-1);

// Every argument is checked here, before anything connects: a bad one must not leave a wiped or half-seeded store.
const kind = one('store') ?? die('--store neo4j|postgres is required');
const url = one('url') ?? die('--url is required: the throwaway database to replay');
const wipe = args.has('restore') || args.has('demo');
if (kind === 'postgres') databaseOf(url);
else if (kind === 'neo4j') {
  const envBolt = existsSync(new URL('../.env', import.meta.url)) ? /^NEO4J_BOLT_PORT=["']?(\d+)/m.exec(readFileSync(new URL('../.env', import.meta.url), 'utf8'))?.[1] : undefined;
  const port = new URL(url).port || '7687';
  if (['7687', '7689', envBolt].includes(port)) die(`refusing bolt port ${port}: an install's own Neo4j listens there. Load the backup into a throwaway container on another port (docs/operations.md).`);
  if (args.has('restore')) die('a Neo4j backup is loaded with neo4j-admin into a throwaway container first, then replayed without --restore (docs/operations.md)');
} else die(`unknown --store ${kind}`);
const backup = one('restore');
if (backup && !existsSync(join(backup, 'postgres.dump'))) die(`no postgres.dump in ${backup}`);
const cuts = (args.get('t0') ?? []).map((t) => Date.parse(t) || die(`--t0 ${t} is not a time`));
if (!cuts.length && !args.has('demo')) die('name at least one --t0 (or --demo)');
const horizonArg = one('horizon-days') ?? '30';
const horizonDays = horizonArg === 'none' ? null : /^\d+(\.\d+)?$/.test(horizonArg) && Number(horizonArg) > 0 ? Number(horizonArg) : die(`--horizon-days ${horizonArg}: a number of days above 0, or none`);
const shareArg = one('heldout-share') ?? '0.3';
const share = /^(0(\.\d+)?|1(\.0+)?)$/.test(shareArg) ? Number(shareArg) : die(`--heldout-share ${shareArg}: a share from 0 to 1, such as 0.3`);
if (args.has('heldout-share') && !args.has('freeze-split')) die('--heldout-share goes with --freeze-split');
const freeze = one('freeze-split');
if (freeze && one('split')) die('--freeze-split and --split are alternatives: freeze a split once, then pass it with --split');
if (freeze && existsSync(freeze)) die(`${freeze} exists: a held-out split is frozen once and never redrawn`);
let split: ReplaySplit = NO_SPLIT;
const splitFile = one('split');
if (splitFile) {
  const s = (() => {
    try {
      return JSON.parse(readFileSync(splitFile, 'utf8')) as Partial<ReplaySplit>;
    } catch (err) {
      return die(`--split ${splitFile}: ${(err as Error).message}`);
    }
  })();
  split = { projects: s.projects ?? [], months: s.months ?? [] };
}
const only = one('types')?.split(',').map((t) => t.trim());
for (const t of only ?? []) if (!(DECISION_TYPES as readonly string[]).includes(t)) die(`unknown decision type ${t} (known: ${DECISION_TYPES.join(', ')})`);
const types = only ? LOOP_TYPES.filter((t) => only.includes(t.type as DecisionType)) : LOOP_TYPES;
const llm = one('llm') ? makeProvider(one('llm')!, process.env) : null;

/** A store with data this script did not put there may be an install's: only --wipe (confirmed on a terminal) wipes it. */
async function allowWipe(found: { projects: number; lessons: number } | null) {
  if (!found) return;
  const what = `${url} holds ${found.projects} projects and ${found.lessons} lessons that loop-replay did not write: it may be an install's store`;
  if (!args.has('wipe')) die(`refusing to wipe ${what}. Replay a throwaway copy, or pass --wipe if this store really is disposable.`);
  console.error(`WARNING: --wipe deletes everything in ${what}.`);
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`Type the URL (${url}) to wipe it: `);
  rl.close();
  if (answer.trim() !== url) die('not wiped');
}

async function open(): Promise<Store> {
  if (kind === 'neo4j') {
    const g = await GraphRepo.connect(url, one('user') ?? 'neo4j', one('password') ?? 'testpassword').catch((err: Error) => die(`cannot open Neo4j at ${url}: ${err.message}`));
    const s = neo4jStore(g);
    // Read as it is: an older store's Activity targets are found from their lists (the upgrade that links them is not run).
    if (!wipe) return s;
    await allowWipe(await foreignGraph(g));
    await g.run('MATCH (n) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS');
    await g.run('CREATE (:LoopReplayScratch {note: $note})', { note: SCRATCH });
    await s.ensureSchema();
    return s;
  }
  if (wipe) {
    await allowWipe(await foreignData(url).catch((err: Error) => die(`cannot open Postgres at ${url}: ${err.message}`)));
    await recreateDatabase(url);
  }
  if (backup) {
    const container = one('pg-container');
    const db = databaseOf(url);
    const dump = join(backup, 'postgres.dump');
    const r = container
      ? spawnSync('docker', ['exec', '-i', container, 'pg_restore', '--no-owner', '-U', decodeURIComponent(new URL(url).username), '-d', db], { input: readFileSync(dump), stdio: ['pipe', 'inherit', 'inherit'] })
      : spawnSync('pg_restore', ['--no-owner', `--dbname=${url}`, dump], { stdio: 'inherit' });
    if (r.error || r.status !== 0) die(`pg_restore failed${r.error ? `: ${r.error.message}` : ''} (no pg_restore here? pass --pg-container <the test Postgres container>)`);
  }
  const s = await openPostgresStore({ url, max: 4 });
  if (wipe || backup) {
    await s.ensureSchema();
    return s;
  }
  const { rows } = await s.db.pool.query<{ id: string }>('SELECT id FROM schema_migrations').catch(() => ({ rows: [] as { id: string }[] }));
  const missing = (await migrationIds()).filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) {
    await s.close();
    die(`${url} is not at the current schema (missing ${missing[0]}${missing.length > 1 ? ` and ${missing.length - 1} more` : ''}), and a replay without --restore or --demo changes nothing in the store it reads: start this version of Feedback Graph on it once, or replay a copy (--restore)`);
  }
  return s;
}

const opened = await open();
// A store read in place is read only: any write the replay would make is refused before it reaches the store.
const store = wipe ? opened : guardStore(opened);
const readOnly = <T>(fn: () => Promise<T>) => (wipe ? fn() : withStoreWriteAuthorizer(async () => { throw new Error('loop-replay reads the store it replays without --restore or --demo, and writes nothing to it'); }, fn));
try {
  if (args.has('demo')) {
    const demo = await seedReplayDemo(store);
    if (!cuts.length) cuts.push(demo.t0);
  }
  if (freeze) {
    const projects = (await store.facts.listProjects()).map((p) => p.key);
    split = freezeSplit(projects, share);
    writeFileSync(freeze, `${JSON.stringify(split, null, 2)}\n`);
    console.error(`froze ${split.projects.length} of ${projects.length} projects as held out in ${freeze}`);
  }

  const { cuts: results, report } = await readOnly(() => runReplay(
    { store, types, llm, log: (m) => console.error(m) },
    { cuts, horizonMs: horizonDays === null ? null : horizonDays * 86_400_000, split },
  ));
  console.log(formatReplayReport(report));
  const out = one('json');
  if (out) writeFileSync(out, `${JSON.stringify({ report, cuts: results }, null, 2)}\n`);
} finally {
  await opened.close();
}
