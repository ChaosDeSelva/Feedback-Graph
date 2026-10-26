import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelTimeoutError, ProviderUnavailableError, STRICT_JSON, type ActivityInput, type CodeFact, type FactScope, type LlmProvider, type ScanJob } from '@fb/core';
import { expect, test } from 'vitest';
import { checkCitations, deterministicFacts, extractFileFacts, hasCodeFiles, listCodeFiles, listCodeFilesWithTotal, runScan, ScanPlans, FACT_CHECK_VERSION, SCAN_PROMPT_VERSION, SCANNER_VERSION, type ScanDeps } from './scan.ts';

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
    { kind: 'command', statement: '`dev` script runs: vite', path: 'package.json', lines: null, confidence: 1, why: 'Read directly from package.json; no model involved.', relevance: 0.7, origin: 'manifest', evidence: 'file' },
    { kind: 'dependency', statement: 'Dependencies: react ^18. Dev dependencies: vitest ^3.', path: 'package.json', lines: null, confidence: 1, why: 'Read directly from package.json; no model involved.', relevance: 0.5, origin: 'manifest', evidence: 'file' },
  ]);
});

test('deterministicFacts also reads pyproject, go.mod, Cargo.toml, Makefile targets, compose services and .env.example keys', () => {
  const at = (path: string, content: string) => deterministicFacts([{ path, content }]).map((f) => `${f.kind}: ${f.statement}`);
  expect(at('svc/pyproject.toml', [
    '[project]', 'name = "shop"', 'requires-python = ">=3.11"', 'dependencies = [', '  "fastapi>=0.110",', '  "sqlalchemy",', ']',
    '[project.scripts]', 'shop = "shop.cli:main"', '[tool.poetry.dependencies]', 'pydantic = "^2"',
  ].join('\n'))).toEqual([
    'command: `shop` script runs: shop.cli:main',
    'dependency: Python >=3.11. Dependencies: fastapi>=0.110, sqlalchemy, pydantic ^2.',
  ]);
  expect(at('go.mod', 'module example.com/shop\n\ngo 1.22\n\nrequire (\n\tgithub.com/acme/kit v1.2.0\n\tgolang.org/x/sync v0.7.0 // indirect\n)\nrequire github.com/acme/one v0.1.0\n')).toEqual([
    'dependency: Go module example.com/shop (go 1.22). Requires: github.com/acme/kit v1.2.0, golang.org/x/sync v0.7.0, github.com/acme/one v0.1.0.',
  ]);
  expect(at('crates/core/Cargo.toml', '[package]\nname = "core"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\ntokio = "1.37"\n\n[dev-dependencies]\ninsta = "1"\n')).toEqual([
    'dependency: Crate core (edition 2021). Dependencies: serde 1, tokio 1.37. Dev dependencies: insta 1.',
  ]);
  expect(at('Makefile', '.PHONY: test build\nVERSION := 1\ntest: build\n\tgo test ./...\nbuild:\n\tgo build\n%.o: %.c\n\tcc\n')).toEqual(['command: Make targets: test, build.']);
  expect(at('deploy/docker-compose.yml', 'version: "3"\nservices:\n  db:\n    image: postgres:16\n  api:\n    build: .\n    ports:\n      - "8080:8080"\nvolumes:\n  data: {}\n')).toEqual(['config: Compose services: db, api.']);
  expect(at('.env.example', `# settings\nDATABASE_URL=postgres://user@db/app\nexport API_TOKEN=${'x'.repeat(30)}\nlower=1\n`)).toEqual(['config: Environment keys (from .env.example): DATABASE_URL, API_TOKEN.']);
  // never a value from .env.example
  expect(at('.env.example', `API_TOKEN=${'x'.repeat(30)}`).join()).not.toContain('xxxx');
  expect(at('src/main.ts', 'export const a = 1;')).toEqual([]);
});

test('checkCitations drops facts citing a file that does not exist, fixes lines beyond the file, and grades the evidence', async () => {
  const files: Record<string, string> = {
    'src/pool.ts': ['import pg from "pg";', 'export function createPool() {', '  const pool = new pg.Pool();', '  return pool;', '}', 'export const MAX_CLIENTS = 10;'].join('\n'),
    'big.bin': '',
  };
  const read = async (p: string) => (p === 'big.bin' ? null : files[p]);
  const fact = (path: string, lines: string | null, statement: string): CodeFact => ({ kind: 'api', statement, path, lines, confidence: 1, why: 'w' });
  const r = await checkCitations([
    fact('src/pool.ts', '2-4', '`createPool` returns a new pg Pool'),
    fact('src/pool.ts', '1-2', 'MAX_CLIENTS caps the pool at ten clients'),
    fact('src/pool.ts', '40-60', 'the pool is created lazily'),
    fact('src/pool.ts', '5-90', 'nothing named here'),
    fact('src/pool.ts', null, 'pools are per process'),
    fact('fg-verifier-notes.txt', null, 'run tests with bun test'),
    fact('.', null, 'the API is a Hono app'),
    fact('./src/pool.ts', '6', 'MAX_CLIENTS is 10'),
    fact('big.bin', '1-3', 'a binary blob'),
    fact('src/AGENTS.md', null, 'Webapp code lives under core'),
    fact('CLAUDE.md', null, 'always run the linter'),
  ], read);
  expect(r.dropped.map((f) => f.statement)).toEqual(['run tests with bun test', 'Webapp code lives under core', 'always run the linter']);
  expect(r.kept.map((f) => [f.path, f.lines, f.evidence])).toEqual([
    ['src/pool.ts', '2-4', 'line'],
    ['src/pool.ts', null, 'file'], // MAX_CLIENTS is on line 6, not 1-2
    ['src/pool.ts', null, 'file'], // past the end of a 6-line file
    ['src/pool.ts', '5-6', 'line'], // clamped to the file
    ['src/pool.ts', null, 'file'],
    ['.', null, 'none'],
    ['src/pool.ts', '6', 'line'],
    ['big.bin', '1-3', 'file'],
  ]);
});

