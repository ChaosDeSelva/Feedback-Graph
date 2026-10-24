import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderUnavailableError, type ActivityInput, type LlmProvider, type ScanJob } from '@fb/core';
import { expect, test } from 'vitest';
import { deterministicFacts, extractFileFacts, listCodeFiles, runScan, SCAN_PROMPT_VERSION, type ScanDeps } from './scan.ts';

function repo(git = false) {
  const dir = mkdtempSync(join(tmpdir(), 'fbscan-'));
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('src/a.ts', 'export const a = 1;\n');
  w('src/b.py', 'def b(): pass\n');
  w('README.md', '# demo\n');
  w('package.json', JSON.stringify({ scripts: { dev: 'vite', test: 'vitest run' }, dependencies: { react: '^18', hono: '^4' } }));
  w('node_modules/x/index.js', 'x');
  w('dist/out.js', 'x');
  w('logo.png', 'x');
  w('pnpm-lock.yaml', 'x');
  w('src/huge.ts', 'x'.repeat(200_000));
  w('ignored/private.ts', 'x');
  w('.gitignore', 'ignored/\n');
  w('.env', 'TOKEN=x');
  w('.env.local', 'TOKEN=x');
  w('.mcp.json', '{}');
  w('certs/server.pem', 'x');
  w('infra/prod.tfvars', 'x');
  w('config/secrets.yaml', 'x');
  if (git) {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'add', '-A']);
  }
  return dir;
}

test('listCodeFiles keeps source/docs/config and skips deps, builds, binaries, lockfiles and huge files', async () => {
  const files = await listCodeFiles(repo(), { maxBytes: 80_000, maxFiles: 100 });
  expect(files.map((f) => f.path).sort()).toEqual(['.gitignore', 'README.md', 'ignored/private.ts', 'package.json', 'src/a.ts', 'src/b.py']);
  expect(files.find((f) => f.path === 'src/a.ts')?.hash).toMatch(/^[0-9a-f]{40}$/);
});

test('listCodeFiles respects .gitignore in a git repo', async () => {
  const files = await listCodeFiles(repo(true), { maxBytes: 80_000, maxFiles: 100 });
  expect(files.map((f) => f.path)).not.toContain('ignored/private.ts');
  expect(files.map((f) => f.path)).toContain('src/a.ts');
});

test('deterministicFacts reads package.json scripts and dependencies', () => {
  const facts = deterministicFacts([{ path: 'package.json', content: JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '^18' }, devDependencies: { vitest: '^3' } }) }]);
  expect(facts).toEqual([
    { kind: 'command', statement: '`dev` script runs: vite', path: 'package.json', lines: null, confidence: 1, why: 'Read directly from package.json; no model involved.' },
    { kind: 'dependency', statement: 'Dependencies: react ^18. Dev dependencies: vitest ^3.', path: 'package.json', lines: null, confidence: 1, why: 'Read directly from package.json; no model involved.' },
  ]);
});

const llm = (out: unknown, agentic = false): LlmProvider & { seen: { user: string; cwd?: string }[] } => {
  const seen: { user: string; cwd?: string }[] = [];
  return { id: agentic ? 'claude-cli' : 'ollama:gemma4', agentic, seen, json: async (t) => { seen.push({ user: t.user, cwd: t.cwd }); return typeof out === 'function' ? (out as (u: string) => unknown)(t.user) : out; } };
};

test('extractFileFacts pins facts to the file and drops low-confidence ones', async () => {
  const r = await extractFileFacts(llm({ summary: 'S', facts: [
    { kind: 'convention', statement: 'keep', path: 'elsewhere.ts', lines: '1-2', confidence: 0.9, why: 'every route depends on it' },
    { kind: 'gotcha', statement: 'drop', path: 'src/a.ts', lines: null, confidence: 0.2, why: 'w' },
  ] }), 'src/a.ts', 'code');
  expect(r.summary).toBe('S');
  expect(r.facts).toEqual([{ kind: 'convention', statement: 'keep', path: 'src/a.ts', lines: '1-2', confidence: 0.9, why: 'every route depends on it' }]);
});

test('extractFileFacts keeps a fact whose model left out the why', async () => {
  const r = await extractFileFacts(llm({ summary: 'S', facts: [{ kind: 'api', statement: 'x', path: 'a', lines: null, confidence: 0.9 }] }), 'a', 'code');
  expect(r.facts[0].why).toBe('');
});

