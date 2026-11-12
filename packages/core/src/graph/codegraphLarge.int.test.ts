import { expect, test } from 'vitest';
import type { CodeMapWrite } from '../codegraph.ts';
import { describeStores } from '../testing/index.ts';

/**
 * The production-sized regressions for the transaction-memory failures seen on large repositories. These deliberately
 * run only on Neo4j: 700 test files × 300 source files is 210,000 TESTS relationships, and a monorepo's map (a
 * large one failed under --small in 0.7.5) has thousands of files and tens of thousands of symbols and imports.
 * replaceCodeMap must finish through bounded transactions and publish the fingerprint only at the end. The project
 * already holds the map when it is replaced, so marking and removing the old edges and symbols (the work that ran as
 * one transaction before 0.7.5) runs at full size. The test databases (docker-compose.test.yml, CI) set the small
 * profile's transaction-memory limits (docker-compose.small.yml, 32 MiB each); without them nothing would fail.
 */
describeStores('large code map transaction budget', (h) => {
  test('rebuilds a map holding 210k TESTS edges within the small profile\'s 32 MiB per transaction', async () => {
    const tests = Array.from({ length: 700 }, (_, i) => `test/t${i}.test.ts`);
    const targets = Array.from({ length: 300 }, (_, i) => `src/m${i}.ts`);
    const paths = [...targets, ...tests];
    const map = (fingerprint: string, covered: string[]): CodeMapWrite => ({
      files: paths.map(path => ({ path, lang: 'typescript', hash: `h-${path}`, loc: 10, isTest: path.startsWith('test/') })),
      symbols: [], imports: [],
      tests: tests.flatMap(testPath => covered.map(target => ({ test: testPath, target }))),
      churn: {}, fingerprint,
    });
    expect(await h.store.codegraph.replaceCodeMap('large-map', map('large-map-210k', targets))).toEqual({ files: 1000, symbols: 0, imports: 0, tests: 210_000 });
    // The rebuild of a project that has the map: all 210k old edges are marked, half revived and half removed.
    expect(await h.store.codegraph.replaceCodeMap('large-map', map('large-map-105k', targets.slice(0, 150)))).toEqual({ files: 1000, symbols: 0, imports: 0, tests: 105_000 });
    expect(await h.store.codegraph.codeMapMeta('large-map')).toMatchObject({ fingerprint: 'large-map-105k', stats: { tests: 105_000 } });
  }, 480_000);

  test('builds and rebuilds a monorepo-sized map (8,000 files, 30k symbols, 56k imports) within the small profile\'s 32 MiB per transaction', async () => {
    // Paths as deep as a monorepo's: the transaction memory a row takes grows with them.
    const dir = (i: number) => `src/portal/main/src/segments/area-${i % 40}/components/section-${i % 7}`;
    const mapped = Array.from({ length: 3000 }, (_, i) => `${dir(i)}/module-file-${i}.ts`);
    const outside = Array.from({ length: 5000 }, (_, i) => `${dir(i)}/index-only-file-${i}.ts`);
    const all = [...mapped, ...outside];
    const file = (path: string): CodeMapWrite['files'][number] => ({ path, lang: 'typescript', hash: `h-${path}`, loc: 120, isTest: path.includes('-file-1') });
    const map = (fingerprint: string, generation: number): CodeMapWrite => ({
      files: mapped.map(file), outside: outside.map(file),
      symbols: mapped.flatMap((path) => Array.from({ length: 10 }, (_, k) => ({ id: `${path}#handleRequestNumber${k}`, path, name: `handleRequestNumber${k}`, kind: 'function' as const, exported: true, lines: `${k * 10 + generation}-${k * 10 + 8 + generation}` }))),
      imports: all.flatMap((from, i) => Array.from({ length: 7 }, (_, k) => ({ from, to: all[(i * 7 + k * 131 + 1) % all.length], names: [`useThing${k}`, `ThingProps${generation}`], spec: `../section-${k}/thing` }))),
      tests: mapped.slice(0, 400).flatMap((test, i) => Array.from({ length: 100 }, (_, k) => ({ test, target: mapped[(i + k * 29 + 1) % mapped.length] }))),
      churn: {}, fingerprint,
    });
    const first = map('monorepo-sized-1', 0);
    const built = await h.store.codegraph.replaceCodeMap('monorepo-sized', first);
    expect(built).toMatchObject({ files: 3000, symbols: 30_000 });
    // Every file's symbols and import names changed: all of them are deleted and written again.
    expect(await h.store.codegraph.replaceCodeMap('monorepo-sized', map('monorepo-sized-2', 1))).toEqual(built);
    expect(await h.store.codegraph.codeMapMeta('monorepo-sized')).toMatchObject({ fingerprint: 'monorepo-sized-2' });
  }, 480_000);
}, { only: ['neo4j'] });