test('checkCitations keeps a correct range whose identifier is the enclosing declaration above it, or the one a doc comment documents', async () => {
  const body = Array.from({ length: 30 }, (_, i) => `  step${i}();`);
  const content = [
    '/**', ' * Pools are created lazily: the first query opens the pool.', ' */', '// eslint-disable-next-line max-params', '@traced()',
    'export function createPool(retries = 3) {', ...body, '}', '', ...Array.from({ length: 60 }, () => '// filler'), 'export const UNRELATED = 1;',
  ].join('\n');
  const read = async () => content;
  const fact = (lines: string, statement: string): CodeFact => ({ kind: 'gotcha', statement, path: 'src/pool.ts', lines, confidence: 1, why: 'w' });
  const r = await checkCitations([
    // The body of createPool, which is declared on line 6 (far more than LINE_SLACK above line 25).
    fact('25-30', '`createPool` retries each step before giving up'),
    // The doc comment, three lines above the declaration it documents (past LINE_SLACK).
    fact('1-3', '`createPool` opens the pool on the first query'),
    // Far from anything it names: still dropped.
    fact('90-95', '`createPool` takes a retry count'),
  ], read);
  expect(r.kept.map((f) => [f.lines, f.evidence])).toEqual([['25-30', 'line'], ['1-3', 'line'], [null, 'file']]);
});

test('an agentic scan saves facts with their evidence level, never one citing an instruction file or a missing file', async () => {
  const dir = repo(true);
  const agent = llm({ facts: [
    { kind: 'api', statement: '`a` is exported', path: 'src/a.ts', lines: '1', confidence: 1 },
    { kind: 'convention', statement: 'restated from the docs', path: 'README.md', lines: null, confidence: 1 },
    { kind: 'convention', statement: 'ghost', path: 'notes.txt', lines: null, confidence: 1 },
  ] }, true);
  const { deps, written } = fakeDeps({ llm: agent });
  await runScan(job(dir), deps);
  expect(written.filter((f) => f.origin === 'model').map((f) => [f.statement, f.evidence])).toEqual([['`a` is exported', 'line'], ['restated from the docs', 'file']]);
  expect(written.filter((f) => f.origin === 'manifest')).toHaveLength(3);
  // Stamped with the rule that checked them, so a later rule change rechecks them (recheck.ts).
  expect(written.every((f) => f.checkVersion === FACT_CHECK_VERSION)).toBe(true);
});

test('a per-file scan stamps its facts with the citation rule that checked them', async () => {
  const { deps, written } = fakeDeps();
  await runScan(job(repo(true)), deps);
  expect(written.length).toBeGreaterThan(0);
  expect(written.every((f) => f.checkVersion === FACT_CHECK_VERSION)).toBe(true);
});

test('the extraction prompts say not to restate instruction files and not to infer absence from the file list', async () => {
  const seen: string[] = [];
  const m: LlmProvider = { id: 'claude-cli', agentic: true, json: async (t) => { seen.push(t.system); return { facts: [] }; } };
  await runScan(job(repo(true)), fakeDeps({ llm: m }).deps);
  expect(seen[0]).toMatch(/AGENTS\.md/);
  expect(seen[0]).toMatch(/CLAUDE\.md/);
  expect(seen[0]).toMatch(/absent|missing/i);
});

test('a per-file scan does not ask the model about AGENTS.md or CLAUDE.md, but still records them as scanned', async () => {
  const dir = repo(true);
  writeFileSync(join(dir, 'AGENTS.md'), '# rules\nAlways run the linter.\n');
  const asked: string[] = [];
  const m: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async (t) => { asked.push(t.user.split('\n')[0]); return { summary: 'S', facts: [] }; } };
  const { deps, saved } = fakeDeps({ llm: m });
  await runScan(job(dir), deps);
  expect(asked.some((u) => u.includes('AGENTS.md'))).toBe(false);
  expect(saved.find((s) => s.path === 'AGENTS.md')).toEqual({ path: 'AGENTS.md', facts: 0, version: SCANNER_VERSION });
});

const llm = (out: unknown, agentic = false): LlmProvider & { seen: { user: string; cwd?: string }[] } => {
  const seen: { user: string; cwd?: string }[] = [];
  return { id: agentic ? 'claude-cli' : 'ollama:gemma4', agentic, seen, json: async (t) => { seen.push({ user: t.user, cwd: t.cwd }); return typeof out === 'function' ? (out as (u: string) => unknown)(t.user) : out; } };
};

test('extractFileFacts pins facts to the file and drops low-confidence ones', async () => {
  const r = await extractFileFacts(llm({ summary: 'S', facts: [
    { kind: 'convention', statement: 'keep', path: 'elsewhere.ts', lines: '1-2', confidence: 0.9, why: 'every route depends on it', relevance: 0.9 },
    { kind: 'gotcha', statement: 'drop', path: 'src/a.ts', lines: null, confidence: 0.2, why: 'w', relevance: 0.5 },
  ] }), 'src/a.ts', 'code');
  expect(r.summary).toBe('S');
  expect(r.facts).toEqual([{ kind: 'convention', statement: 'keep', path: 'src/a.ts', lines: '1-2', confidence: 0.9, why: 'every route depends on it', relevance: 0.9 }]);
});

test('extractFileFacts keeps a fact whose model left out the why or the relevance (unscored), and clamps a stray relevance', async () => {
  const r = await extractFileFacts(llm({ summary: 'S', facts: [{ kind: 'api', statement: 'x', path: 'a', lines: null, confidence: 0.9 }, { kind: 'api', statement: 'y', path: 'a', lines: null, confidence: 0.9, why: '', relevance: 3 }] }), 'a', 'code');
  expect(r.facts[0].why).toBe('');
  expect(r.facts[0].relevance).toBeNull();
  expect(r.facts[1].relevance).toBe(1);
});

test('the extraction prompt asks for relevance to everyday coding, with setup of external tools ranked low', async () => {
  const seen: { system: string; schema: object }[] = [];
  const m: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async (t) => { seen.push({ system: t.system, schema: t.schema }); return { summary: 'S', facts: [] }; } };
  await extractFileFacts(m, 'a', 'code');
  expect(seen[0].system).toMatch(/relevance/i);
  expect(seen[0].system).toMatch(/external tool/i);
  expect(JSON.stringify(seen[0].schema)).toContain('"relevance"');
  // Every model answered 1.0: it is no longer asked for (a fact without one is kept).
  expect(JSON.stringify(seen[0].schema)).not.toContain('confidence');
});

