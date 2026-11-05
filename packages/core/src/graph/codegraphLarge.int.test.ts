import { expect, test } from 'vitest';
import type { CodeMapWrite } from '../codegraph.ts';
import { describeStores } from '../testing/index.ts';

/**
 * The production-sized regression for the transaction-memory failure seen on large repositories. This deliberately
 * runs only on Neo4j: 700 test files × 300 source files is 210,000 TESTS relationships, under the stock Compose memory
 * profile. replaceCodeMap must finish through bounded transactions and publish the fingerprint only at the end.
 */
describeStores('large code map transaction budget', (h) => {
  test('replaces 210k TESTS edges without exceeding the default Neo4j transaction budget', async () => {
    const tests = Array.from({ length: 700 }, (_, i) => `test/t${i}.test.ts`);
    const targets = Array.from({ length: 300 }, (_, i) => `src/m${i}.ts`);
    const paths = [...targets, ...tests];
    const map: CodeMapWrite = {
      files: paths.map(path => ({ path, lang: 'typescript', hash: `h-${path}`, loc: 10, isTest: path.startsWith('test/') })),
      symbols: [], imports: [],
      tests: tests.flatMap(testPath => targets.map(target => ({ test: testPath, target }))),
      churn: {}, fingerprint: 'large-map-210k',
    };
    expect(await h.store.codegraph.replaceCodeMap('large-map', map)).toEqual({ files: 1000, symbols: 0, imports: 0, tests: 210_000 });
    expect(await h.store.codegraph.codeMapMeta('large-map')).toMatchObject({ fingerprint: 'large-map-210k', stats: { tests: 210_000 } });
  }, 240_000);
}, { only: ['neo4j'] });
