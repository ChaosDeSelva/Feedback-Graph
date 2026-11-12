import { expect, test } from 'vitest';
import { codeGraphViews, groupMisses, mapCapped, MIN_MAP_FILES, normalizeCodeMap, type CodeGraphReads, type FileMissRow } from './codegraph.ts';

const meta = (files: number, candidates: number | null) => ({ stats: { files, symbols: 0, imports: 0, tests: 0 }, candidates });

test('mapCapped: a counted map is capped when files worth mapping were left out', () => {
  expect(mapCapped(null)).toBeNull();
  expect(mapCapped(undefined)).toBeNull();
  expect(mapCapped(meta(400, 1200))).toEqual({ files: 400, of: 1200 });
  expect(mapCapped(meta(400, 400))).toBeNull();
  // the count wins over the cap guess
  expect(mapCapped(meta(5000, 5000), 10)).toBeNull();
});

test('mapCapped: a map from before files were counted is called capped when it is as full as the cap allows', () => {
  expect(mapCapped(meta(MIN_MAP_FILES, null))).toEqual({ files: MIN_MAP_FILES, of: null });
  expect(mapCapped(meta(MIN_MAP_FILES - 1, null))).toBeNull();
  expect(mapCapped(meta(50, null), 50)).toEqual({ files: 50, of: null });
  expect(mapCapped(meta(49, null), 50)).toBeNull();
  expect(mapCapped(meta(0, null), 0)).toBeNull();
});

const row = (missId: string, path: string, ts: string, fixedHere = false): FileMissRow => ({
  missId, path, ts, fixedHere, missed: 'x', cause: 'implementation_error', causeExplanation: '', feedbackId: 'f', feedbackText: '', sessionId: 's', lessonId: null,
});

test('groupMisses: one miss per id with its paths sorted and deduplicated, fixed here when any row was, by time then id', () => {
  const out = groupMisses([
    row('m2', 'src/b.ts', '2026-10-02'), row('m1', 'src/z.ts', '2026-10-01'), row('m2', 'src/a.ts', '2026-10-02', true),
    row('m2', 'src/b.ts', '2026-10-02'), row('m0', 'src/c.ts', '2026-10-02'),
  ]);
  expect(out.map((m) => [m.missId, m.paths, m.fixedHere])).toEqual([
    ['m1', ['src/z.ts'], false], ['m0', ['src/c.ts'], false], ['m2', ['src/a.ts', 'src/b.ts'], true],
  ]);
});

test('normalizeCodeMap merges duplicate import edges into one with every name; counts are whole and never negative', () => {
  const file = (path: string) => ({ path, lang: 'typescript', hash: 'h', loc: 1, isTest: false });
  const n = normalizeCodeMap({
    files: [file('a.ts'), file('b.ts')], symbols: [], tests: [], churn: {}, fingerprint: null,
    imports: [
      { from: 'a.ts', to: 'b.ts', names: ['x'], spec: './b' },
      { from: 'a.ts', to: 'b.ts', names: ['y', 'x'], spec: './b.js' },
    ],
    candidates: 0.5, unresolved: -3, version: 1.5,
  });
  expect(n.imports).toEqual([{ from: 'a.ts', to: 'b.ts', names: ['x', 'y'], spec: './b' }]);
  // at least the files mapped; unresolved floored at 0; a fractional version is no version
  expect([n.candidates, n.unresolved, n.version]).toEqual([2, 0, null]);
  expect(normalizeCodeMap({ files: [], symbols: [], imports: [], tests: [], churn: {}, fingerprint: null, candidates: Number.NaN, unresolved: null }).candidates).toBeNull();
});

test('exportFiles gives every mapped file, tests included, with its hotspot numbers, in path order', async () => {
  const files = [
    { path: 'src/a.ts', lang: 'typescript', hash: 'h', loc: 10, isTest: false, churn: { commits: 3, lastTs: 'd' } },
    { path: 'src/a.test.ts', lang: 'typescript', hash: 'h', loc: 5, isTest: true, churn: null },
    { path: 'README.md', lang: 'md', hash: 'h', loc: 2, isTest: false, churn: { commits: 9, lastTs: 'd' } },
  ].sort((x, y) => (x.path < y.path ? -1 : 1));
  const none = async () => [];
  const reads: CodeGraphReads = {
    mapFiles: async () => files, outsideFiles: none, symbolsOf: none, importsOf: none, importersOf: async () => new Map(), testsOf: none,
    importerCounts: async () => new Map([['src/a.ts', 2]]),
    missesOn: async () => [row('m1', 'src/a.ts', 'd')], edgesTouching: async () => ({ imports: [], tests: [] }), approvedLessons: none, currentFacts: none,
  };
  const out = await codeGraphViews(reads).exportFiles('shop');
  expect(out.map((f) => f.path)).toEqual(['README.md', 'src/a.test.ts', 'src/a.ts']);
  expect(out[2]).toMatchObject({ projectKey: 'shop', path: 'src/a.ts', lang: 'typescript', loc: 10, isTest: false, churn: 3, misses: 1, dependents: 2 });
  expect(out[2].score).toBeGreaterThan(4);
  expect(out[1]).toMatchObject({ isTest: true, churn: 0, misses: 0, dependents: 0 });
  // docs rank only once a miss touches them
  expect(out[0]).toMatchObject({ churn: 9, score: 0 });
});