test('a fact the model gave no confidence is kept', async () => {
  const r = await extractFileFacts(llm({ summary: 'S', facts: [{ kind: 'api', statement: 'x', path: 'a', lines: null, why: 'w', relevance: 0.5 }] }), 'a', 'code');
  expect(r.facts.map((f) => f.statement)).toEqual(['x']);
});

function fakeDeps(over: Partial<ScanDeps> = {}) {
  const saved: { path: string; facts: number; version?: string | null }[] = [];
  const removed: string[][] = [];
  const replaced: { facts: number; files: number; scope: FactScope; paths: string[]; versions: (string | null | undefined)[] }[] = [];
  const updates: object[] = [];
  const activity: ActivityInput[] = [];
  const jobIds: (string | null | undefined)[] = [];
  const written: CodeFact[] = [];
  let attempts = 0;
  const deps: ScanDeps = {
    facts: {
      fileHashes: async () => new Map([['src/a.ts', 'stale'], ['src/deleted.ts', 'x']]),
      saveFileFacts: async (_k, f, facts, _s, jobId) => { saved.push({ path: f.path, facts: facts.length, ...(f.version !== undefined && { version: f.version }) }); written.push(...facts); jobIds.push(jobId); },
      markFilesRemoved: async (_k, p) => { removed.push(p); },
      replaceScopeFacts: async (_k, scope, facts, _s, files, jobId) => { replaced.push({ facts: facts.length, files: files.length, scope, paths: facts.map((f) => f.path), versions: files.map((x) => x.version) }); written.push(...facts); jobIds.push(jobId); },
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
  return { deps, saved, removed, replaced, updates, activity, jobIds, written };
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
  expect(a.details!.facts).toEqual([{ kind: 'api', statement: 'f', why: 'callers rely on it', evidence: 'file' }]);
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
  expect(replaced).toMatchObject([{ facts: 4, files: 5, scope: { prefixes: [''], except: [] } }]); // 1 agentic (the one citing a file that does not exist is dropped) + 3 package.json facts
  // Only what the model cited counts as scanned ('.' and a path outside the repo are not files it read).
  expect(r.filesScanned).toBe(0);
});

test('an agentic scan reports the files the model cited as scanned, not every file it was shown', async () => {
  const dir = repo(true);
  const agent = llm({ facts: [
    { kind: 'api', statement: 'a', path: './src/a.ts', lines: null, confidence: 0.9 },
    { kind: 'api', statement: 'a2', path: 'src/a.ts', lines: null, confidence: 0.9 },
    { kind: 'api', statement: 'b', path: 'src/b.py', lines: null, confidence: 0.9 },
  ] }, true);
  const { deps, updates, activity } = fakeDeps({ llm: agent });
  const r = await runScan(job(dir), deps);
  expect(r.filesScanned).toBe(2);
  expect(updates.at(-1)).toMatchObject({ status: 'done', filesScanned: 2 });
  expect(activity.at(-1)!.subject).toMatch(/^scanned 2 files/);
});

test('a project with no code files finishes at once: done, no facts, no model call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbscan-'));
  writeFileSync(join(dir, 'notes.txt'), 'x');
  let calls = 0;
  const { deps, updates } = fakeDeps({ llm: llm(() => { calls++; return { facts: [] }; }, true) });
  deps.facts.fileHashes = async () => new Map();
  expect(await runScan(job(dir), deps)).toEqual({ filesScanned: 0, factsAdded: 0, failed: 0, remaining: 0 });
  expect(calls).toBe(0);
  expect(updates.at(-1)).toMatchObject({ status: 'done', filesScanned: 0, factsAdded: 0 });
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

