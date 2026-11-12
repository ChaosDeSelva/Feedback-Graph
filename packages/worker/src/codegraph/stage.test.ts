import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_MAP_VERSION, type ActivityInput, type CodeMapMeta, type CodeMapWrite, type StoredCodeMap } from '@fb/core';
import { afterEach, expect, test } from 'vitest';
import { worktreeGitArgs } from '../ingest/git.ts';
import { fileFingerprint, gitStatusTimeoutMs, MAP_STALL_MS, MapStage, repoFingerprint, type MapStageDeps } from './stage.ts';
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
  const failures: { key: string; error: string }[] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  let fp: string | null = 'fp1';
  const checked: string[] = [];
  const deps: MapStageDeps = {
    store: {
      codeMapMeta: async (): Promise<CodeMapMeta | null> => stored && { fingerprint: stored.fingerprint, builtAt: stored.builtAt, checkedAt: stored.builtAt, stats: stored.stats, candidates: stored.write.candidates ?? null, unresolved: stored.write.unresolved ?? null, version: stored.write.version ?? null },
      codeMap: async () => stored,
      replaceCodeMap: async (_key, w) => {
        writes.push(w);
        const stats = { files: w.files.length, symbols: w.symbols.length, imports: w.imports.length, tests: w.tests.length };
        stored = { fingerprint: w.fingerprint, builtAt: 't', checkedAt: 't', stats, candidates: w.candidates ?? null, files: w.files, outside: w.outside ?? [], symbols: w.symbols, imports: w.imports, write: w };
        return stats;
      },
      recordCodeMapFailure: async (key, error) => { failures.push({ key, error }); },
      markCodeMapChecked: async (key) => { checked.push(key); },
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
    deps, writes, builds, activity, logs, failures, checked,
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

test('each build hands the map it replaced and the new one to what checks the approved lessons; a failure there is only logged', async () => {
  const seen: [string, number | null, number][] = [];
  const f = fakes({ onMapped: async (p, before, after) => { seen.push([p.key, before ? before.symbols.length : null, after.symbols.length]); throw new Error('boom'); } });
  const stage = new MapStage(f.deps);
  await stage.pass();
  // A rebuild from scratch (forced) still compares with the map it replaces.
  await stage.mapProject({ key: 'demo', repoPath: '/vibe/demo' }, 'you asked', { force: true });
  expect(seen).toEqual([['demo', null, 1], ['demo', 1, 1]]);
  expect(f.logs).toContain('lessons not checked against the new code map');
  expect(f.writes).toHaveLength(2);
});

test('a capped map says so: candidates are stored and logged, and files sessions edited are kept first', async () => {
  const opts: BuildOpts[] = [];
  const logged: [string, object | undefined][] = [];
  const f = fakes({
    build: async (_repo, o) => { opts.push(o); return { ...map, candidates: 10_290 }; },
    editedPaths: async (key) => (key === 'demo' ? ['src/portal/page.tsx'] : []),
    maxFiles: null,
    log: (m, e) => logged.push([m, e]),
  });
  await new MapStage(f.deps).pass();
  expect(opts[0]).toMatchObject({ maxFiles: null, priority: ['src/portal/page.tsx'] });
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
  expect(f.checked).toEqual(['demo']); // but checked: an unchanged map is current, not stale
  f.setFingerprint('fp2');
  await stage.pass();
  expect(f.builds).toHaveLength(1); // checked less than a minute ago
  f.tick(61_000);
  await stage.pass();
  expect(f.builds).toHaveLength(2);
  expect(f.builds[1].prev?.files.map((x) => x.path)).toEqual(['src/db.ts', 'test/db.test.ts']);
  expect(f.activity.at(-1)).toMatchObject({ why: 'the repo changed since the last map', details: expect.objectContaining({ incremental: true }) });
});

test('a map built by older map rules (or none) is rebuilt from scratch at start, logged, even when the repo is unchanged', async () => {
  const logged: [string, object | undefined][] = [];
  const f = fakes({ log: (m, e) => logged.push([m, e]) });
  const stage = new MapStage(f.deps);
  await stage.pass();
  expect(f.writes[0].version).toBe(CODE_MAP_VERSION);
  // What an older worker left: the same repo, but no version (or an older one) on the stored map.
  for (const old of [null, CODE_MAP_VERSION - 1]) {
    const meta = f.deps.store.codeMapMeta;
    f.deps.store.codeMapMeta = async (k) => ({ ...(await meta(k))!, version: old });
    const restarted = new MapStage(f.deps);
    await restarted.pass();
    f.deps.store.codeMapMeta = meta;
    expect(f.builds.at(-1)?.prev).toBeUndefined();
    expect(logged).toContainEqual(['code map outdated, rebuilding', { project: 'demo', version: old, current: CODE_MAP_VERSION }]);
    expect(f.activity.at(-1)).toMatchObject({ why: `the map was built by older map rules (${old === null ? 'unversioned' : `v${old}`}, now v${CODE_MAP_VERSION})` });
  }
  expect(f.builds).toHaveLength(3);
  // Rebuilt and current: an unchanged repo is left alone again.
  const again = new MapStage(f.deps);
  await again.pass();
  expect(f.builds).toHaveLength(3);
});

test('churn is read before the build, so a capped map can keep the busiest files', async () => {
  const opts: BuildOpts[] = [];
  const f = fakes({ build: async (_repo, o) => { opts.push(o); return map; } });
  await new MapStage(f.deps).pass();
  expect(opts[0].churn?.get('src/db.ts')).toEqual({ commits: 4, lastTs: '2026-10-20T00:00:00.000Z' });
});

test('a folder git cannot read falls back to a file fingerprint: unchanged, it is not rebuilt, and that is logged once', async () => {
  let files = 'fs:1';
  const f = fakes({ fsFingerprint: async () => files });
  f.setFingerprint(null);
  const stage = new MapStage(f.deps);
  await stage.pass();
  expect(f.writes[0].fingerprint).toBe('fs:1');
  f.tick(61_000);
  await stage.pass();
  expect(f.builds).toHaveLength(1);
  files = 'fs:2';
  f.tick(61_000);
  await stage.pass();
  expect(f.builds).toHaveLength(2);
  expect(f.logs.filter((m) => m === 'code map fingerprint unavailable')).toHaveLength(1);
});

test('a map whose write was cut short (its fingerprint cleared) is reparsed from scratch, not from what was half written', async () => {
  const f = fakes();
  const stage = new MapStage(f.deps);
  await stage.pass();
  // The store clears the fingerprint before writing and sets it last: a crash in between leaves it null.
  f.writes.length = 0;
  const meta = f.deps.store.codeMapMeta;
  f.deps.store.codeMapMeta = async (k) => ({ ...(await meta(k))!, fingerprint: null });
  f.tick(61_000);
  await stage.pass();
  expect(f.builds).toHaveLength(2);
  expect(f.builds[1].prev).toBeUndefined();
  expect(f.activity.at(-1)).toMatchObject({ details: expect.objectContaining({ incremental: false }) });
});

test('the map stage hands its git commands the worktree arguments for the folder', async () => {
  const seen: unknown[] = [];
  const args = ['--git-dir', '/vibe/main/.git/worktrees/demo', '--work-tree', '/vibe/demo'];
  const f = fakes({
    gitArgs: async (repo) => (repo === '/vibe/demo' ? args : []),
    fingerprint: async (_r, _m, o) => { seen.push(['fp', o?.gitArgs]); return 'fp1'; },
    churn: async (_r, _d, a) => { seen.push(['churn', a]); return new Map(); },
  });
  await new MapStage(f.deps).pass();
  expect(seen).toEqual([['fp', args], ['churn', args]]);
});

test('a git worktree whose .git names a host path is fingerprinted through the roots mapping', async () => {
  const base = tmp();
  const main = join(base, 'main');
  mkdirSync(main);
  git(main, 'init', '-q');
  writeFileSync(join(main, 'a.ts'), 'export const a = 1;\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'a');
  const wt = join(base, 'wt');
  git(main, 'worktree', 'add', '-q', wt);
  // What the container sees: the .git file names the host's folder, which is not mounted under that path.
  writeFileSync(join(wt, '.git'), 'gitdir: /Users/me/Code/main/.git/worktrees/wt\n');
  expect(await repoFingerprint(wt, 100)).toBeNull();
  const args = await worktreeGitArgs(wt, [{ host: '/Users/me/Code', container: base }]);
  expect(args).toEqual(['--git-dir', join(main, '.git/worktrees/wt'), '--work-tree', wt]);
  const fp = await repoFingerprint(wt, 100, { gitArgs: args });
  expect(fp).toMatch(/^[0-9a-f]{64}$/);
  writeFileSync(join(wt, 'a.ts'), 'export const a = 2;\n');
  expect(await repoFingerprint(wt, 100, { gitArgs: args })).not.toBe(fp);
  // A plain repo, and a gitdir under no root, need nothing.
  expect(await worktreeGitArgs(main, [{ host: '/Users/me/Code', container: base }])).toEqual([]);
  expect(await worktreeGitArgs(wt, [{ host: '/elsewhere', container: base }])).toEqual([]);
});

test('fileFingerprint changes when a candidate file is added or edited, and ignores skipped folders', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  const one = await fileFingerprint(dir);
  expect(one).toMatch(/^fs:[0-9a-f]{64}$/);
  expect(await fileFingerprint(dir)).toBe(one);
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'x.ts'), 'x');
  expect(await fileFingerprint(dir)).toBe(one);
  writeFileSync(join(dir, 'b.ts'), 'b');
  const two = await fileFingerprint(dir);
  expect(two).not.toBe(one);
  writeFileSync(join(dir, 'b.ts'), 'bb');
  expect(await fileFingerprint(dir)).not.toBe(two);
});

