import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityInput, FactCheck, StoredFact } from '@fb/core';
import { expect, test } from 'vitest';
import { recheckFacts } from './recheck.ts';
import { FACT_CHECK_VERSION } from './scan.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'fbrecheck-'));
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('src/pool.ts', ['import pg from "pg";', 'export function createPool() {', '  return new pg.Pool();', '}', 'export const MAX_CLIENTS = 10;'].join('\n'));
  w('AGENTS.md', '# rules\n');
  w('package.json', '{}');
  mkdirSync(join(dir, 'packages/core'), { recursive: true });
  return dir;
}

let n = 0;
const stored = (path: string, statement: string, lines: string | null = null, over: Partial<StoredFact> = {}): StoredFact => ({
  id: `f${n++}`, kind: 'convention', statement, path, lines, confidence: 1, why: 'w', relevance: 0.5, relevanceBy: 'model', origin: 'model', evidence: null,
  source: 'codex-cli', createdAt: '2026-10-01T00:00:00.000Z', scanJobId: 'scan:1', fileHash: 'h', fileSummary: null, docId: null, ...over,
});

/** A store holding `facts` for project demo: factsToRecheck pages through those not stamped, applyFactChecks stamps them. */
function fakeStore(facts: StoredFact[]) {
  const stamped = new Map<string, string>();
  const applied: FactCheck[] = [];
  const removed: string[] = [];
  return {
    applied,
    removed,
    facts: {
      listFacts: async (q: { projectKey: string; limit?: number; offset?: number }) =>
        q.projectKey === 'demo' ? facts.filter((f) => !applied.some((c) => c.id === f.id && !c.keep)).slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 500)) : [],
      markFilesRemoved: async (_key: string, paths: string[]) => { removed.push(...paths); },
      factsToRecheck: async (q: { projectKey: string; version: string; limit: number }) =>
        q.projectKey === 'demo' ? facts.filter((f) => stamped.get(f.id) !== q.version).slice(0, q.limit) : [],
      applyFactChecks: async (version: string, checks: FactCheck[]) => {
        for (const c of checks) stamped.set(c.id, version);
        applied.push(...checks);
        return checks.filter((c) => !c.keep).length;
      },
    },
  };
}

test('facts checked by an older rule are checked again once: instruction-file and missing-file facts are closed, wrong lines dropped, and it is logged', async () => {
  const dir = repo();
  const facts = [
    stored('AGENTS.md', 'Webapp code lives under core'),
    stored('src/gone.ts', 'the old router is lazy'),
    stored('src/pool.ts', '`createPool` returns a new pg Pool', '2-4'),
    stored('src/pool.ts', '`MAX_CLIENTS` caps the pool', '1'), // it is on line 5
    stored('.', 'the API is a Hono app'),
    stored('packages/core', 'core holds the domain types', null, { evidence: 'none' }),
    stored('package.json', '`dev` script runs: vite', null, { origin: 'manifest' }),
  ];
  const { facts: store, applied, removed } = fakeStore(facts);
  const activity: ActivityInput[] = [];
  const r = await recheckFacts({ facts: store, projects: async () => [{ key: 'demo', repoPath: dir }], maxBytes: 80_000, activity: { record: async (a) => { activity.push(a); } }, batch: 3 });
  expect(r).toEqual({ checked: 7, closed: 2, linesDropped: 1, shortened: 0, recalibrated: 0 });
  const by = Object.fromEntries(applied.map((c) => [facts.find((f) => f.id === c.id)!.statement, c]));
  expect(by['Webapp code lives under core'].keep).toBe(false);
  expect(by['the old router is lazy'].keep).toBe(false);
  expect(by['`createPool` returns a new pg Pool']).toMatchObject({ keep: true, lines: '2-4', evidence: 'line' });
  expect(by['`MAX_CLIENTS` caps the pool']).toMatchObject({ keep: true, lines: null, evidence: 'file' });
  expect(by['the API is a Hono app']).toMatchObject({ keep: true, evidence: 'none' });
  // A shard's fact about its own directory is not a file to check.
  expect(by['core holds the domain types']).toMatchObject({ keep: true, lines: null, evidence: 'none' });
  expect(by['`dev` script runs: vite']).toMatchObject({ keep: true, evidence: 'file' });
  // The missing file is marked removed, so its hash is forgotten and the next scan reads it again if it comes back
  // (an older branch checked out at start-up): its facts are not closed for good. AGENTS.md is there: not removed.
  expect(removed).toEqual(['src/gone.ts']);
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({ kind: 'facts_extracted', actor: 'deterministic', projectKey: 'demo' });
  expect(activity[0].subject).toBe('rechecked 7 facts of demo: 2 closed, 1 lost its line range');
  expect(activity[0].why).toMatch(/AGENTS\.md/);
  expect(activity[0].details).toMatchObject({ checkVersion: FACT_CHECK_VERSION, closed: [expect.objectContaining({ path: 'AGENTS.md' }), expect.objectContaining({ path: 'src/gone.ts' })] });

  // Once: a second run finds nothing to do and logs nothing.
  expect(await recheckFacts({ facts: store, projects: async () => [{ key: 'demo', repoPath: dir }], maxBytes: 80_000, activity: { record: async (a) => { activity.push(a); } } })).toEqual({ checked: 0, closed: 0, linesDropped: 0, shortened: 0, recalibrated: 0 });
  expect(activity).toHaveLength(1);
});