test('extractFileFacts keeps no fact that is only a credential', async () => {
  const m = llm({ summary: 'S', facts: [
    { kind: 'config', statement: 'The seed admin password is hunter2', path: 'a', lines: null, confidence: 0.9, why: 'w' },
    { kind: 'config', statement: 'KEY is set to [REDACTED]', path: 'a', lines: null, confidence: 0.9, why: 'w' },
    { kind: 'config', statement: 'The API key is read from ACME_API_KEY at start', path: 'a', lines: null, confidence: 0.9, why: 'w' },
  ] });
  const r = await extractFileFacts(m, 'src/config.ts', 'export const KEY = process.env.ACME_API_KEY;');
  expect(r.facts.map((f) => f.statement)).toEqual(['The API key is read from ACME_API_KEY at start']);
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

const timedOut = () => new ModelTimeoutError('Ollama (gemma4) did not answer within 180 s');

test('a file whose model call times out is skipped like any failure, and the scan goes on', async () => {
  const dir = repo(true);
  const slow = llm((user: string) => { if (user.includes('FILE: src/a.ts')) throw timedOut(); return { summary: 'S', facts: [] }; });
  const { deps, saved, updates } = fakeDeps({ llm: slow });
  const r = await runScan(job(dir), deps);
  expect(r).toMatchObject({ failed: 1 });
  expect(saved.map((x) => x.path)).toContain('README.md');
  expect(updates.at(-1)).toMatchObject({ status: 'done', error: '1 file failed: src/a.ts' });
});

test('a model that times out on 3 files in a row fails the run as a counted attempt, instead of waiting out every file or staying queued forever', async () => {
  const dir = repo(true);
  let calls = 0;
  const hung = llm(() => { calls++; throw timedOut(); });
  const { deps, updates } = fakeDeps({ llm: hung });
  await expect(runScan(job(dir), deps)).rejects.toThrow(/3 files in a row timed out.*did not answer within 180 s/);
  expect(calls).toBe(3);
  expect(updates.at(-1)).toMatchObject({ status: 'queued', counted: true, attempts: 1 });
});

test('an agentic scan that times out counts an attempt (it is not mistaken for an unavailable model)', async () => {
  const { deps, updates } = fakeDeps({ llm: { id: 'codex-cli', agentic: true, json: async () => { throw new Error('codex exit 124: \ncodex timed out after 1800000ms'); } } });
  await expect(runScan(job(repo(true)), deps)).rejects.toThrow(/timed out/);
  expect(updates.at(-1)).toMatchObject({ status: 'queued', counted: true, attempts: 1 });
});

test('an agentic answer of the wrong shape is asked again once with a stricter instruction', async () => {
  const systems: string[] = [];
  const replies: unknown[] = [{ facts: 'I explored the repo and' }, { facts: [{ kind: 'architecture', statement: 'Hono API', path: '.', lines: null, confidence: 0.9 }] }];
  const agent: LlmProvider = { id: 'codex-cli', agentic: true, json: async (t) => { systems.push(t.system); return replies.shift(); } };
  const { deps, replaced } = fakeDeps({ llm: agent });
  await runScan(job(repo(true)), deps);
  expect(systems).toHaveLength(2);
  expect(systems[1]).toContain(STRICT_JSON);
  expect(replaced).toMatchObject([{ facts: 4, files: 5 }]);
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
  expect(replaced[0].files).toBe(files.length);
  expect(r.filesScanned).toBe(0); // the model cited only "."
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

test('listCodeFilesWithTotal ranks before capping: source, not the alphabetically first config, fills a small cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbscan-'));
  const w = (p: string, c = 'x') => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  for (let i = 0; i < 5; i++) w(`.github/workflows/w${i}.yml`);
  for (let i = 0; i < 5; i++) w(`deploy/k8s/s${i}.yaml`);
  w('docs/guide.md');
  w('src/webapp/page.tsx', 'export const p = 1;');
  w('src/webapp/page.test.tsx', 'import "./page";');
  w('go.mod', 'module example.com/demo\n');
  const r = await listCodeFilesWithTotal(dir, { maxBytes: 80_000, maxFiles: 3 });
  expect(r.files.map((f) => f.path)).toEqual(['go.mod', 'src/webapp/page.tsx', 'src/webapp/page.test.tsx']);
  expect(r.totalCandidates).toBe(14);
  expect(r.cap).toBe(3);
});

test('a large file is read in parts cut where its functions start, not cut off at 24,000 characters', async () => {
  const fn = (name: string) => `export function ${name}() {\n${`  const x = '${'y'.repeat(70)}';\n`.repeat(200)}}\n`;
  const content = [fn('first'), fn('second'), fn('third')].join('');
  const seen: string[] = [];
  const m = llm((user: string) => {
    seen.push(user);
    const part = seen.length;
    return { summary: `S${part}`, facts: [{ kind: 'api', statement: `from part ${part}`, path: 'x', lines: null, confidence: 0.9, why: 'w', relevance: 0.5 }] };
  });
  const r = await extractFileFacts(m, 'src/big.ts', content);
  expect(seen).toHaveLength(3);
  expect(seen[0]).toMatch(/^FILE: src\/big\.ts \(lines 1-202, part 1 of 3\)\n\nexport function first/);
  expect(seen[2]).toContain('export function third');
  expect(r.summary).toBe('S1');
  expect(r.facts.map((f) => f.statement)).toEqual(['from part 1', 'from part 2', 'from part 3']);
});

test('hasCodeFiles: false for a folder with nothing worth scanning, so its scan needs no slot', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'fbscan-'));
  writeFileSync(join(empty, 'notes.txt'), 'x');
  writeFileSync(join(empty, '.env'), 'TOKEN=x');
  expect(await hasCodeFiles(empty)).toBe(false);
  expect(await hasCodeFiles(repo(true))).toBe(true);
  expect(await hasCodeFiles(join(empty, 'missing'))).toBe(false);
});

test('listCodeFilesWithTotal puts files sessions edited first, and scales an unset cap with the repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbscan-'));
  const w = (p: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), 'x'); };
  for (let i = 0; i < 450; i++) w(`src/m${String(i).padStart(3, '0')}.ts`);
  w('docs/edited.md');
  const r = await listCodeFilesWithTotal(dir, { maxBytes: 80_000, maxFiles: null, priority: ['docs/edited.md'] });
  expect(r.cap).toBe(400);
  expect(r.files).toHaveLength(400);
  expect(r.files[0].path).toBe('docs/edited.md');
  expect(r.totalCandidates).toBe(451);
});

/** A pnpm workspace: packages/core and packages/api (6 source files each, their own package.json) and root files. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'fbscan-ws-'));
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  w('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }));
  w('README.md', '# demo\n');
  for (const d of ['docs/a.md', 'docs/b.md', 'docs/c.md']) w(d, '# doc\n');
  for (const pkg of ['core', 'api']) {
    w(`packages/${pkg}/package.json`, JSON.stringify({ name: `@demo/${pkg}`, dependencies: { zod: '^3' } }));
    for (let i = 0; i < 6; i++) w(`packages/${pkg}/src/m${i}.ts`, `export const ${pkg}${i} = ${i};\n`);
  }
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  return dir;
}

/** The shard a prompt is about, from its "SHARD: <key>" line. */
const shardOf = (user: string) => user.match(/^SHARD: (\S+)/m)?.[1] ?? '?';
/** An agent answering each shard with one fact about its first listed file, one about the shard as a whole and one outside it. */
const shardAgent = (onShard: (shard: string) => void = () => {}) => llm((user: string) => {
  const shard = shardOf(user);
  onShard(shard);
  const first = user.split('\n').find((l) => /\.ts$/.test(l)) ?? 'README.md';
  return { facts: [
    { kind: 'api', statement: `about ${first}`, path: first, lines: null, confidence: 0.9 },
    { kind: 'architecture', statement: `whole of ${shard}`, path: '.', lines: null, confidence: 0.9 },
    { kind: 'convention', statement: `outside ${shard}`, path: shard === 'packages/api' ? 'packages/core/src/m0.ts' : 'packages/api/src/m0.ts', lines: null, confidence: 0.9 },
  ] };
}, true);