function fakeDeps(over: Partial<ScanDeps> = {}) {
  const saved: { path: string; facts: number }[] = [];
  const removed: string[][] = [];
  const replaced: { facts: number; files: number }[] = [];
  const updates: object[] = [];
  const activity: ActivityInput[] = [];
  const jobIds: (string | null | undefined)[] = [];
  let attempts = 0;
  const deps: ScanDeps = {
    facts: {
      fileHashes: async () => new Map([['src/a.ts', 'stale'], ['src/deleted.ts', 'x']]),
      saveFileFacts: async (_k, f, facts, _s, jobId) => { saved.push({ path: f.path, facts: facts.length }); jobIds.push(jobId); },
      markFilesRemoved: async (_k, p) => { removed.push(p); },
      replaceProjectFacts: async (_k, facts, _s, files, jobId) => { replaced.push({ facts: facts.length, files: files.length }); jobIds.push(jobId); },
      updateScanJob: async (_id, p) => { updates.push(p); },
      currentSources: async () => [],
      // The stores' rule (contract-tested in facts.int.test.ts): a counted failure backs off, then fails for good.
      recordScanFailure: async (_id, error, o) => {
        attempts += o.counted ? 1 : 0;
        const retryAt = o.counted && attempts >= 3 ? null : 'later';
        updates.push({ status: retryAt ? 'queued' : 'failed', error, counted: o.counted, attempts });
        return { attempts, retryAt };
      },
    },
    llm: llm({ summary: 'S', facts: [{ kind: 'api', statement: 'f', path: '', lines: null, confidence: 0.8, why: 'callers rely on it' }] }),
    activity: { record: async (a) => { activity.push(a); } },
    embed: async (t) => t.map(() => [0.1]),
    maxBytes: 80_000,
    maxFiles: 100,
    ...over,
  };
  return { deps, saved, removed, replaced, updates, activity, jobIds };
}

const job = (dir: string): ScanJob => ({ id: 'j', projectKey: 'demo', repoPath: dir, provider: null, status: 'queued', requestedAt: 't', startedAt: null, finishedAt: null, filesScanned: 0, factsAdded: 0, error: null, attempts: 0, retryAt: null });

test('runScan (per-file) skips unchanged files, scans changed ones, and closes removed files', async () => {
  const dir = repo(true);
  const { deps, saved, removed, updates } = fakeDeps();
  const r = await runScan(job(dir), deps);
  expect(saved.map((s) => s.path).sort()).toEqual(['.gitignore', 'README.md', 'package.json', 'src/a.ts', 'src/b.py']);
  expect(saved.find((s) => s.path === 'package.json')?.facts).toBe(4); // 1 llm + 2 scripts + 1 deps
  expect(removed).toEqual([['src/deleted.ts']]);
  expect(r).toEqual({ filesScanned: 5, factsAdded: 8, failed: 0, remaining: 0 });
  expect(updates.at(0)).toEqual({ status: 'running' });
  expect(updates.at(-1)).toEqual({ status: 'done', filesScanned: 5, factsAdded: 8 });

  const again = fakeDeps({ facts: { ...deps.facts, fileHashes: async () => new Map(saved.map((s) => [s.path, 'x'])) } });
  // simulate stored hashes equal to the real ones by re-reading
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  again.deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  expect(await runScan(job(dir), again.deps)).toEqual({ filesScanned: 0, factsAdded: 0, failed: 0, remaining: 0 });
});

test('runScan logs what it extracted from each file, with which model and why the file was scanned', async () => {
  const dir = repo(true);
  const { deps, activity, jobIds } = fakeDeps();
  await runScan(job(dir), deps);
  expect(jobIds.every((j) => j === 'j')).toBe(true);
  expect(activity[0]).toMatchObject({ kind: 'scan_started', actor: 'ollama:gemma4', projectKey: 'demo' });
  const a = activity.find((x) => x.kind === 'facts_extracted' && x.targets?.includes('demo:src/a.ts'))!;
  expect(a).toMatchObject({ actor: 'ollama:gemma4', projectKey: 'demo', subject: '1 fact from src/a.ts' });
  expect(a.why).toMatch(/changed since the last scan/);
  expect(a.details).toMatchObject({ scanJobId: 'j', previousHash: 'stale', summary: 'S', promptVersion: SCAN_PROMPT_VERSION });
  expect(a.details!.facts).toEqual([{ kind: 'api', statement: 'f', why: 'callers rely on it', confidence: 0.8 }]);
  expect(activity.find((x) => x.targets?.includes('demo:README.md'))!.why).toMatch(/new file/);
  expect(activity.find((x) => x.subject.includes('removed'))).toMatchObject({ targets: ['demo:src/deleted.ts'] });
  expect(activity.at(-1)).toMatchObject({ kind: 'scan_finished', subject: 'scanned 5 files, 8 facts' });
});