test('a pass stuck on one project past the stall limit is logged and abandoned, so the next kick starts a new pass', async () => {
  const logged: [string, object | undefined][] = [];
  let calls = 0;
  const f = fakes({
    // The first build never settles (a hung read over the mount); later ones do.
    build: async () => (++calls === 1 ? new Promise<CodeMap>(() => {}) : map),
    stallMs: 20 * 60_000,
    log: (m, e) => logged.push([m, e]),
  });
  const stage = new MapStage(f.deps);
  stage.kick();
  await new Promise((r) => setTimeout(r, 5));
  f.tick(10 * 60_000);
  stage.kick(); // still within the limit: nothing happens
  expect(logged.map(([m]) => m)).not.toContain('code map stage stalled');
  f.tick(11 * 60_000);
  stage.kick();
  expect(logged).toContainEqual(['code map stage stalled', expect.objectContaining({ project: 'demo', runningMs: 21 * 60_000 })]);
  await stage.idle();
  expect(calls).toBe(2);
  expect(f.writes).toHaveLength(1);
});

test('a rebuild you asked for remaps the project from scratch at the next kick, whatever the interval and the fingerprint', async () => {
  let requested: { projectKey: string; requestedAt: string }[] = [];
  const f = fakes();
  f.deps.store.codeMapRebuildsRequested = async () => requested;
  const stage = new MapStage(f.deps);
  await stage.pass();
  f.tick(1000);
  requested = [{ projectKey: 'demo', requestedAt: new Date(1_000_500).toISOString() }];
  await stage.pass();
  expect(f.builds).toHaveLength(2);
  expect(f.builds[1].prev).toBeUndefined();
  expect(f.activity.at(-1)).toMatchObject({ why: 'you asked for a rebuild of the map', details: expect.objectContaining({ incremental: false }) });
  // Still listed (the fake store does not clear it): not again until the interval, then once more.
  await stage.pass();
  expect(f.builds).toHaveLength(2);
  f.tick(61_000);
  await stage.pass();
  expect(f.builds).toHaveLength(3);
});