test('an agentic scan of a workspace runs one agent pass per package with its own file list, and replaces only that package', async () => {
  const dir = workspace();
  const agent = shardAgent();
  const { deps, replaced, updates } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map();
  const r = await runScan(job(dir), deps);
  expect(agent.seen.map((s) => shardOf(s.user))).toEqual(['.', 'packages/api', 'packages/core']);
  expect(agent.seen.every((s) => s.cwd === dir)).toBe(true);
  const core = agent.seen.find((s) => shardOf(s.user) === 'packages/core')!.user;
  expect(core).toContain('packages/core/src/m0.ts');
  expect(core).not.toContain('packages/api/');
  expect(core).not.toContain('README.md');
  expect(replaced.map((x) => x.scope)).toEqual([
    { prefixes: [''], except: ['packages/api', 'packages/core'] },
    { prefixes: ['packages/api'], except: [] },
    { prefixes: ['packages/core'], except: [] },
  ]);
  const coreSave = replaced[2];
  expect(coreSave.files).toBe(7);
  // Its own file, the package as a whole (filed under its directory) and its package.json facts; never the other package's file.
  expect([...new Set(coreSave.paths)].sort()).toEqual(['packages/core', 'packages/core/package.json', 'packages/core/src/m0.ts']);
  expect(replaced[0].paths).toContain('.');
  expect(replaced[0].paths).not.toContain('packages/api/src/m0.ts');
  expect(r.shards).toEqual([
    { shard: '.', files: 6, facts: 3, skipped: false },
    { shard: 'packages/api', files: 7, facts: 3, skipped: false },
    { shard: 'packages/core', files: 7, facts: 3, skipped: false },
  ]);
  expect(updates.at(-1)).toMatchObject({ status: 'done', shards: { total: 3, rescanned: 3, failed: 0 } });
});

test('an agentic scan records its progress after each shard it runs: shards done of total and facts so far', async () => {
  const dir = workspace();
  const { deps, updates } = fakeDeps({ llm: shardAgent() });
  deps.facts.fileHashes = async () => new Map();
  await runScan(job(dir), deps);
  const progress = updates.filter((u) => !('status' in u));
  expect(progress).toEqual([
    { factsAdded: 3, filesScanned: 1, shards: { total: 3, done: 1, rescanned: 1, failed: 0, processed: ['.'] } },
    { factsAdded: 6, filesScanned: 2, shards: { total: 3, done: 2, rescanned: 2, failed: 0, processed: ['.', 'packages/api'] } },
    { factsAdded: 9, filesScanned: 3, shards: { total: 3, done: 3, rescanned: 3, failed: 0, processed: ['.', 'packages/api', 'packages/core'] } },
  ]);
});

/** A job record the fake store keeps up to date from updateScanJob and requeueScanJob, so a run can pick up the last one. */
function storedJob(dir: string, deps: ScanDeps) {
  let current: ScanJob = job(dir);
  const requeued: string[] = [];
  const update = deps.facts.updateScanJob;
  deps.facts.updateScanJob = async (id, p) => {
    await update(id, p);
    current = { ...current, ...p } as ScanJob;
  };
  deps.facts.requeueScanJob = async (id) => {
    requeued.push(id);
    current = { ...current, status: 'queued', servedAt: 'now' };
  };
  return { get: () => current, requeued };
}

test('a sharded scan gives up its slot after a shard while another scan waits, and goes on from the next shard with its progress whole', async () => {
  const dir = workspace();
  const agent = shardAgent((s) => { if (s === 'packages/api') throw new Error('bad answer'); });
  const { deps, updates, replaced, activity } = fakeDeps({ llm: agent });
  // Nothing is saved between runs here, so only the job's own record of its shards can stop a shard running twice.
  deps.facts.fileHashes = async () => new Map();
  const stored = storedJob(dir, deps);
  deps.yieldTurn = async () => true;

  const first = await runScan(stored.get(), deps);
  expect(first).toMatchObject({ paused: true, factsAdded: 3 });
  expect(stored.requeued).toEqual(['j']);
  expect(stored.get()).toMatchObject({ status: 'queued', factsAdded: 3, shards: { total: 3, done: 1, rescanned: 1, failed: 0, processed: ['.'] } });
  expect(updates.some((u) => (u as { status?: string }).status === 'done')).toBe(false);

  // Its turn again: the next shard (it fails), then it gives up the slot again.
  expect(await runScan(stored.get(), deps)).toMatchObject({ paused: true });
  expect(stored.get().shards).toMatchObject({ total: 3, done: 2, rescanned: 2, failed: 1, processed: ['.', 'packages/api'], failedKeys: ['packages/api'] });

  // The last shard: nothing is left to give way for, so it finishes, counting every run's shards and facts.
  const last = await runScan(stored.get(), deps);
  expect(last.paused).toBeUndefined();
  expect(stored.requeued).toHaveLength(2);
  expect(agent.seen.map((s) => shardOf(s.user))).toEqual(['.', 'packages/api', 'packages/core']);
  expect(replaced.map((x) => x.scope.prefixes)).toEqual([[''], ['packages/core']]);
  expect(stored.get()).toMatchObject({ status: 'done', factsAdded: 6, error: '1 shard failed: packages/api', shards: { total: 3, rescanned: 3, failed: 1 } });
  expect(stored.get().shards).not.toHaveProperty('processed');
  // One scan in Activity: started once, finished once.
  expect(activity.filter((a) => a.kind === 'scan_started')).toHaveLength(1);
  expect(activity.filter((a) => a.kind === 'scan_finished')).toHaveLength(1);
});

test('a file an agent asks for while a sharded scan waits its turn is read when it goes on, even in a shard it already got through', async () => {
  const dir = workspace();
  const asked: string[] = [];
  const { deps } = fakeDeps({ llm: shardAgent((s) => asked.push(s)) });
  deps.facts.fileHashes = async () => new Map();
  const stored = storedJob(dir, deps);
  deps.yieldTurn = async () => true;
  await runScan(stored.get(), deps);
  expect(asked).toEqual(['.']);
  // get_task_context named a root file meanwhile: the shard holding it runs first, then the next one.
  deps.facts.scanRequests = async () => ['README.md'];
  deps.facts.clearScanRequests = async () => { deps.facts.scanRequests = async () => []; };
  await runScan(stored.get(), deps);
  expect(asked).toEqual(['.', '.']);
  await runScan(stored.get(), deps);
  await runScan(stored.get(), deps);
  expect(asked).toEqual(['.', '.', 'packages/api', 'packages/core']);
  expect(stored.get()).toMatchObject({ status: 'done', shards: { total: 3, rescanned: 3 } });
});