test('runScan (agentic) asks once for the whole repo and replaces project facts', async () => {
  const dir = repo(true);
  const agent = llm({ facts: [
    { kind: 'architecture', statement: 'Hono API + React UI', path: '.', lines: null, confidence: 0.9 },
    { kind: 'convention', statement: 'bad path', path: 'nope/missing.ts', lines: null, confidence: 0.9 },
  ] }, true);
  const { deps, replaced, saved } = fakeDeps({ llm: agent });
  const r = await runScan(job(dir), deps);
  expect(agent.seen).toHaveLength(1);
  expect(agent.seen[0].cwd).toBe(dir);
  expect(saved).toEqual([]);
  expect(replaced).toEqual([{ facts: 5, files: 5 }]); // 2 agentic (bad path re-homed to '.') + 3 package.json facts
  expect(r.filesScanned).toBe(5);
});

test('a provider that throws counts an attempt: the job is queued again with a backoff, and failed after the last one', async () => {
  const { deps, updates, activity } = fakeDeps({ llm: { id: 'x', agentic: true, json: async () => { throw new Error('quota'); } } });
  await expect(runScan(job(repo(true)), deps)).rejects.toThrow('quota');
  expect(updates.at(-1)).toMatchObject({ status: 'queued', error: 'Error: quota', counted: true, attempts: 1 });
  expect(activity.at(-1)).toMatchObject({ kind: 'scan_finished', subject: 'scan failed (attempt 1); retrying at later', why: 'Error: quota' });
  await expect(runScan(job(repo(true)), deps)).rejects.toThrow('quota');
  await expect(runScan(job(repo(true)), deps)).rejects.toThrow('quota');
  expect(updates.at(-1)).toMatchObject({ status: 'failed', attempts: 3 });
  expect(activity.at(-1)?.subject).toContain('gave up');
});