test('a pass purges orphan code files at most once per interval, and logs only when some went', async () => {
  const purged: number[] = [];
  let n = 3;
  const logged: [string, object | undefined][] = [];
  const f = fakes({ log: (m, e) => logged.push([m, e]) });
  f.deps.store.purgeOrphanCodeFiles = async (limit) => { purged.push(limit); const r = n; n = 0; return r; };
  const stage = new MapStage(f.deps);
  await stage.pass();
  await stage.pass();
  expect(purged).toHaveLength(1);
  expect(logged).toContainEqual(['orphan code files purged', { files: 3 }]);
  f.tick(61_000);
  await stage.pass();
  expect(purged).toHaveLength(2);
  expect(logged.filter(([m]) => m === 'orphan code files purged')).toHaveLength(1);
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
  expect(f.failures).toEqual([{ key: 'bad', error: 'Error: boom' }]);
  expect(f.activity).toContainEqual(expect.objectContaining({ projectKey: 'bad', subject: expect.stringContaining('failed') }));
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

test('test links cover files past the cap too, and the build is given the source files\' own size limit', async () => {
  const opts: BuildOpts[] = [];
  const capped: CodeMap = {
    ...map,
    outside: [{ path: 'src/jobs/sync.go', lang: 'go', hash: 'h3', loc: 3, isTest: false }, { path: 'src/jobs/sync_test.go', lang: 'go', hash: 'h4', loc: 3, isTest: true }],
  };
  const f = fakes({ build: async (_repo, o) => { opts.push(o); return capped; }, sourceMaxBytes: 1_000_000 });
  await new MapStage(f.deps).pass();
  // A file an agent names may be past the cap: its own tests are linked as a mapped file's are.
  expect(f.writes[0].tests).toEqual([{ test: 'test/db.test.ts', target: 'src/db.ts' }, { test: 'src/jobs/sync_test.go', target: 'src/jobs/sync.go' }]);
  expect(opts[0]).toMatchObject({ maxBytes: 1000, sourceMaxBytes: 1_000_000 });
});

test('repoFingerprint: a git status that fails without timing out gives no fingerprint, and says why', async () => {
  const logged: [string, object | undefined][] = [];
  const exec = async (args: string[]) => {
    if (args.includes('--show-toplevel')) return '/repo\n';
    // execFile rejects with an Error; anything else is logged as itself
    if (args.includes('status')) throw 'fatal: not a git repository';
    return 'abc\n';
  };
  expect(await repoFingerprint('/repo', 100, { exec, log: (m, e) => logged.push([m, e]) })).toBeNull();
  expect(logged).toEqual([['git status failed', { repoPath: '/repo', error: 'fatal: not a git repository' }]]);
});

test('repoFingerprint: a rename is one dirty file, so the file after it is still within maxFiles', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'new.ts'), 'x');
  writeFileSync(join(dir, 'a.ts'), 'a');
  const exec = async (args: string[]) => {
    if (args.includes('--show-toplevel')) return `${dir}\n`;
    if (args.includes('status')) return 'R  new.ts\0old.ts\0 M a.ts\0';
    return 'abc\n';
  };
  const before = await repoFingerprint(dir, 2, { exec });
  writeFileSync(join(dir, 'a.ts'), 'a longer edit');
  expect(await repoFingerprint(dir, 2, { exec })).not.toBe(before);
});