test('a sharded scan that gives way keeps its file list and shard plan for its next turn while HEAD stays, never its mirror, and builds them again once HEAD moves', async () => {
  const dir = workspace();
  const commit = () => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'c']);
  commit();
  let made = 0;
  let disposed = 0;
  const agent = shardAgent();
  agent.mirror = async () => { made++; return { dir: `/scratch/fb-mirror-${made}`, dispose: async () => { disposed++; } }; };
  const { deps } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map();
  const stored = storedJob(dir, deps);
  deps.yieldTurn = async () => true;
  const plans = new ScanPlans();
  deps.plans = plans;

  expect(await runScan(stored.get(), deps)).toMatchObject({ paused: true });
  // Waiting its turn, no copy of the repo is left where another project's scan could read it.
  expect([made, disposed]).toEqual([1, 1]);
  // Its next turn, HEAD unchanged: the kept plan, no new listing; a fresh mirror.
  expect(await runScan(stored.get(), deps)).toMatchObject({ paused: true });
  expect([made, disposed, plans.reused]).toEqual([2, 2, 1]);
  expect(agent.seen.map((s) => s.cwd)).toEqual(['/scratch/fb-mirror-1', '/scratch/fb-mirror-2']);

  // A commit lands while it waits: listed again (the new file is in its shard), a new mirror, the old one removed.
  writeFileSync(join(dir, 'packages/core/src/fresh.ts'), 'export const fresh = 1;\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  commit();
  const last = await runScan(stored.get(), deps);
  expect(last.paused).toBeUndefined();
  expect(agent.seen.map((s) => shardOf(s.user))).toEqual(['.', 'packages/api', 'packages/core']);
  expect(agent.seen[2].user).toContain('packages/core/src/fresh.ts');
  expect(agent.seen[2].cwd).toBe('/scratch/fb-mirror-3');
  expect([made, disposed, plans.reused]).toEqual([3, 3, 1]);
  expect(stored.get()).toMatchObject({ status: 'done', shards: { total: 3, rescanned: 3 } });
});

test('kept scan plans are bounded, and only handed back for the same repo and HEAD', () => {
  const plans = new ScanPlans(2);
  const plan = { head: 'h', repoPath: '/repo', listed: [], churn: new Map(), planned: [] };
  plans.keep('a', plan);
  plans.keep('b', plan);
  plans.keep('c', plan);
  expect(plans.take('a', '/repo', 'h')).toBeNull(); // the oldest went
  expect(plans.take('b', '/repo', 'other')).toBeNull(); // another HEAD
  expect(plans.take('b', '/repo', 'h')).toBeNull(); // and it is gone
  expect(plans.take('c', '/elsewhere', 'h')).toBeNull(); // another repo
  plans.keep('d', plan);
  expect(plans.take('d', '/repo', 'h')).toBe(plan);
});

test('a sharded scan with no one waiting runs on without giving up its slot', async () => {
  const dir = workspace();
  const { deps } = fakeDeps({ llm: shardAgent() });
  deps.facts.fileHashes = async () => new Map();
  const stored = storedJob(dir, deps);
  let asked = 0;
  deps.yieldTurn = async () => { asked++; return false; };
  expect((await runScan(stored.get(), deps)).paused).toBeUndefined();
  expect(stored.requeued).toEqual([]);
  // Asked after each shard but the last.
  expect(asked).toBe(2);
  expect(stored.get()).toMatchObject({ status: 'done', factsAdded: 9 });
});

test('the prompt tells the agent its shard, its path prefix and a budget scaled to the shard', async () => {
  const dir = workspace();
  const systems: string[] = [];
  const agent: LlmProvider = { id: 'claude-cli', agentic: true, json: async (t) => { systems.push(t.system); return { facts: [] }; } };
  const { deps } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map();
  await runScan(job(dir), deps);
  expect(systems[2]).toMatch(/packages\/core/);
  expect(systems[2]).toMatch(/Return 4 to 11 facts/);
  expect(systems[2]).toMatch(/only about files in this part/i);
});

test('a rescan only revisits the shards whose files changed; the others keep their facts and are reported as unchanged', async () => {
  const dir = workspace();
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  const asked: string[] = [];
  const { deps, replaced, updates, activity } = fakeDeps({ llm: shardAgent((s) => asked.push(s)) });
  deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.path === 'packages/api/src/m3.ts' ? 'old' : f.hash]));
  deps.facts.currentSources = async () => ['claude-cli'];
  const r = await runScan(job(dir), deps);
  expect(asked).toEqual(['packages/api']);
  expect(replaced.map((x) => x.scope.prefixes)).toEqual([['packages/api']]);
  expect(r.shards).toEqual([
    { shard: '.', files: 6, facts: 0, skipped: true },
    { shard: 'packages/api', files: 7, facts: 3, skipped: false },
    { shard: 'packages/core', files: 7, facts: 0, skipped: true },
  ]);
  expect(updates.at(-1)).toMatchObject({ status: 'done', shards: { total: 3, rescanned: 1, failed: 0 } });
  const finished = activity.at(-1)!;
  expect(finished.subject).toMatch(/1 of 3 shards rescanned/);
  expect(finished.details).toMatchObject({ shards: r.shards });

  // A file removed from a shard is a change too.
  asked.length = 0;
  deps.facts.fileHashes = async () => new Map([...files.map((f) => [f.path, f.hash] as [string, string]), ['packages/core/src/gone.ts', 'x']]);
  await runScan(job(dir), deps);
  expect(asked).toEqual(['packages/core']);

  // Nothing changed: no agent run at all.
  asked.length = 0;
  deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  expect(await runScan(job(dir), deps)).toMatchObject({ factsAdded: 0, failed: 0 });
  expect(asked).toEqual([]);
});

