import { expect, test } from 'vitest';
import { codeGraphViews, findInCodeMap, foldTerm, lessonsFor, normalizeCodeMap, pathMatches, repoRelative, sessionFiles, touchedAround, type CodeGraphReads, type MapFile } from './codegraph.ts';
import type { Lesson, ToolCall } from './types.ts';

const mf = (path: string, isTest = false): MapFile => ({ path, lang: 'typescript', hash: `h-${path}`, loc: 1, isTest });
const call = (name: string, filePath: string, ts: string): ToolCall => ({ name, filePath, ts }) as ToolCall;

test('repoRelative: the root itself, with or without its trailing slash, is not a file in it', () => {
  expect(repoRelative('/repo/', '/repo')).toBeNull();
  expect(repoRelative('/repo/src//a.ts', '/repo')).toBe('src/a.ts');
  expect(repoRelative('/repo/src/../../etc/passwd', '/repo')).toBeNull();
});

test('a session that ran with no folder of its own resolves its relative paths against the repo', () => {
  const files = sessionFiles({ cwd: '', toolCalls: [call('Read', 'src/a.ts', '2026-10-01T10:00:00Z')] }, '/repo');
  expect(files.map((f) => [f.path, f.read])).toEqual([['src/a.ts', true]]);
});

test('an edit with an unreadable time is an edit with no time: never before or after a piece of feedback', () => {
  const files = sessionFiles({ cwd: '/repo', toolCalls: [call('Edit', '/repo/src/a.ts', 'not a time')] }, '/repo');
  expect(files).toEqual([{ path: 'src/a.ts', read: false, edited: true, firstEditAt: null, lastEditAt: null }]);
  expect(touchedAround(files, '2026-10-01T10:00:00Z')).toEqual({ edited: ['src/a.ts'], fixed: [] });
});

test('`?` in a lesson path stands for one character within a folder', () => {
  expect(pathMatches('src/?.ts', 'src/a.ts')).toBe(true);
  expect(pathMatches('src/?.ts', 'src/ab.ts')).toBe(false);
  expect(pathMatches('src?a.ts', 'src/a.ts')).toBe(false);
});

test('many distinct lesson patterns still match as they should (the compiled-pattern cache stays bounded)', () => {
  for (let i = 0; i < 2100; i++) expect(pathMatches(`src/f${i}/*.ts`, `src/f${i}/a.ts`)).toBe(true);
  expect(pathMatches('src/f0/*.ts', 'src/f0/b/a.ts')).toBe(false);
});

test('a package import is kept by its name; one to a file the map does not hold is dropped', () => {
  const n = normalizeCodeMap({
    files: [mf('src/a.ts')], symbols: [], tests: [], churn: {}, fingerprint: null,
    imports: [{ from: 'src/a.ts', to: 'pkg:react', names: ['useState'], spec: 'react' }, { from: 'src/a.ts', to: 'src/gone.ts', names: [], spec: './gone' }],
  });
  expect(n.imports).toEqual([{ from: 'src/a.ts', to: 'pkg:react', names: ['useState'], spec: 'react' }]);
});

test('a lesson derived from a miss these files have none of is not about them', () => {
  const lesson = { id: 'lesson:1', projectKey: 'demo', paths: [], missId: 'miss:other', origin: null } as unknown as Lesson;
  expect(lessonsFor([lesson], ['src/a.ts'], [])).toEqual([]);
});

test('folded plurals: caches is cache, niches is niche', () => {
  expect(foldTerm('caches')).toBe('cache');
  expect(foldTerm('Niches')).toBe('niche');
});

test('a file the question names exactly lists all its matching symbols, past the per-file cap', () => {
  const symbols = ['alpha', 'beta', 'gamma', 'delta', 'omega'].map((name, i) => ({ id: `src/big.ts#${name}`, path: 'src/big.ts', name, kind: 'function' as const, exported: true, lines: `${i}-${i}` }));
  const map = { files: [mf('src/big.ts'), mf('src/other.ts')], symbols: [...symbols, { ...symbols[0], id: 'src/other.ts#alpha', path: 'src/other.ts' }], imports: [] };
  expect(findInCodeMap(map, [], { paths: ['src/big.ts'] }).map((h) => h.name)).toEqual(['alpha', 'beta', 'delta', 'gamma', 'omega']);
  // Not named: at most three from one file.
  expect(findInCodeMap(map, ['alpha', 'beta', 'gamma', 'delta', 'omega']).filter((h) => h.path === 'src/big.ts')).toHaveLength(3);
});

function reads(o: Partial<CodeGraphReads> = {}): CodeGraphReads {
  const none = async () => [];
  return {
    mapFiles: async (_k, paths) => [mf('src/a.ts'), mf('src/b.ts'), mf('src/c.ts')].filter((f) => !paths || paths.includes(f.path)).map((f) => ({ ...f, churn: null })),
    outsideFiles: none,
    symbolsOf: none,
    importsOf: none,
    importersOf: async (_k, paths) => new Map(paths.map((p) => [p, []])),
    testsOf: none,
    importerCounts: async () => new Map(),
    missesOn: none,
    edgesTouching: async () => ({ imports: [{ from: 'src/a.ts', to: 'src/b.ts' }, { from: 'src/c.ts', to: 'src/a.ts' }], tests: [{ test: 'src/a.ts', target: 'src/c.ts' }] }),
    approvedLessons: none,
    currentFacts: none,
    ...o,
  };
}

test('views of what the map does not hold are empty: an unmapped module, an unmapped change, nothing past the cap, no paths', async () => {
  const v = codeGraphViews(reads());
  expect(await v.moduleContext('demo', 'src/zzz.ts')).toBeNull();
  expect(await v.impact('demo', ['src/zzz.ts'], 2)).toEqual({ paths: [], dependents: [], tests: [], misses: [], lessons: [] });
  expect(await v.lessonsForPaths('demo', [])).toEqual([]);
});

test('the map graph: edges among its top files bring in no neighbours, and a graph of no files asks for no edges', async () => {
  const v = codeGraphViews(reads());
  const g = await v.mapGraph('demo', { limit: 3 });
  expect(g.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  expect(g.cap.neighborsFound).toBe(0);
  const asked: string[][] = [];
  const empty = await codeGraphViews(reads({ edgesTouching: async (_k, paths) => { asked.push(paths); return { imports: [], tests: [] }; } })).mapGraph('demo', { limit: 0 });
  expect(empty.files).toEqual([]);
  expect(asked).toEqual([]);
});

test('a lesson learned from a miss is about the files that miss touched, whatever its own paths say', () => {
  const lesson = { id: 'lesson:1', projectKey: 'demo', paths: [], missId: 'miss:1', origin: null } as unknown as Lesson;
  const miss = { missId: 'miss:1', paths: ['src/b.ts', 'src/a.ts'] } as never;
  expect(lessonsFor([lesson], ['src/a.ts'], [miss])).toEqual([{ lesson, paths: ['src/a.ts', 'src/b.ts'] }]);
});

test('the map graph brings in the files its top files import, are imported by and are tested with, as neighbours', async () => {
  const g = await codeGraphViews(reads()).mapGraph('demo', { limit: 1 });
  expect(g.files.map((f) => [f.path, f.top])).toEqual([['src/a.ts', true], ['src/b.ts', false]]);
  expect(g.cap).toMatchObject({ neighbors: 1, neighborsFound: 2 });
});