test('fileFingerprint counts a tracked file deleted from the folder as gone', async () => {
  const dir = tmp();
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'a');
  const before = await fileFingerprint(dir);
  rmSync(join(dir, 'b.ts'));
  const gone = await fileFingerprint(dir);
  expect(gone).not.toBe(before);
  expect(await fileFingerprint(dir)).toBe(gone);
});

test('with only its store and projects, the stage fingerprints, reads churn and builds for real, on the default interval', async () => {
  const dir = tmp(); // not a git repo: the file fingerprint stands in
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  const f = fakes();
  const purged: number[] = [];
  const { build: _b, churn: _c, fingerprint: _f, now: _n, minIntervalMs: _m, ...rest } = f.deps;
  const stage = new MapStage({
    ...rest,
    store: { ...f.deps.store, purgeOrphanCodeFiles: async (limit) => { purged.push(limit); return 0; } },
    projects: async () => [{ key: 'demo', repoPath: dir }],
  });
  stage.kick();
  stage.kick(); // one pass at a time
  await stage.idle();
  expect(f.writes.map((w) => [w.files.map((x) => x.path), w.fingerprint?.startsWith('fs:'), w.churn])).toEqual([[['a.ts'], true, {}]]);
  // Within the default interval: neither looked at again nor purged again.
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  await stage.pass();
  expect(f.writes).toHaveLength(1);
  expect(purged).toHaveLength(1);
});

