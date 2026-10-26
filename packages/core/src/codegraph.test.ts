import { expect, test } from 'vitest';
import { CODE_MAP_VERSION, codeGraphViews, codeMapDiff, expandDependents, hotspotScore, isCodeLang, isGitCommit, mapIncomplete, normalizeCodeMap, pathMatches, repoRelative, sessionFiles, sessionWork, suggestLessonPaths, touchedAround, trailingToolCalls, type CodeGraphReads, type MapFile } from './codegraph.ts';
import { hostRepoPath } from './projects.ts';
import type { ParsedSession, ToolCall } from './types.ts';

test('repoRelative keeps paths inside the repo, normalized, and refuses everything outside it', () => {
  expect(repoRelative('/h/vibe/demo/src/a.ts', '/h/vibe/demo')).toBe('src/a.ts');
  expect(repoRelative('/h/vibe/demo/src/../lib/./b.ts', '/h/vibe/demo/')).toBe('lib/b.ts');
  expect(repoRelative('src/a.ts', '/h/vibe/demo', '/h/vibe/demo/packages/x')).toBe('packages/x/src/a.ts');
  expect(repoRelative('/h/vibe/demo/../other/a.ts', '/h/vibe/demo')).toBeNull();
  expect(repoRelative('../../etc/passwd', '/h/vibe/demo', '/h/vibe/demo/src')).toBeNull();
  expect(repoRelative('/h/vibe/demo-two/a.ts', '/h/vibe/demo')).toBeNull();
  expect(repoRelative('/h/vibe/demo', '/h/vibe/demo')).toBeNull();
  expect(repoRelative('/h/vibe/demo/a\0.ts', '/h/vibe/demo')).toBeNull();
  expect(repoRelative('', '/h/vibe/demo')).toBeNull();
});

test('hostRepoPath is the host folder of the project a cwd is in', () => {
  const roots = [{ host: '/Users/me/Vibe', container: '/projects' }];
  expect(hostRepoPath('/Users/me/Vibe/demo/packages/api', roots)).toBe('/Users/me/Vibe/demo');
  expect(hostRepoPath('/elsewhere/demo', roots)).toBeNull();
});

const call = (name: string, filePath: string, ts = '2026-10-01T10:00:00Z'): ToolCall => ({ name, ts, filePath });

test('sessionFiles records which repo files a session read and edited, with the first and last edit time', () => {
  const s: ParsedSession = {
    sessionId: 's', sourceFile: 'f', cwd: '/h/demo/src', gitBranch: null, startedAt: '', endedAt: '', turns: [],
    toolCalls: [
      call('Read', '/h/demo/src/a.ts'),
      call('Edit', '/h/demo/src/a.ts', '2026-10-01T10:05:00+02:00'),
      call('Write', 'b.ts', '2026-10-01T10:01:00Z'),
      call('MultiEdit', '/h/demo/src/a.ts', '2026-10-01T10:09:00Z'),
      call('Delete', '/h/demo/old.ts'),
      call('Read', '/etc/hosts'),
      call('Edit', '/h/demo/.env'),
      { name: 'Bash', ts: '2026-10-01T10:00:00Z', command: 'ls' },
    ],
  };
  expect(sessionFiles(s, '/h/demo')).toEqual([
    { path: 'old.ts', read: false, edited: true, firstEditAt: '2026-10-01T10:00:00.000Z', lastEditAt: '2026-10-01T10:00:00.000Z' },
    { path: 'src/a.ts', read: true, edited: true, firstEditAt: '2026-10-01T08:05:00.000Z', lastEditAt: '2026-10-01T10:09:00.000Z' },
    { path: 'src/b.ts', read: false, edited: true, firstEditAt: '2026-10-01T10:01:00.000Z', lastEditAt: '2026-10-01T10:01:00.000Z' },
  ]);
});

