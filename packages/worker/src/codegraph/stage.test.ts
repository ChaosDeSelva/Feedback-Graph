import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityInput, CodeMapMeta, CodeMapWrite, StoredCodeMap } from '@fb/core';
import { afterEach, expect, test } from 'vitest';
import { gitStatusTimeoutMs, MapStage, repoFingerprint, type MapStageDeps } from './stage.ts';
import type { BuildOpts, CodeMap } from './types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fbstage-'));
  dirs.push(d);
  return d;
};
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' });

test('repoFingerprint changes with a commit or a dirty file, and is null outside git', async () => {
  const dir = tmp();
  expect(await repoFingerprint(dir, 100)).toBeNull();
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'a');
  const clean = await repoFingerprint(dir, 100);
  expect(clean).toMatch(/^[0-9a-f]{64}$/);
  expect(await repoFingerprint(dir, 100)).toBe(clean);
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
  const dirty = await repoFingerprint(dir, 100);
  expect(dirty).not.toBe(clean);
  writeFileSync(join(dir, 'a.ts'), 'export const a = 22;\n');
  expect(await repoFingerprint(dir, 100)).not.toBe(dirty);
  git(dir, 'commit', '-qam', 'b');
  expect(await repoFingerprint(dir, 100)).not.toBe(clean);
});

test('repoFingerprint never takes git locks (the repo is a read-only mount) and logs a git status that timed out', async () => {
  const calls: string[][] = [];
  const logged: [string, object | undefined][] = [];
  const timeout = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args.includes('--show-toplevel')) return '/repo\n';
    if (args.includes('status')) throw timeout;
    return 'abc\n';
  };
  // Without status the fingerprint cannot tell a dirty tree from a clean one: rebuild on the interval instead.
  expect(await repoFingerprint('/repo', 100, { exec, log: (m, e) => logged.push([m, e]) })).toBeNull();
  for (const a of calls) expect(a.indexOf('--no-optional-locks')).toBeGreaterThanOrEqual(0);
  for (const a of calls) expect(a.indexOf('--no-optional-locks')).toBeLessThan(a.indexOf('-C'));
  expect(logged).toEqual([
    ['git status timed out', expect.objectContaining({ repoPath: '/repo' })],
    ['git status timed out', expect.objectContaining({ repoPath: '/repo', untracked: 'no' })],
  ]);
});

test('a git status that times out is tried once more without untracked files (the slow part on a big tree)', async () => {
  const timeouts: (number | undefined)[] = [];
  const timeout = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
  const exec = async (args: string[], timeoutMs?: number) => {
    if (args.includes('--show-toplevel')) return '/repo\n';
    if (args.includes('status')) {
      timeouts.push(timeoutMs);
      if (args.includes('--untracked-files=normal')) throw timeout;
      return '';
    }
    return 'abc\n';
  };
  const fp = await repoFingerprint('/repo', 100, { exec, timeoutMs: 90_000 });
  expect(fp).toMatch(/^[0-9a-f]{64}$/);
  expect(timeouts).toEqual([90_000, 90_000]);
});

test('the git status timeout grows with the repo: 30 s, plus 10 ms a file, at most 5 minutes', () => {
  expect(gitStatusTimeoutMs(0)).toBe(30_000);
  expect(gitStatusTimeoutMs(10_000)).toBe(130_000);
  expect(gitStatusTimeoutMs(1_000_000)).toBe(300_000);
});

const map: CodeMap = {
  files: [
    { path: 'src/db.ts', lang: 'typescript', hash: 'h1', loc: 3, isTest: false },
    { path: 'test/db.test.ts', lang: 'typescript', hash: 'h2', loc: 3, isTest: true },
  ],
  symbols: [{ id: 'src/db.ts#Db', path: 'src/db.ts', name: 'Db', kind: 'class', exported: true, lines: '1-3' }],
  imports: [{ from: 'test/db.test.ts', to: 'src/db.ts', names: ['Db'], spec: '../src/db.ts' }],
};