test('a project whose folder is not there is left alone: its facts are not closed as "missing files"', async () => {
  const { facts: store, applied } = fakeStore([stored('src/pool.ts', 'x')]);
  const r = await recheckFacts({ facts: store, projects: async () => [{ key: 'demo', repoPath: join(tmpdir(), 'fb-no-such-folder') }], maxBytes: 80_000 });
  expect(r).toEqual({ checked: 0, closed: 0, linesDropped: 0, shortened: 0, recalibrated: 0 });
  expect(applied).toEqual([]);
});

test('when every file the facts cite is missing, the folder is taken to be the wrong one and nothing is closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbrecheck-empty-'));
  const { facts: store, applied } = fakeStore(Array.from({ length: 6 }, (_, i) => stored(`src/f${i}.ts`, `fact ${i}`)));
  const log: string[] = [];
  const r = await recheckFacts({ facts: store, projects: async () => [{ key: 'demo', repoPath: dir }], maxBytes: 80_000, log: (m) => log.push(m) });
  expect(r.closed).toBe(0);
  expect(applied).toEqual([]);
  expect(log.join()).toMatch(/skipped/);
});

test('a wrong mount where only package.json and the README exist is skipped for the whole project, and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbrecheck-wrong-'));
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  const facts = [stored('package.json', '`dev` script runs: vite', null, { origin: 'manifest' }), stored('README.md', 'the readme says hi'), ...Array.from({ length: 8 }, (_, i) => stored(`src/f${i}.ts`, `fact ${i}`))];
  const { facts: store, applied, removed } = fakeStore(facts);
  const log: { msg: string; extra?: object }[] = [];
  const r = await recheckFacts({ facts: store, projects: async () => [{ key: 'demo', repoPath: dir }], maxBytes: 80_000, batch: 3, log: (msg, extra) => log.push({ msg, extra }) });
  expect(r).toEqual({ checked: 0, closed: 0, linesDropped: 0, shortened: 0, recalibrated: 0 });
  expect(applied).toEqual([]);
  expect(removed).toEqual([]);
  expect(log[0].msg).toMatch(/skipped/);
  expect(log[0].extra).toMatchObject({ project: 'demo', citedFiles: 10, missingFiles: 8 });
});

test('the missing-file guard is per project, not per batch: one gone file among many is closed even when a batch holds only it', async () => {
  const dir = repo();
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, `src/k${i}.ts`), `export const k${i} = ${i};\n`);
  // Oldest path first: the gone file's facts fill a batch of their own.
  const facts = [...Array.from({ length: 5 }, (_, i) => stored('src/a-gone.ts', `gone ${i}`)), ...Array.from({ length: 6 }, (_, i) => stored(`src/k${i}.ts`, `k${i}`))];
  const { facts: store, removed } = fakeStore(facts);
  const r = await recheckFacts({ facts: store, projects: async () => [{ key: 'demo', repoPath: dir }], maxBytes: 80_000, batch: 5 });
  expect(r).toMatchObject({ checked: 11, closed: 5 });
  expect(removed).toEqual(['src/a-gone.ts']);
});