test('facts from a different model rescan every shard', async () => {
  const dir = workspace();
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  const asked: string[] = [];
  const { deps } = fakeDeps({ llm: shardAgent((s) => asked.push(s)) });
  deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  deps.facts.currentSources = async () => ['codex-cli'];
  await runScan(job(dir), deps);
  expect(asked).toEqual(['.', 'packages/api', 'packages/core']);
});

test('after a model switch, only the shards still holding the other model\'s facts are rescanned, so one failed shard does not redo the repo', async () => {
  const dir = workspace();
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  const asked: string[] = [];
  const { deps } = fakeDeps({ llm: shardAgent((s) => asked.push(s)) });
  deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  // The last scan with claude-cli saved every shard but packages/api, which still has codex-cli's facts.
  deps.facts.currentSources = async () => ['claude-cli', 'codex-cli'];
  deps.facts.listFacts = async () => [
    { path: 'README.md', source: 'claude-cli', docId: null, origin: 'model' },
    { path: 'packages/core/src/m0.ts', source: 'claude-cli', docId: null, origin: 'model' },
    { path: 'packages/api/src/m0.ts', source: 'codex-cli', docId: null, origin: 'model' },
    { path: 'packages/core', source: 'you', docId: null, origin: 'you' },
  ] as never;
  await runScan(job(dir), deps);
  expect(asked).toEqual(['packages/api']);
});

test('one shard failing fails only that shard: the others are saved, its hashes stay stale for the next scan, and the job is done', async () => {
  const dir = workspace();
  const agent = shardAgent((s) => { if (s === 'packages/api') throw new Error('bad answer'); });
  const { deps, replaced, updates, activity } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map();
  const r = await runScan(job(dir), deps);
  expect(replaced.map((x) => x.scope.prefixes)).toEqual([[''], ['packages/core']]);
  expect(r).toMatchObject({ failed: 1 });
  expect(r.shards!.find((s) => s.shard === 'packages/api')).toMatchObject({ skipped: false, facts: 0, failed: 'Error: bad answer' });
  expect(updates.at(-1)).toMatchObject({ status: 'done', error: '1 shard failed: packages/api', shards: { total: 3, rescanned: 3, failed: 1 } });
  expect(activity.find((a) => a.subject === 'could not extract facts from packages/api')).toMatchObject({ why: 'Error: bad answer' });
});

test('every shard failing fails the run as a counted attempt', async () => {
  const dir = workspace();
  const { deps, replaced, updates } = fakeDeps({ llm: shardAgent(() => { throw new Error('bad answer'); }) });
  deps.facts.fileHashes = async () => new Map();
  await expect(runScan(job(dir), deps)).rejects.toThrow(/all 3 shards failed.*bad answer/);
  expect(replaced).toEqual([]);
  expect(updates.at(-1)).toMatchObject({ status: 'queued', counted: true, attempts: 1 });
});

test('an unavailable model stops a sharded scan (shards saved so far stay) and leaves the job queued', async () => {
  const dir = workspace();
  const agent = shardAgent((s) => { if (s === 'packages/api') throw new Error('claude exit 1: Invalid API key · Please run /login'); });
  const { deps, replaced, updates } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map();
  await expect(runScan(job(dir), deps)).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(replaced.map((x) => x.scope.prefixes)).toEqual([['']]);
  expect(agent.seen).toHaveLength(2);
  expect(updates.at(-1)).toMatchObject({ status: 'queued', counted: false });
});

test('three shards in a row timing out stop the run instead of waiting out every shard', async () => {
  const dir = workspace();
  // A fourth package, so a fourth shard is left when the third timeout stops the run.
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'tools/*'\n");
  mkdirSync(join(dir, 'tools/gen'), { recursive: true });
  writeFileSync(join(dir, 'tools/gen/package.json'), '{}');
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, `tools/gen/g${i}.ts`), 'export {};\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const agent = shardAgent(() => { throw new Error('codex exit 124: \ncodex timed out after 1800000ms'); });
  const { deps, updates } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map();
  await expect(runScan(job(dir), deps)).rejects.toThrow(/3 shards in a row timed out/);
  expect(agent.seen).toHaveLength(3);
  expect(updates.at(-1)).toMatchObject({ status: 'queued', counted: true });
});

test('a shard an older scanner read is rescanned even though none of its files changed; one the current scanner read is skipped', async () => {
  const dir = workspace();
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  const asked: string[] = [];
  const { deps, replaced, activity } = fakeDeps({ llm: shardAgent((s) => asked.push(s)) });
  deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  deps.facts.currentSources = async () => ['claude-cli'];
  // packages/api was read by 0.6.0's scanner (or before versions were kept): its facts are an old skim.
  deps.facts.fileScanVersions = async () => new Map(files.map((f) => [f.path, f.path.startsWith('packages/api/') ? (f.path.endsWith('m0.ts') ? null : 'scan-v4') : SCANNER_VERSION]));
  await runScan(job(dir), deps);
  expect(asked).toEqual(['packages/api']);
  // What it saves carries the current version, so the next scan skips it.
  expect(replaced[0].versions).toEqual(Array(7).fill(SCANNER_VERSION));
  expect(activity[0].why).toMatch(/7 files were read by an older scanner/);
});

test('a per-file scan rereads unchanged files an older scanner read, and saves the version with each file', async () => {
  const dir = repo(true);
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  const { deps, saved } = fakeDeps();
  deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  deps.facts.fileScanVersions = async () => new Map(files.map((f) => [f.path, f.path === 'src/a.ts' ? 'scan-v4' : SCANNER_VERSION]));
  await runScan(job(dir), deps);
  expect(saved.map((s) => [s.path, s.version])).toEqual([['src/a.ts', SCANNER_VERSION]]);
});