function fakes(over: Partial<MapStageDeps> = {}) {
  let stored: (StoredCodeMap & { write: CodeMapWrite }) | null = null;
  const writes: CodeMapWrite[] = [];
  const builds: { repo: string; prev: CodeMap | undefined }[] = [];
  const activity: ActivityInput[] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  let fp: string | null = 'fp1';
  const deps: MapStageDeps = {
    store: {
      codeMapMeta: async (): Promise<CodeMapMeta | null> => stored && { fingerprint: stored.fingerprint, builtAt: stored.builtAt, stats: stored.stats, candidates: stored.write.candidates ?? null },
      codeMap: async () => stored,
      replaceCodeMap: async (_key, w) => {
        writes.push(w);
        const stats = { files: w.files.length, symbols: w.symbols.length, imports: w.imports.length, tests: w.tests.length };
        stored = { fingerprint: w.fingerprint, builtAt: 't', stats, candidates: w.candidates ?? null, files: w.files, symbols: w.symbols, imports: w.imports, write: w };
        return stats;
      },
    },
    activity: { record: async (a) => { activity.push(a); } },
    projects: async () => [{ key: 'demo', repoPath: '/vibe/demo' }],
    build: async (repo, _opts, prev) => { builds.push({ repo, prev }); return map; },
    churn: async () => new Map([['src/db.ts', { commits: 4, lastTs: '2026-10-20T00:00:00.000Z' }]]),
    fingerprint: async () => fp,
    maxFiles: 100,
    maxBytes: 1000,
    minIntervalMs: 60_000,
    log: (m) => logs.push(m),
    now: () => clock,
    ...over,
  };
  return {
    deps, writes, builds, activity, logs,
    tick: (ms: number) => { clock += ms; },
    setFingerprint: (v: string | null) => { fp = v; },
  };
}

test('a first pass maps each selected project, with test links and churn, and logs the build', async () => {
  const f = fakes();
  const stage = new MapStage(f.deps);
  await stage.pass();
  expect(f.builds).toEqual([{ repo: '/vibe/demo', prev: undefined }]);
  expect(f.writes[0]).toMatchObject({
    tests: [{ test: 'test/db.test.ts', target: 'src/db.ts' }],
    churn: { 'src/db.ts': { commits: 4, lastTs: '2026-10-20T00:00:00.000Z' } },
    fingerprint: 'fp1',
  });
  expect(f.activity).toEqual([expect.objectContaining({
    kind: 'code_mapped', actor: 'deterministic', projectKey: 'demo',
    subject: 'code map built: 2 files, 1 symbol, 1 import edge, 1 test link',
    why: 'first map of this project',
    details: expect.objectContaining({ files: 2, symbols: 1, imports: 1, tests: 1, durationMs: expect.any(Number), incremental: false }),
  })]);
});

test('a capped map says so: candidates are stored and logged, and files sessions edited are kept first', async () => {
  const opts: BuildOpts[] = [];
  const logged: [string, object | undefined][] = [];
  const f = fakes({
    build: async (_repo, o) => { opts.push(o); return { ...map, candidates: 10_290 }; },
    editedPaths: async (key) => (key === 'demo' ? ['src/webapp/page.tsx'] : []),
    maxFiles: null,
    log: (m, e) => logged.push([m, e]),
  });
  await new MapStage(f.deps).pass();
  expect(opts[0]).toMatchObject({ maxFiles: null, priority: ['src/webapp/page.tsx'] });
  expect(f.writes[0].candidates).toBe(10_290);
  expect(logged).toContainEqual(['code map capped', { project: 'demo', mapped: 2, totalCandidates: 10_290 }]);
  expect(f.activity[0].subject).toBe('code map built: 2 of 10290 files (capped), 1 symbol, 1 import edge, 1 test link');
  expect(f.activity[0].details).toMatchObject({ candidates: 10_290 });
});

test('the fingerprint is given a git status timeout that grows with the last map', async () => {
  const seen: (number | undefined)[] = [];
  const f = fakes({ fingerprint: async (_r, _m, o) => { seen.push(o?.timeoutMs); return 'fp1'; } });
  const stage = new MapStage(f.deps);
  await stage.mapProject({ key: 'demo', repoPath: '/vibe/demo' }, null);
  await stage.mapProject({ key: 'demo', repoPath: '/vibe/demo' }, null);
  expect(seen).toEqual([gitStatusTimeoutMs(0), gitStatusTimeoutMs(2)]);
});

test('an unchanged repo is not rebuilt; a changed one is, incrementally, but not more often than the interval', async () => {
  const f = fakes();
  const stage = new MapStage(f.deps);
  await stage.pass();
  f.tick(120_000);
  await stage.pass();
  expect(f.builds).toHaveLength(1); // same fingerprint
  f.setFingerprint('fp2');
  await stage.pass();
  expect(f.builds).toHaveLength(1); // checked less than a minute ago
  f.tick(61_000);
  await stage.pass();
  expect(f.builds).toHaveLength(2);
  expect(f.builds[1].prev?.files.map((x) => x.path)).toEqual(['src/db.ts', 'test/db.test.ts']);
  expect(f.activity.at(-1)).toMatchObject({ why: 'the repo changed since the last map', details: expect.objectContaining({ incremental: true }) });
});