test('the new rules migrate stored facts once: a long dependency list is summarized (re-embedded), generous relevance calibrated, yours untouched, and it is logged', async () => {
  const dir = repo();
  const list = Array.from({ length: 200 }, (_, i) => `@acme/feature-${i} ^1.${i}.0`).join(', ');
  const facts = [
    stored('package.json', `Dependencies: react ^18, ${list}.`, null, { kind: 'dependency', origin: 'manifest', relevance: 0.5 }),
    stored('package.json', '`dev` script runs: vite', null, { kind: 'command', origin: 'manifest', relevance: 0.7 }),
    ...Array.from({ length: 6 }, (_, i) => stored('src/pool.ts', `\`createPool\` rule ${i}`, null, { kind: 'convention', relevance: 0.9 })),
    stored('src/pool.ts', '`createPool` returns a new pg Pool', null, { kind: 'api', relevance: 0.95 }),
    stored('src/pool.ts', '`MAX_CLIENTS` is 10', null, { kind: 'api', relevance: 0.95, relevanceBy: 'you' }),
  ];
  const { facts: store, applied } = fakeStore(facts);
  const relevance: { id: string; relevance: number; by: string }[] = [];
  const activity: ActivityInput[] = [];
  const embedded: string[][] = [];
  const r = await recheckFacts({
    facts: { ...store, setFactRelevance: async (u) => { relevance.push(...u); return u.length; } },
    projects: async () => [{ key: 'demo', repoPath: dir }],
    maxBytes: 80_000,
    activity: { record: async (a) => { activity.push(a); } },
    embed: async (texts) => { embedded.push(texts); return texts.map(() => [0.5]); },
  });
  const dep = applied.find((c) => c.id === facts[0].id)!;
  expect(dep.keep).toBe(true);
  expect(dep.statement!.length).toBeLessThanOrEqual(300);
  expect(dep.statement).toMatch(/^Dependencies \(201\): react \^18, /);
  expect(dep.embedding).toEqual([0.5]);
  expect(embedded.flat()).toEqual([`package.json: ${dep.statement}`]);
  // A statement that is fine is not rewritten.
  expect(applied.find((c) => c.id === facts[1].id)!.statement ?? null).toBeNull();
  // One endpoint's API is not everyday; past a quarter of the scored facts, conventions are not either. Yours stays.
  const byId = Object.fromEntries(relevance.map((u) => [u.id, u]));
  expect(byId[facts[8].id]).toEqual({ id: facts[8].id, relevance: 0.7, by: 'model' });
  expect(byId[facts[9].id]).toBeUndefined();
  expect(relevance.every((u) => u.by === 'model')).toBe(true);
  expect(r).toMatchObject({ shortened: 1, recalibrated: relevance.length });
  expect(activity.some((a) => /summarized/.test(a.subject) && /relevance/.test(a.subject))).toBe(true);
});

test('a dependency fact is summarized only when its list can be read; the original is kept in Activity so it can be restored', async () => {
  const dir = repo();
  const list = Array.from({ length: 200 }, (_, i) => `@acme/feature-${i} ^1.${i}.0`).join(', ');
  // A model's dependency fact with no "Dependencies:" section: cutting it would lose what it says. It is left alone.
  const prose = `The workspace pins ${list} through the root lockfile`;
  const facts = [
    stored('package.json', `Dependencies: react ^18, ${list}.`, null, { kind: 'dependency', origin: 'manifest' }),
    stored('package.json', prose, null, { kind: 'dependency' }),
  ];
  const { facts: store, applied } = fakeStore(facts);
  const activity: ActivityInput[] = [];
  await recheckFacts({ facts: store, projects: async () => [{ key: 'demo', repoPath: dir }], maxBytes: 80_000, activity: { record: async (a) => { activity.push(a); } } });
  expect(applied.find((c) => c.id === facts[1].id)!.statement ?? null).toBeNull();
  const shortened = activity.flatMap((a) => (a.details?.shortened ?? []) as { id: string; original?: string }[]);
  expect(shortened.map((s) => s.id)).toEqual([facts[0].id]);
  expect(shortened[0].original).toBe(facts[0].statement);
});

test('every summarized dependency fact keeps its original, past the listing cap too', async () => {
  const dir = repo();
  const list = Array.from({ length: 80 }, (_, i) => `@acme/feature-${i} ^1.${i}.0`).join(', ');
  const facts = Array.from({ length: 120 }, (_, i) => stored(`pkg${i}/package.json`, `Dependencies: react ^18, ${list}.`, null, { kind: 'dependency', origin: 'manifest' }));
  for (let i = 0; i < 120; i++) mkdirSync(join(dir, `pkg${i}`), { recursive: true }), writeFileSync(join(dir, `pkg${i}/package.json`), '{}');
  const { facts: store } = fakeStore(facts);
  const activity: ActivityInput[] = [];
  const r = await recheckFacts({ facts: store, projects: async () => [{ key: 'demo', repoPath: dir }], maxBytes: 80_000, activity: { record: async (a) => { activity.push(a); } } });
  expect(r.shortened).toBe(120);
  const originals = activity.flatMap((a) => (a.details?.shortened ?? []) as { id: string; original?: string }[]);
  expect(new Set(originals.map((s) => s.id)).size).toBe(120);
  expect(originals.every((s) => s.original?.startsWith('Dependencies: react ^18, '))).toBe(true);
});