test('the agent sees its files by directory, hotspots first, with a minimum for each large directory, and is asked what it did not reach', async () => {
  const dir = workspace();
  // A large directory in packages/core, and a file with the kind of comment traps are written down in.
  for (let i = 0; i < 40; i++) writeFileSync(join(dir, `packages/core/src/m${i}.ts`), `export const core${i} = ${i};\n`);
  mkdirSync(join(dir, 'packages/core/lib'));
  writeFileSync(join(dir, 'packages/core/lib/render.ts'), `${Array(14).fill('// The HTML5 parser ignores a self-closing slash on custom elements, so tags are paired first.').join('\n')}\nexport {};\n`);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const seen: { user: string; schema: object; system: string }[] = [];
  const agent: LlmProvider = { id: 'claude-cli', agentic: true, json: async (t) => { seen.push({ user: t.user, schema: t.schema, system: t.system }); return { facts: [], unreached: [] }; } };
  const { deps } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map();
  await runScan(job(dir), deps);
  const core = seen.find((s) => shardOf(s.user) === 'packages/core')!;
  const lines = core.user.split('\n');
  // The hotspot is listed first, before the directories.
  expect(lines.slice(1, 3)).toEqual([expect.stringMatching(/^Read these first/), 'packages/core/lib/render.ts']);
  expect(core.user).toMatch(/^## packages\/core\/src \(40 files\): at least \d+ facts? from here$/m);
  expect(core.user).toMatch(/^## packages\/core \(1 file\)$/m);
  expect(core.system).toMatch(/unreached/);
  expect(JSON.stringify(core.schema)).toContain('"unreached"');
});

test('what an agent did not reach is kept to its shard and stored on the job, in the result and in Activity', async () => {
  const dir = workspace();
  const agent = llm((user: string) => ({ facts: [], unreached: shardOf(user) === 'packages/core' ? ['packages/core/src', './packages/core/src/m5.ts', 'packages/api/src', ''] : [] }), true);
  const { deps, updates, activity } = fakeDeps({ llm: agent });
  deps.facts.fileHashes = async () => new Map();
  const r = await runScan(job(dir), deps);
  expect(r.shards!.find((s) => s.shard === 'packages/core')).toMatchObject({ unreached: ['packages/core/src', 'packages/core/src/m5.ts'] });
  expect(r.shards!.find((s) => s.shard === 'packages/api')!.unreached).toBeUndefined();
  expect(updates.at(-1)).toMatchObject({ shards: { total: 3, rescanned: 3, failed: 0, unreached: ['packages/core/src', 'packages/core/src/m5.ts'] } });
  const core = activity.find((a) => a.kind === 'facts_extracted' && a.details?.shard === 'packages/core')!;
  expect(core.why).toMatch(/did not reach 2: packages\/core\/src, packages\/core\/src\/m5\.ts/);
  expect(core.details).toMatchObject({ unreached: ['packages/core/src', 'packages/core/src/m5.ts'] });
  expect(activity.at(-1)!.subject).toMatch(/2 places not reached/);
});

test('an agentic scan mirrors the repo once for all its shards, and removes the mirror at the end, even when it fails', async () => {
  const dir = workspace();
  let made = 0;
  let disposed = 0;
  const cwds: (string | undefined)[] = [];
  const agent = (fail: boolean): LlmProvider => ({
    id: 'codex-cli', agentic: true,
    mirror: async (repo) => { expect(repo).toBe(dir); made++; return { dir: '/scratch/fb-mirror-1', dispose: async () => { disposed++; } }; },
    json: async (t) => { cwds.push(t.cwd); if (fail) throw new Error('codex exit 1'); return { facts: [] }; },
  });
  const { deps } = fakeDeps({ llm: agent(false) });
  deps.facts.fileHashes = async () => new Map();
  await runScan(job(dir), deps);
  expect([made, disposed]).toEqual([1, 1]);
  expect(cwds).toEqual(Array(3).fill('/scratch/fb-mirror-1'));
  // Every shard failing: the run fails, the mirror still goes.
  const failing = fakeDeps({ llm: agent(true) }).deps;
  failing.facts.fileHashes = async () => new Map();
  await expect(runScan(job(dir), failing)).rejects.toThrow();
  expect([made, disposed]).toEqual([2, 2]);
  // Nothing to rescan: no mirror at all.
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  const idle = fakeDeps({ llm: agent(false) }).deps;
  idle.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  idle.facts.currentSources = async () => ['codex-cli'];
  await runScan(job(dir), idle);
  expect(made).toBe(2);
});

test('files an agent asked for are read first even when unchanged, and are no longer asked for once read (or gone)', async () => {
  const dir = workspace();
  const files = await listCodeFiles(dir, { maxBytes: 80_000, maxFiles: 100 });
  const asked: string[] = [];
  const cleared: string[][] = [];
  const { deps, replaced } = fakeDeps({ llm: shardAgent((s) => asked.push(s)) });
  deps.facts.fileHashes = async () => new Map(files.map((f) => [f.path, f.hash]));
  deps.facts.currentSources = async () => ['claude-cli'];
  deps.facts.scanRequests = async () => ['packages/core/src/m3.ts', 'packages/gone.ts'];
  deps.facts.clearScanRequests = async (_k, p) => { cleared.push(p); };
  await runScan(job(dir), deps);
  // Only the shard holding the requested file, though nothing in it changed; the requested file is the first listed.
  expect(asked).toEqual(['packages/core']);
  expect(replaced[0].paths).toContain('packages/core/src/m3.ts');
  expect(cleared.flat().sort()).toEqual(['packages/core/src/m3.ts', 'packages/gone.ts']);
});

test('a per-file scan reads requested files first, then files with long explanatory comments, before path order', async () => {
  const dir = repo(true);
  writeFileSync(join(dir, 'src/b.py'), `${Array(14).fill('# Retries are idempotent because every write carries a request id from the caller.').join('\n')}\ndef b(): pass\n`);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const order = async (requested: string[]) => {
    const { deps, saved } = fakeDeps({ maxFiles: 2 });
    deps.facts.fileHashes = async () => new Map();
    deps.facts.scanRequests = async () => requested;
    deps.facts.clearScanRequests = async () => {};
    await runScan(job(dir), deps);
    return saved.map((s) => s.path);
  };
  expect(await order([])).toEqual(['src/b.py', 'package.json']);
  expect(await order(['README.md'])).toEqual(['README.md', 'src/b.py']);
});
