import { expect, test } from 'vitest';
import { testStores } from './index.ts';

test('TEST_STORES picks the backends the contract suites run on; neo4j by default', () => {
  expect(testStores({})).toEqual(['neo4j']);
  expect(testStores({ TEST_STORES: 'postgres' })).toEqual(['postgres']);
  expect(testStores({ TEST_STORES: ' neo4j , postgres,neo4j ' })).toEqual(['neo4j', 'postgres']);
  expect(() => testStores({ TEST_STORES: 'neo4j,mysql' })).toThrow(/unknown store "mysql"/);
});
