#!/usr/bin/env node
/**
 * The approve score's time-split backtest (0.9.5; docs/operations.md "Measuring the approve score"). For each kind
 * (Inbox items, lessons, claims) it takes the items you decided (decidedBy 'you'), oldest verdict first, fits the
 * score's logistic model (core loop/itemScore.ts) on the older share and scores the newer ones, each from only the
 * verdicts you made before it (VerdictsStore.neighbours with priorOnly). It prints the AUC and the approve rate per
 * score decile on the newer share, for the score and for each of its parts alone, then the coefficients fitted on every
 * verdict: what core/thresholds.ts APPROVE_SCORE_MODEL holds. Numbers and feature names only: no item text, id or
 * project name is printed.
 *
 *   node scripts/score-eval.ts --store neo4j --url bolt://127.0.0.1:7688 [--password testpassword]
 *     [--kinds candidate,lesson,claim] [--train-share 0.7] [--embed-inbox http://127.0.0.1:11434] [--fixture] [--json out.json]
 *   node scripts/score-eval.ts --store postgres --url postgres://fg:fg@localhost:5433/fg_test ...
 *
 * It reads the store and writes nothing to it, except with --embed-inbox: then Inbox items stored without an embedding
 * are embedded first (nomic-embed-text, as the worker's backfill does), which only a throwaway copy may take (a Neo4j
 * on none of an install's bolt ports, a Postgres database whose name contains "test"). Load a backup into one first.
 * --fixture seeds the integration tests' synthetic history (core testing/scoreFixture.ts) into such a store first; the
 * store must hold no projects or lessons yet (a fresh test database).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  APPROVE_SCORE_MODEL, candidateFeatures, claimFeatures, fromItem, guardStore, GraphRepo, lessonFeatures, logit, neo4jStore, ollamaEmbed,
  VERDICT_NEIGHBOURS, verdictEvidence, withStoreWriteAuthorizer,
  type Feature, type ScoreModel, type Store, type VerdictItem, type VerdictKind, type VerdictNeighbour,
} from '../packages/core/src/index.ts';
import { openPostgresStore } from '../packages/store-postgres/src/store.ts';
import { seedScoreFixture } from '../packages/core/src/testing/scoreFixture.ts';
import { embedInboxBacklog } from '../packages/worker/src/inboxEmbed.ts';

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const OPTIONS = new Set(['store', 'url', 'user', 'password', 'kinds', 'train-share', 'embed-inbox', 'json']);
const FLAGS = new Set(['fixture']);
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  if (!OPTIONS.has(k) && !FLAGS.has(k)) die(`unknown option ${process.argv[i]}`);
  const v = FLAGS.has(k) ? 'true' : process.argv[++i];
  if (v === undefined) die(`--${k} needs a value`);
  args.set(k, v);
}
const kind = args.get('store') ?? die('--store neo4j|postgres is required');
const url = args.get('url') ?? die('--url is required');
const kinds = (args.get('kinds') ?? 'candidate,lesson,claim').split(',') as VerdictKind[];
if (kinds.some((k) => !['candidate', 'lesson', 'claim'].includes(k))) die(`--kinds: candidate, lesson, claim`);
const trainShare = Number(args.get('train-share') ?? '0.7');
if (!(trainShare > 0.2 && trainShare < 0.95)) die('--train-share: between 0.2 and 0.95');
const embedUrl = args.get('embed-inbox');
const fixture = args.has('fixture');
if (embedUrl || fixture) {
  if (kind === 'postgres' && !decodeURIComponent(new URL(url).pathname.slice(1)).includes('test')) die('--embed-inbox and --fixture write: only a Postgres database whose name contains "test"');
  if (kind === 'neo4j') {
    const envBolt = existsSync(new URL('../.env', import.meta.url)) ? /^NEO4J_BOLT_PORT=["']?(\d+)/m.exec(readFileSync(new URL('../.env', import.meta.url), 'utf8'))?.[1] : undefined;
    const port = new URL(url).port || '7687';
    if (['7687', '7689', envBolt].includes(port)) die(`--embed-inbox and --fixture write: refusing bolt port ${port}, where an install's own Neo4j listens. Load a backup into a throwaway container.`);
  }
}

async function open(): Promise<Store> {
  if (kind === 'neo4j') return neo4jStore(await GraphRepo.connect(url, args.get('user') ?? 'neo4j', args.get('password') ?? 'testpassword').catch((err: Error) => die(`cannot open Neo4j at ${url}: ${err.message}`)));
  if (kind === 'postgres') return openPostgresStore({ url, max: 4 });
  return die(`unknown --store ${kind}`);
}
const opened = await open();
const store = guardStore(opened);
const readOnly = <T>(fn: () => Promise<T>) => withStoreWriteAuthorizer(async () => { throw new Error('score-eval reads the store and writes nothing to it'); }, fn);

/** Neighbours are read this wide once, then cut per floor tried (the same answer as a lookup at that floor, at k). */
const WIDE_K = 50;
const FLOORS = [0.4, 0.5, 0.6, 0.7, 0.8];
/**
 * L2 penalties tried (not on the intercept): a stronger one keeps a feature seen a handful of times, or one whose
 * meaning drifted, from a large coefficient. Chosen with the floor on the older share.
 */