test('pathMatches: plain paths match the file or the folder under it; globs follow gitignore-like rules', () => {
  expect(pathMatches('src/db.ts', 'src/db.ts')).toBe(true);
  expect(pathMatches('./src/db', 'src/db/pool.ts')).toBe(true);
  expect(pathMatches('src/db', 'src/dbx.ts')).toBe(false);
  expect(pathMatches('src/**/*.sql', 'src/a/b/c.sql')).toBe(true);
  expect(pathMatches('src/**/*.sql', 'src/c.sql')).toBe(true);
  expect(pathMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
  expect(pathMatches('*.sql', 'migrations/0001.sql')).toBe(true);
  expect(pathMatches('migrations/**', 'migrations/0001.sql')).toBe(true);
  expect(pathMatches('', 'a.ts')).toBe(false);
  expect(pathMatches('**', 'a.ts')).toBe(true);
});

test('hotspotScore weighs misses most, then churn and dependents on a log scale', () => {
  expect(hotspotScore({ churn: 0, misses: 0, dependents: 0 })).toBe(0);
  expect(hotspotScore({ churn: 3, misses: 0, dependents: 1 })).toBe(3);
  expect(hotspotScore({ churn: 3, misses: 2, dependents: 1 })).toBe(11);
  expect(hotspotScore({ churn: 2, misses: 0, dependents: 0 })).toBe(1.58);
  expect(hotspotScore({ churn: 0, misses: 1, dependents: 0 })).toBeGreaterThan(hotspotScore({ churn: 7, misses: 0, dependents: 0 }));
});

test('expandDependents walks importers breadth first up to a depth, nearest first, each file once', async () => {
  const importers: Record<string, string[]> = { 'db.ts': ['repo.ts', 'cli.ts'], 'repo.ts': ['api.ts', 'db.ts'], 'api.ts': ['main.ts'], 'cli.ts': [] };
  const asked: string[][] = [];
  const of = async (paths: string[]) => {
    asked.push(paths);
    return new Map(paths.map((p) => [p, importers[p] ?? []]));
  };
  expect(await expandDependents(['db.ts'], 2, of)).toEqual([
    { path: 'cli.ts', depth: 1 }, { path: 'repo.ts', depth: 1 }, { path: 'api.ts', depth: 2 },
  ]);
  expect(asked).toEqual([['db.ts'], ['cli.ts', 'repo.ts']]);
  expect(await expandDependents(['db.ts'], 0, of)).toEqual([]);
});

test('suggestLessonPaths keeps model paths the evidence supports, else the narrowest scope the edits show', () => {
  const touched = { edited: ['src/db/pool.ts', 'src/db/query.ts', 'src/api/orders.ts'], fixed: ['src/db/pool.ts'] };
  // the model's own globs survive when they cover a file the session edited
  expect(suggestLessonPaths(['src/db/**', 'docs/**'], touched)).toEqual(['src/db/**']);
  // none supported: the files edited to fix it
  expect(suggestLessonPaths(['docs/**'], touched)).toEqual(['src/db/pool.ts']);
  // many fix files in one folder: that folder
  const many = { edited: [], fixed: ['src/db/a.ts', 'src/db/b.ts', 'src/db/c.ts', 'src/db/d.ts'] };
  expect(suggestLessonPaths([], many)).toEqual(['src/db/**']);
  // fixes everywhere: no narrower scope than the project
  const spread = { edited: [], fixed: ['a.ts', 'b/b.ts', 'c/c.ts', 'd/d.ts'] };
  expect(suggestLessonPaths([], spread)).toEqual([]);
  // no fix edits: what was edited before the feedback
  expect(suggestLessonPaths([], { edited: ['src/x.ts'], fixed: [] })).toEqual(['src/x.ts']);
  // no evidence at all: the model's paths, cleaned
  expect(suggestLessonPaths(['./src/y.ts', '/abs/z.ts', '../up.ts'], { edited: [], fixed: [] })).toEqual(['src/y.ts']);
});

test('touchedAround splits a session\'s edits into before the feedback and the fix after it', () => {
  const f = (path: string, first: string | null, last: string | null, edited = true) => ({ path, read: !edited, edited, firstEditAt: first, lastEditAt: last });
  expect(touchedAround([
    f('a.ts', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z'),
    f('b.ts', '2026-10-01T10:00:00.000Z', '2026-10-01T10:05:00.000Z'),
    f('c.ts', '2026-10-01T10:05:00.000Z', '2026-10-01T10:06:00.000Z'),
    f('d.ts', null, null, false),
  ], '2026-10-01T12:02:00+02:00')).toEqual({ edited: ['a.ts', 'b.ts'], fixed: ['b.ts', 'c.ts'] });
});

test('isGitCommit spots a git commit inside a shell command, and nothing else', () => {
  for (const c of ['git commit -m "x"', 'git add . && git commit -am fix', 'cd /r; git -C /r commit --amend', 'git -c user.name=a commit', 'git --no-pager commit']) expect(isGitCommit(c), c).toBe(true);
  for (const c of ['git status', 'git log --grep commit', 'echo git commit', 'gh pr view', 'git commit-tree abc', 'npm run commit']) expect(isGitCommit(c), c).toBe(false);
});

test('sessionWork counts the edits and commits a session made, and when; reading and other commands are not work', () => {
  const calls: ToolCall[] = [
    { name: 'Read', ts: '2026-10-01T09:00:00Z', filePath: '/r/a.ts' },
    { name: 'Bash', ts: '2026-10-01T09:01:00Z', command: 'git diff' },
    { name: 'Grep', ts: '2026-10-01T09:02:00Z' },
  ];
  expect(sessionWork(calls)).toEqual({ edits: 0, commits: 0, firstAt: null, lastAt: null });
  const work: ToolCall[] = [
    ...calls,
    { name: 'Edit', ts: '2026-10-01T10:00:00+02:00', filePath: '/r/a.ts' },
    { name: 'Write', ts: '2026-10-01T09:30:00Z', filePath: '/r/b.ts' },
    { name: 'MultiEdit', ts: 'not a time', filePath: '/r/c.ts' },
    { name: 'NotebookEdit', ts: '2026-10-01T09:40:00Z', filePath: '/r/n.ipynb' },
    { name: 'Delete', ts: '2026-10-01T09:45:00Z', filePath: '/r/d.ts' },
    { name: 'Bash', ts: '2026-10-01T11:00:00Z', command: 'git commit -m done' },
  ];
  expect(sessionWork(work)).toEqual({ edits: 5, commits: 1, firstAt: '2026-10-01T08:00:00.000Z', lastAt: '2026-10-01T11:00:00.000Z' });
});

test('isCodeLang: docs, data and config are not code; parsed and other programming languages are', () => {
  for (const l of ['typescript', 'python', 'go', 'gdscript', 'rb', 'java', 'sh', 'sql', 'tf', 'css']) expect(isCodeLang(l)).toBe(true);
  for (const l of ['md', 'mdx', 'json', 'yaml', 'yml', 'toml', 'gitignore', 'example', 'godot', 'dockerfile', 'makefile', 'txt']) expect(isCodeLang(l)).toBe(false);
});

function fakeReads(files: { path: string; lang: string; commits: number }[], missesOn: string[] = []): CodeGraphReads {
  const none = async () => [];
  return {
    mapFiles: async (_k, paths) => files.filter((f) => !paths || paths.includes(f.path)).map((f) => ({ path: f.path, lang: f.lang, hash: 'h', loc: 1, isTest: false, churn: { commits: f.commits, lastTs: '2026-10-01' } })),
    outsideFiles: none,
    symbolsOf: none,
    importsOf: none,
    importersOf: async (_k, paths) => new Map(paths.map((p) => [p, []])),
    testsOf: none,
    importerCounts: async () => new Map(),
    missesOn: async () => missesOn.map((path, i) => ({ missId: `m${i}`, missed: 'x', cause: 'other', causeExplanation: '', feedbackId: 'f', feedbackText: '', sessionId: 's', ts: '2026-10-01', lessonId: null, path, fixedHere: false }) as never),
    edgesTouching: async () => ({ imports: [], tests: [] }),
    approvedLessons: none,
    currentFacts: none,
  };
}

test('hotspots: a busy manifest with no miss scores 0, below quiet code; a miss makes any file count', async () => {
  const files = [{ path: 'deploy/api.yaml', lang: 'yaml', commits: 60 }, { path: 'docs/a.md', lang: 'md', commits: 30 }, { path: 'src/a.ts', lang: 'typescript', commits: 1 }];
  const h = await codeGraphViews(fakeReads(files)).hotspots('demo', 10);
  expect(h.map((x) => [x.path, x.score])).toEqual([['src/a.ts', 1], ['deploy/api.yaml', 0], ['docs/a.md', 0]]);
  const withMiss = await codeGraphViews(fakeReads(files, ['docs/a.md'])).hotspots('demo', 10);
  expect(withMiss[0]).toMatchObject({ path: 'docs/a.md', misses: 1 });
  expect(withMiss[0].score).toBeGreaterThan(4);
});

test("every per-file view asks its reads for the caller's run, so another run's sandbox misses, lessons and facts never reach it", async () => {
  const asked: [string, unknown][] = [];
  const base = fakeReads([{ path: 'src/a.ts', lang: 'typescript', commits: 1 }]);
  const reads: CodeGraphReads = {
    ...base,
    missesOn: async (k, p, run) => { asked.push(['missesOn', run]); return base.missesOn(k, p, run); },
    approvedLessons: async (_k, run) => { asked.push(['approvedLessons', run]); return []; },
    currentFacts: async (_k, _p, run) => { asked.push(['currentFacts', run]); return []; },
  };
  const v = codeGraphViews(reads);
  await v.moduleContext('demo', 'src/a.ts', 'sbx-1');
  await v.impact('demo', ['src/a.ts'], 2, 'sbx-1');
  await v.lessonsForPaths('demo', ['src/a.ts'], 'sbx-1');
  await v.hotspots('demo', 5, { run: 'sbx-1' });
  await v.mapGraph('demo', { limit: 5, run: 'sbx-1' });
  expect(asked.length).toBeGreaterThanOrEqual(10);
  expect(asked.every(([, run]) => run === 'sbx-1')).toBe(true);
  asked.length = 0;
  await v.moduleContext('demo', 'src/a.ts');
  await v.hotspots('demo', 5);
  expect(asked.every(([, run]) => run === null)).toBe(true);
});

test('hotspots with missesOnly: only files a confirmed miss touched, however busy the others are', async () => {
  const files = [{ path: 'src/busy.ts', lang: 'typescript', commits: 900 }, { path: 'docs/a.md', lang: 'md', commits: 1 }];
  const h = await codeGraphViews(fakeReads(files, ['docs/a.md'])).hotspots('demo', 1, { missesOnly: true });
  expect(h.map((x) => x.path)).toEqual(['docs/a.md']);
  expect(await codeGraphViews(fakeReads(files)).hotspots('demo', 10, { missesOnly: true })).toEqual([]);
});

test('codeMapDiff rewrites only the files whose symbols changed and the import edges that changed', () => {
  const sym = (path: string, name: string, ord: number, lines = '1-2') => ({ id: `${path}#${name}`, path, name, kind: 'function' as const, exported: true, lines, ord });
  const stored = {
    symbols: [sym('a.ts', 'a', 0), sym('b.ts', 'b', 0), sym('gone.ts', 'g', 0)],
    imports: [
      { from: 'a.ts', to: 'b.ts', names: ['b'], spec: './b' },
      { from: 'b.ts', to: 'pkg:zod', names: ['z'], spec: 'zod' },
      { from: 'gone.ts', to: 'a.ts', names: ['a'], spec: './a' },
      // Two edges for one pair (an older write): the pair is rewritten as one.
      { from: 'c.ts', to: 'a.ts', names: ['a'], spec: './a' },
      { from: 'c.ts', to: 'a.ts', names: ['x'], spec: './a' },
    ],
  };
  const next = {
    symbols: [sym('a.ts', 'a', 0), sym('b.ts', 'b', 0, '1-3'), sym('new.ts', 'n', 0)],
    imports: [
      { from: 'a.ts', to: 'b.ts', names: ['b'], spec: './b' },
      { from: 'b.ts', to: 'pkg:zod', names: ['z', 'y'], spec: 'zod' },
      { from: 'c.ts', to: 'a.ts', names: ['a', 'x'], spec: './a' },
      { from: 'new.ts', to: 'a.ts', names: ['a'], spec: './a' },
    ],
  };
  const d = codeMapDiff(stored, next);
  expect([...d.symbolPaths].sort()).toEqual(['b.ts', 'gone.ts', 'new.ts']);
  expect(d.symbols.map((s) => s.id)).toEqual(['b.ts#b', 'new.ts#n']);
  expect(d.staleImports).toEqual([{ from: 'b.ts', to: 'pkg:zod' }, { from: 'gone.ts', to: 'a.ts' }, { from: 'c.ts', to: 'a.ts' }]);
  expect(d.newImports.map((i) => `${i.from}>${i.to}`)).toEqual(['b.ts>pkg:zod', 'c.ts>a.ts', 'new.ts>a.ts']);
  // Nothing changed: nothing to write.
  expect(codeMapDiff(next, next)).toEqual({ symbolPaths: [], symbols: [], staleImports: [], newImports: [] });
});

const mf = (path: string, isTest = false): MapFile => ({ path, lang: 'typescript', hash: `h-${path}`, loc: 1, isTest });

test('normalizeCodeMap keeps the import index past the cap: outside files with their edges, no symbols, never a mapped file twice', () => {
  const n = normalizeCodeMap({
    files: [mf('src/db.ts'), mf('src/api.ts')],
    // past the cap: they import the mapped files (and each other) but carry no symbols
    outside: [mf('src/cli.ts'), mf('src/db.ts'), mf('test/cli.test.ts', true), mf('src/cli.ts')],
    symbols: [
      { id: 'src/db.ts#Db', path: 'src/db.ts', name: 'Db', kind: 'class', exported: true, lines: '1-2' },
      { id: 'src/cli.ts#run', path: 'src/cli.ts', name: 'run', kind: 'function', exported: true, lines: '1-2' },
    ],
    imports: [
      { from: 'src/api.ts', to: 'src/db.ts', names: ['Db'], spec: './db' },
      { from: 'src/cli.ts', to: 'src/db.ts', names: ['Db'], spec: './db' },
      { from: 'test/cli.test.ts', to: 'src/cli.ts', names: ['run'], spec: '../src/cli' },
      { from: 'src/gone.ts', to: 'src/db.ts', names: [], spec: './db' },
    ],
    tests: [{ test: 'test/cli.test.ts', target: 'src/cli.ts' }],
    churn: {},
    fingerprint: 'f',
    version: CODE_MAP_VERSION,
  });
  expect(n.files.map((f) => f.path)).toEqual(['src/api.ts', 'src/db.ts']);
  expect(n.outside.map((f) => f.path)).toEqual(['src/cli.ts', 'test/cli.test.ts']);
  expect(n.symbols.map((s) => s.id)).toEqual(['src/db.ts#Db']);
  expect(n.imports.map((i) => `${i.from}>${i.to}`)).toEqual(['src/api.ts>src/db.ts', 'src/cli.ts>src/db.ts', 'test/cli.test.ts>src/cli.ts']);
  expect(n.tests).toEqual([{ test: 'test/cli.test.ts', target: 'src/cli.ts' }]);
  expect(n.stats).toEqual({ files: 2, symbols: 1, imports: 3, tests: 1 });
  expect(n.version).toBe(CODE_MAP_VERSION);
  // A write without a version (an older worker) stores none, so the next start rebuilds it.
  expect(normalizeCodeMap({ files: [], symbols: [], imports: [], tests: [], churn: {}, fingerprint: null }).version).toBeNull();
});

test('mapIncomplete: a map from older map rules, or one that never counted its unresolved imports, is not complete', () => {
  const meta = (o: object) => ({ fingerprint: 'f', builtAt: 'x', stats: { files: 1, symbols: 0, imports: 0, tests: 0 }, candidates: null, unresolved: 0, version: CODE_MAP_VERSION, ...o });
  expect(mapIncomplete(meta({}))).toBe(false);
  expect(mapIncomplete(meta({ unresolved: null }))).toBe(true);
  expect(mapIncomplete(meta({ version: null }))).toBe(true);
  expect(mapIncomplete(meta({ version: CODE_MAP_VERSION - 1 }))).toBe(true);
  expect(mapIncomplete(null)).toBe(false);
});

test('outsideMap and impact: a file past the cap is in the import index, with its importers; impact starts from it', async () => {
  const outside = [{ ...mf('src/utils/logging.ts'), churn: null }, { ...mf('src/b.test.ts', true), churn: null }];
  const importers: Record<string, string[]> = { 'src/utils/logging.ts': ['src/a.ts', 'src/b.ts', 'src/b.test.ts'], 'src/a.ts': ['src/main.ts'] };
  const reads: CodeGraphReads = {
    ...fakeReads([{ path: 'src/a.ts', lang: 'typescript', commits: 0 }, { path: 'src/main.ts', lang: 'typescript', commits: 0 }]),
    outsideFiles: async (_k, paths) => outside.filter((f) => !paths || paths.includes(f.path)),
    importersOf: async (_k, paths) => new Map(paths.map((p) => [p, importers[p] ?? []])),
  };
  const v = codeGraphViews(reads);
  expect(await v.outsideMap('demo', ['src/utils/logging.ts', 'src/a.ts', 'src/nowhere.ts'])).toEqual([
    { path: 'src/utils/logging.ts', importers: ['src/a.ts', 'src/b.test.ts', 'src/b.ts'], tests: ['src/b.test.ts'] },
  ]);
  const i = await v.impact('demo', ['src/utils/logging.ts', 'src/nowhere.ts'], 2);
  expect(i.paths).toEqual(['src/utils/logging.ts']);
  expect(i.dependents.map((d) => d.path)).toEqual(['src/a.ts', 'src/b.test.ts', 'src/b.ts', 'src/main.ts']);
  expect(i.tests).toEqual(['src/b.test.ts']);
});

test('trailingToolCalls: the calls after the last human turn, which no turn takes in', () => {
  const call = (ts: string, command: string): ToolCall => ({ name: 'Bash', ts, command });
  const turn = (ts: string) => ({ uuid: ts, sessionId: 's', ts, index: 0, text: 'x', precedingAssistantText: '', precedingToolCalls: [] });
  const calls = [call('2026-10-25T10:01:00Z', 'pnpm test'), call('2026-10-25T10:03:00Z', 'git push')];
  expect(trailingToolCalls({ turns: [turn('2026-10-25T10:00:00Z'), turn('2026-10-25T10:02:00Z')], toolCalls: calls })).toEqual([calls[1]]);
  expect(trailingToolCalls({ turns: [], toolCalls: calls })).toEqual([]);
});

test('impact and moduleContext give the tests nearest the change first, not in path order (a capped list keeps the nearest)', async () => {
  // src/core.ts <- src/a.ts <- src/z.ts; src/b.test.ts imports core directly. TESTS edges: test/z.test.ts -> core,
  // test/a.test.ts -> a, test/aa.test.ts -> z.
  const files = ['src/core.ts', 'src/a.ts', 'src/z.ts', 'src/b.test.ts', 'test/z.test.ts', 'test/a.test.ts', 'test/aa.test.ts'];
  const importers: Record<string, string[]> = { 'src/core.ts': ['src/a.ts', 'src/b.test.ts'], 'src/a.ts': ['src/z.ts'] };
  const covering: Record<string, string[]> = { 'src/core.ts': ['test/z.test.ts'], 'src/a.ts': ['test/a.test.ts'], 'src/z.ts': ['test/aa.test.ts'] };
  const reads: CodeGraphReads = {
    ...fakeReads([]),
    mapFiles: async (_k, paths) => files.filter((p) => !paths || paths.includes(p)).map((p) => ({ ...mf(p, p.includes('.test.')), churn: null })),
    importersOf: async (_k, paths) => new Map(paths.map((p) => [p, importers[p] ?? []])),
    testsOf: async (_k, paths) => [...new Set(paths.flatMap((p) => covering[p] ?? []))],
  };
  const v = codeGraphViews(reads);
  const nearest = ['src/b.test.ts', 'test/z.test.ts', 'test/a.test.ts', 'test/aa.test.ts'];
  expect((await v.impact('demo', ['src/core.ts'], 3)).tests).toEqual(nearest);
  expect((await v.moduleContext('demo', 'src/core.ts'))!.tests).toEqual(nearest);
  // a test file asked about is its own nearest test
  expect((await v.impact('demo', ['test/aa.test.ts', 'src/z.ts'], 1)).tests).toEqual(['test/aa.test.ts']);
});