test('a folder that is not a git repo is rebuilt each interval (incrementally: unchanged files are not reparsed)', async () => {
  const f = fakes();
  f.setFingerprint(null);
  const stage = new MapStage(f.deps);
  await stage.pass();
  f.tick(61_000);
  await stage.pass();
  expect(f.builds).toHaveLength(2);
});

test('a scan maps its project first, ignoring the interval but not the fingerprint', async () => {
  const f = fakes();
  const stage = new MapStage(f.deps);
  await stage.pass();
  f.setFingerprint('fp2');
  const r = await stage.mapProject({ key: 'demo', repoPath: '/vibe/demo' }, 'a scan was requested');
  expect(r).toMatchObject({ files: 2 });
  expect(f.builds).toHaveLength(2);
  expect(await stage.mapProject({ key: 'demo', repoPath: '/vibe/demo' }, 'a scan was requested')).toBeNull();
});

test('a failing build is logged and the pass goes on; kick() never throws and runs one pass at a time', async () => {
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = fakes({
    projects: async () => [{ key: 'bad', repoPath: '/vibe/bad' }, { key: 'demo', repoPath: '/vibe/demo' }],
    build: async (repo) => {
      started++;
      if (repo.endsWith('bad')) throw new Error('boom');
      await gate;
      return map;
    },
  });
  const stage = new MapStage(f.deps);
  stage.kick();
  stage.kick();
  await new Promise((r) => setTimeout(r, 10));
  expect(started).toBe(2);
  release();
  await stage.idle();
  expect(f.logs).toContain('code map failed');
  expect(f.writes).toHaveLength(1);
});

test('the map is written inside the exclusive section cleanup and project delete use, never beside one', async () => {
  const events: string[] = [];
  let held = false;
  const f = fakes({
    exclusive: async <T>(fn: () => Promise<T>) => {
      events.push('lock');
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
        events.push('unlock');
      }
    },
    build: async () => {
      // The slow parse runs outside the lock: ingest and Settings are not held up by it.
      events.push(held ? 'build (locked)' : 'build');
      return map;
    },
  });
  const inner = f.deps.store.replaceCodeMap;
  f.deps.store.replaceCodeMap = async (k, w) => {
    events.push(held ? 'write (locked)' : 'write');
    return inner(k, w);
  };
  await new MapStage(f.deps).pass();
  expect(events).toEqual(['build', 'lock', 'write (locked)', 'unlock']);
});

test('a project unselected or deleted while its map was being built is not written back', async () => {
  let selected = true;
  const f = fakes({
    exclusive: async <T>(fn: () => Promise<T>) => fn(),
    inScope: async (key) => selected && key === 'demo',
    build: async () => {
      // Cleanup runs while the parse is part way.
      selected = false;
      return map;
    },
  });
  const r = await new MapStage(f.deps).mapProject({ key: 'demo', repoPath: '/vibe/demo' }, null);
  expect(r).toBeNull();
  expect(f.writes).toEqual([]);
  expect(f.activity).toEqual([]);
  expect(f.logs).toContain('code map skipped');
});

test('stop() during a parse abandons it: the build is told to stop, nothing is written, and nothing new starts', async () => {
  let seen: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  let builds = 0;
  const f = fakes({
    build: async (_repo, opts) => {
      builds++;
      seen = opts.signal;
      entered();
      // A parse that only ends when it is told to stop.
      await new Promise<void>((_, reject) => opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason)));
      return map;
    },
  });
  const stage = new MapStage(f.deps);
  stage.kick();
  await started;
  await stage.stop();
  expect(seen?.aborted).toBe(true);
  expect(f.writes).toEqual([]);
  expect(f.activity).toEqual([]);
  expect(f.logs).toContain('code map skipped');
  expect(f.logs).not.toContain('code map failed');
  stage.kick();
  expect(await stage.mapProject({ key: 'demo', repoPath: '/vibe/demo' }, 'a scan was requested')).toBeNull();
  await stage.idle();
  expect(builds).toBe(1);
});

test('stop() during the write waits for it to finish, so the store is never closed under a map write', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let writing!: () => void;
  const inWrite = new Promise<void>((r) => { writing = r; });
  const f = fakes();
  const inner = f.deps.store.replaceCodeMap;
  f.deps.store.replaceCodeMap = async (k, w) => {
    writing();
    await gate;
    return inner(k, w);
  };
  const stage = new MapStage(f.deps);
  stage.kick();
  await inWrite;
  let stopped = false;
  const stop = stage.stop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 10));
  expect(stopped).toBe(false);
  release();
  await stop;
  expect(f.writes).toHaveLength(1);
  expect(f.activity.map((a) => a.kind)).toEqual(['code_mapped']);
});