const L2S = [1, 10, 30, 100];

type Row = { id: string; approved: boolean; features: Feature[]; near: VerdictNeighbour[] };

async function rowsOf(k: VerdictKind): Promise<Row[]> {
  const verdicts: VerdictItem[] = await store.verdicts.ownerVerdicts(k);
  const ids = verdicts.map((v) => v.id);
  const featuresById = new Map<string, Feature[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const page = ids.slice(i, i + 200);
    if (k === 'candidate') for (const c of await store.graph.listCandidates({ ids: page, limit: page.length })) featuresById.set(c.id, candidateFeatures(c));
    if (k === 'lesson') for (const l of await store.knowledge.listLessons({ ids: page, limit: page.length })) featuresById.set(l.id, lessonFeatures(l));
    if (k === 'claim') for (const c of await store.intake.listClaims({ ids: page, limit: page.length })) featuresById.set(c.id, claimFeatures(c));
  }
  const near: Record<string, VerdictNeighbour[]> = {};
  for (let i = 0; i < ids.length; i += 50) Object.assign(near, await store.verdicts.neighbours({ kind: k, ids: ids.slice(i, i + 50), k: WIDE_K, minCosine: Math.min(...FLOORS), priorOnly: true }));
  return verdicts.filter((v) => featuresById.has(v.id)).map((v) => ({ id: v.id, approved: !!v.approved, features: featuresById.get(v.id)!, near: near[v.id] ?? [] }));
}

/** The neighbours a lookup at this floor and VERDICT_NEIGHBOURS would return, from the wide read. */
const cut = (near: VerdictNeighbour[], floor: number) => near.filter((n) => n.cosine >= floor).slice(0, VERDICT_NEIGHBOURS);
const rate = (rows: Row[]) => (rows.filter((r) => r.approved).length + 1) / (rows.length + 2);

/** The design matrix: [1, neighbours term, features...], the terms itemChance (core loop/itemScore.ts) adds up. */
function design(rows: Row[], names: string[], base: number, floor: number, useKnn: boolean, useFeatures: boolean): number[][] {
  return rows.map((r) => [
    1,
    useKnn ? logit(verdictEvidence(cut(r.near, floor), base, floor).p) - logit(base) : 0,
    ...names.map((n) => (useFeatures ? r.features.find((f) => f.name === n)?.x ?? 0 : 0)),
  ]);
}