test('without a stall limit set, a busy pass is left alone for MAP_STALL_MS', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = fakes({ build: async () => { await gate; return map; } });
  const stage = new MapStage(f.deps);
  stage.kick();
  await new Promise((r) => setTimeout(r, 5));
  f.tick(MAP_STALL_MS - 1);
  stage.kick();
  expect(f.logs).not.toContain('code map stage stalled');
  release();
  await stage.idle();
  expect(f.writes).toHaveLength(1);
});

test('a scan that asks for a map while one is being built for the same project waits for it, then finds nothing changed', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = fakes({ build: async () => { await gate; return map; } });
  const stage = new MapStage(f.deps);
  const p = { key: 'demo', repoPath: '/vibe/demo' };
  const first = stage.mapProject(p, 'a scan was requested');
  const second = stage.mapProject(p, 'a scan was requested');
  release();
  expect((await first)?.files).toBe(2);
  expect(await second).toBeNull();
  expect(f.writes).toHaveLength(1);
  expect(f.checked).toEqual(['demo']);
});

test('stop() waits for a scan\'s map in flight; a map parsed by then is not written, and the pass stops before the next project', async () => {
  const gates: (() => void)[] = [];
  const entered: string[] = [];
  const f = fakes({
    projects: async () => [{ key: 'one', repoPath: '/vibe/one' }, { key: 'two', repoPath: '/vibe/two' }],
    // A parse that does not watch the signal: it finishes after stop() was called.
    build: async (repo) => { entered.push(repo); await new Promise<void>((r) => gates.push(r)); return map; },
  });
  const stage = new MapStage(f.deps);
  const scan = stage.mapProject({ key: 'scanned', repoPath: '/vibe/scanned' }, 'a scan was requested');
  stage.kick();
  while (gates.length < 2) await new Promise((r) => setTimeout(r, 1));
  let stopped = false;
  const stop = stage.stop().then(() => { stopped = true; });
  gates[1](); // the pass's first project
  await new Promise((r) => setTimeout(r, 10));
  expect(stopped).toBe(false); // the scan's build is still running
  gates[0]();
  await stop;
  expect(await scan).toBeNull();
  expect(entered.sort()).toEqual(['/vibe/one', '/vibe/scanned']);
  expect(f.writes).toEqual([]);
  expect(f.logs.filter((m) => m === 'code map skipped')).toHaveLength(2);
});

test('an orphan purge that fails is logged and the pass still ends', async () => {
  const logged: [string, object | undefined][] = [];
  const f = fakes({ log: (m, e) => logged.push([m, e]) });
  f.deps.store.purgeOrphanCodeFiles = async () => { throw new Error('deadlock detected'); };
  await new MapStage(f.deps).pass();
  expect(logged).toContainEqual(['orphan code file purge failed', { error: 'Error: deadlock detected' }]);
  expect(f.writes).toHaveLength(1);
});