test('an unavailable model leaves the job queued, never failed, and stops asking it (per-file)', async () => {
  const dir = repo(true);
  let calls = 0;
  const down = llm(() => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  const { deps, updates, activity } = fakeDeps({ llm: down });
  await expect(runScan(job(dir), deps)).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(calls).toBe(1);
  expect(updates.at(-1)).toMatchObject({ status: 'queued', counted: false, error: expect.stringMatching(/model unavailable.*ECONNREFUSED/) });
  expect(updates.some((u) => (u as { status?: string }).status === 'failed' || (u as { status?: string }).status === 'done')).toBe(false);
  // However long the outage, it never uses up an attempt.
  for (let i = 0; i < 5; i++) await expect(runScan(job(dir), deps)).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(updates.at(-1)).toMatchObject({ status: 'queued', attempts: 0 });
  expect(activity.some((a) => a.subject.startsWith('could not extract facts'))).toBe(false);
});

test('an unavailable model leaves an agentic scan queued too', async () => {
  const { deps, updates } = fakeDeps({ llm: { id: 'claude-cli', agentic: true, json: async () => { throw new Error('claude exit 1: Invalid API key · Please run /login'); } } });
  await expect(runScan(job(repo(true)), deps)).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(updates.at(-1)).toMatchObject({ status: 'queued', counted: false, error: expect.stringMatching(/not signed in/) });
});

test('listCodeFiles never includes secret files, with or without git', async () => {
  for (const git of [false, true]) {
    const paths = (await listCodeFiles(repo(git), { maxBytes: 80_000, maxFiles: 100 })).map((f) => f.path);
    for (const p of ['.env', '.env.local', '.mcp.json', 'certs/server.pem', 'infra/prod.tfvars', 'config/secrets.yaml']) expect(paths).not.toContain(p);
  }
});

test('extractFileFacts redacts the file before the model sees it, and redacts what it says back', async () => {
  const key = `sk-ant-api03-${'b'.repeat(40)}`;
  const m = llm({ summary: `uses ${key}`, facts: [{ kind: 'config', statement: `API key is ${key}`, path: 'a', lines: null, confidence: 0.9, why: `see ${key}` }] });
  const r = await extractFileFacts(m, 'src/config.ts', `export const KEY = "${key}";`);
  expect(m.seen[0].user).not.toContain('sk-ant-api03');
  expect(JSON.stringify(r)).not.toContain('sk-ant-api03');
});

test('a file the model chokes on is logged and skipped; the rest of the scan still lands', async () => {
  const dir = repo(true);
  const flaky = llm((user: string) => { if (user.includes('FILE: src/a.ts')) throw new Error('bad json'); return { summary: 'S', facts: [] }; });
  const { deps, saved, activity, updates } = fakeDeps({ llm: flaky });
  const r = await runScan(job(dir), deps);
  expect(saved.map((x) => x.path)).not.toContain('src/a.ts');
  expect(saved.map((x) => x.path)).toContain('README.md');
  expect(r).toMatchObject({ failed: 1 });
  expect(activity.find((a) => a.subject === 'could not extract facts from src/a.ts')).toMatchObject({ why: 'Error: bad json' });
  expect(updates.at(-1)).toMatchObject({ status: 'done', error: '1 file failed: src/a.ts' });
});

test('the file cap limits how many changed files are scanned per run, and never closes facts of files beyond it', async () => {
  const dir = repo(true);
  const { deps, saved, removed, activity } = fakeDeps({ maxFiles: 2 });
  const r = await runScan(job(dir), deps);
  expect(saved).toHaveLength(2);
  expect(removed).toEqual([['src/deleted.ts']]);
  expect(r).toMatchObject({ filesScanned: 2, remaining: 3 });
  expect(activity.at(-1)!.subject).toMatch(/3 changed files left for the next scan/);
});

test('scanning with a different model than last time rescans every file, even unchanged ones', async () => {
  const dir = repo(true);
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  const agent = llm({ facts: [{ kind: 'architecture', statement: 'x', path: '.', lines: null, confidence: 0.9 }] }, true);
  const { deps, replaced, activity } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  deps.facts.currentSources = async () => ['ollama:gemma4'];
  const r = await runScan(job(dir), deps);
  expect(replaced).toHaveLength(1);
  expect(r.filesScanned).toBe(files.length);
  expect(activity[0].why).toMatch(/different model/);
});

test('an agentic scan survives a file deleted between listing and reading', async () => {
  const dir = repo(true);
  const agent = llm({ facts: [] }, true);
  const { deps } = fakeDeps({ llm: agent });
  const { rmSync } = await import('node:fs');
  const real = deps.facts.fileHashes;
  deps.facts.fileHashes = async (k) => { rmSync(join(dir, 'package.json')); return real(k); };
  await expect(runScan(job(dir), deps)).resolves.toMatchObject({ failed: 0 });
});

test('listCodeFiles never follows a symlink, even one git tracks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbscan-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.env'), 'TOKEN=x');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(dir, '.env'), join(dir, 'src/config.ts'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'add', '-A', '-f']);
  expect((await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 })).map((f) => f.path)).toEqual(['src/a.ts']);
});

test('one-file extraction sends only the file text: an agentic model gets a fresh empty folder, never the worker folder, removed afterwards', async () => {
  const { readdir, stat } = await import('node:fs/promises');
  const seen: { cwd?: string; files: string[] }[] = [];
  const llm: LlmProvider = { id: 'claude-cli', agentic: true, json: async (t) => {
    seen.push({ cwd: t.cwd, files: t.cwd ? await readdir(t.cwd) : [] });
    return { summary: 's', facts: [] };
  } };
  await extractFileFacts(llm, 'src/a.ts', 'export const a = 1;');
  expect(seen).toHaveLength(1);
  expect(seen[0].cwd).toBeTruthy();
  expect(seen[0].cwd).not.toBe(process.cwd());
  expect(seen[0].files).toEqual([]);
  await expect(stat(seen[0].cwd!)).rejects.toThrow();
});