/** Logistic regression by Newton's method with an L2 penalty (not on the intercept). */
function fit(X: number[][], y: number[], l2: number): number[] {
  const d = X[0].length;
  let w = new Array<number>(d).fill(0);
  for (let it = 0; it < 50; it++) {
    const g = new Array<number>(d).fill(0);
    const H = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    X.forEach((x, i) => {
      const p = 1 / (1 + Math.exp(-x.reduce((s, v, j) => s + v * w[j], 0)));
      for (let a = 0; a < d; a++) {
        g[a] += (p - y[i]) * x[a];
        for (let b = 0; b < d; b++) H[a][b] += p * (1 - p) * x[a] * x[b];
      }
    });
    for (let a = 1; a < d; a++) {
      g[a] += l2 * w[a];
      H[a][a] += l2;
    }
    for (let a = 0; a < d; a++) H[a][a] += 1e-9;
    const step = solve(H, g);
    w = w.map((v, j) => v - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return w;
}
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}

/** The area under the ROC curve (ties count half): 0.5 is no better than chance. */
function auc(scores: number[], y: boolean[]): number | null {
  const pos = scores.filter((_, i) => y[i]);
  const neg = scores.filter((_, i) => !y[i]);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** The newer share sorted by score, cut into ten bins (fewer when it holds fewer than ten): mean score, approve rate. */
function deciles(scores: number[], y: boolean[]): { bin: number; n: number; meanScore: number; approveRate: number }[] {
  const order = scores.map((s, i) => ({ s, y: y[i] })).sort((a, b) => a.s - b.s);
  const bins = Math.min(10, order.length);
  return Array.from({ length: bins }, (_, b) => {
    const part = order.slice(Math.floor((b * order.length) / bins), Math.floor(((b + 1) * order.length) / bins));
    return { bin: b + 1, n: part.length, meanScore: part.reduce((t, p) => t + p.s, 0) / part.length, approveRate: part.filter((p) => p.y).length / part.length };
  });
}

const modelOf = (w: number[], names: string[], base: number, featureLabels: number, floor: number): ScoreModel =>
  ({ floor, base, intercept: w[0], verdicts: w[1], features: Object.fromEntries(names.map((n, i) => [n, w[i + 2]])), featureLabels });
/** The served score (0-10, after the shrink toward 5) of each row under this model and floor. */
const served = (k: VerdictKind, rows: Row[], m: ScoreModel) => rows.map((r) => Math.round(fromItem(k, r.features, cut(r.near, m.floor), m).q * 100) / 10);
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

const report: Record<string, unknown> = {};
try {
  if (fixture) {
    await opened.ensureSchema();
    if ((await opened.facts.listProjects()).length || (await opened.knowledge.listLessons({ limit: 1 })).length) die('--fixture: the store already holds projects or lessons; give it a fresh test database');
    const seeded = await seedScoreFixture(opened, { items: 90 });
    console.log(`seeded the fixture: ${seeded.candidates.length} Inbox verdicts and ${seeded.lessons.length} lesson verdicts`);
  }
  if (embedUrl) {
    const embedded = await embedInboxBacklog({ verdicts: opened.verdicts, embed: (input) => ollamaEmbed({ url: embedUrl, model: 'nomic-embed-text', input }), log: () => {} });
    let more = embedded;
    let total = embedded;
    while (more) total += more = await embedInboxBacklog({ verdicts: opened.verdicts, embed: (input) => ollamaEmbed({ url: embedUrl, model: 'nomic-embed-text', input }), log: () => {} });
    console.log(`embedded ${total} Inbox items stored without an embedding`);
  }
  await readOnly(async () => {
    for (const k of kinds) {
      const all = await rowsOf(k);
      const withNear = all.filter((r) => cut(r.near, Math.min(...FLOORS)).length).length;
      console.log(`\n== ${k}: ${all.length} of your verdicts (${all.filter((r) => r.approved).length} approve), ${withNear} with an earlier verdict at cosine >= ${Math.min(...FLOORS)}`);
      if (all.length < 20 || all.every((r) => r.approved) || all.every((r) => !r.approved)) {
        console.log('   too few verdicts (or all one way) to fit or test: the model keeps its stated coefficients');
        report[k] = { verdicts: all.length, fitted: false };
        continue;
      }
      const names = all[0].features.map((f) => f.name);
      const split = Math.floor(all.length * trainShare);
      const [train, test] = [all.slice(0, split), all.slice(split)];
      const base = rate(train);
      const featureLabels = APPROVE_SCORE_MODEL[k].featureLabels;
      const y = (rows: Row[]) => rows.map((r) => (r.approved ? 1 : 0));
      // The floor and the penalty: chosen on the older share alone (fit on its first part, AUC on the rest), never on
      // the newer one.
      const inner = Math.floor(train.length * trainShare);
      const [fitPart, checkPart] = [train.slice(0, inner), train.slice(inner)];
      const grid = FLOORS.flatMap((floor) => L2S.map((l2) => {
        const m = modelOf(fit(design(fitPart, names, rate(fitPart), floor, true, true), y(fitPart), l2), names, rate(fitPart), featureLabels, floor);
        return { floor, l2, auc: auc(served(k, checkPart, m), checkPart.map((r) => r.approved)) ?? 0 };
      }));
      const { floor, l2 } = grid.reduce((a, b) => (b.auc > a.auc + 1e-9 ? b : a));
      const variants = {
        score: fit(design(train, names, base, floor, true, true), y(train), l2),
        neighboursOnly: fit(design(train, names, base, floor, true, false), y(train), l2),
        featuresOnly: fit(design(train, names, base, floor, false, true), y(train), l2),
      };
      const truth = test.map((r) => r.approved);
      const results = Object.fromEntries(Object.entries(variants).map(([name, w]) => {
        const s = served(k, test, modelOf(w, names, base, featureLabels, floor));
        return [name, { auc: auc(s, truth), deciles: deciles(s, truth) }];
      }));
      // 0.9.4's fallback for an item with no loop call: the classifier, lesson checks or claim confidence as one signal.
      // (With a call it gave every item in a band the same score: AUC 0.5 within a band.)
      const signal = test.map((r) => r.features[0].x * (k === 'lesson' ? -1 : 1));
      const testNear = test.filter((r) => cut(r.near, floor).length).length;
      console.log(`   time split: fit on the older ${train.length}, scored the newer ${test.length} (${testNear} with similar earlier verdicts); base approve rate ${round(base, 2)}`);
      console.log(`   cosine floor ${floor}, L2 ${l2}: chosen on the older share (inner AUC ${round(grid.find((g) => g.floor === floor && g.l2 === l2)!.auc)}; per floor at that L2 ${grid.filter((g) => g.l2 === l2).map((g) => `${g.floor}: ${round(g.auc)}`).join(', ')})`);
      for (const [name, r] of Object.entries(results)) console.log(`   AUC ${name.padEnd(15)} ${r.auc === null ? 'n/a' : round(r.auc)}`);
      console.log(`   AUC ${'0.9.4 signal'.padEnd(15)} ${round(auc(signal, truth) ?? 0)}`);
      console.log('   decile  n  mean score  approve rate   (the score, newer share, lowest first)');
      for (const d of results.score.deciles) console.log(`   ${String(d.bin).padStart(6)} ${String(d.n).padStart(2)}  ${d.meanScore.toFixed(1).padStart(10)}  ${d.approveRate.toFixed(2).padStart(12)}`);
      // The served coefficients: refitted on every verdict, at the floor and penalty chosen above.
      const finalBase = rate(all);
      const final = modelOf(fit(design(all, names, finalBase, floor, true, true), y(all), l2), names, finalBase, featureLabels, floor);
      const rounded = { ...final, base: round(final.base, 2), intercept: round(final.intercept, 2), verdicts: round(final.verdicts, 2), features: Object.fromEntries(Object.entries(final.features).map(([n, v]) => [n, round(v, 2)])) };
      console.log(`   fitted on all ${all.length} (floor ${floor}, L2 ${l2}): ${JSON.stringify(rounded)}`);
      report[k] = { verdicts: all.length, approved: all.filter((r) => r.approved).length, train: train.length, test: test.length, testWithNeighbours: testNear, floor, l2, grid, results, signalAuc: auc(signal, truth), model: rounded };
    }
  });
  const out = args.get('json');
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n(served now: k ${VERDICT_NEIGHBOURS}; floors ${kinds.map((k) => `${k} ${APPROVE_SCORE_MODEL[k].floor}`).join(', ')})`);
} finally {
  await opened.close();
}
