import { expect, test } from 'vitest';
import { dependents, testsFor } from './queries.ts';
import type { CodeMap } from './types.ts';

const file = (path: string, isTest = false) => ({ path, lang: 'typescript', hash: path, loc: 1, isTest });
const imp = (from: string, to: string) => ({ from, to, names: [], spec: to });

// core <- service <- api <- main ; core <- util ; tests: core.test -> core, api.test -> api, svc.test -> service -> core
const map: CodeMap = {
  files: ['core.ts', 'service.ts', 'api.ts', 'main.ts', 'util.ts', 'core.test.ts', 'api.test.ts', 'svc.test.ts', 'lonely.test.ts'].map((p) => file(p, p.includes('.test.'))),
  symbols: [],
  imports: [
    imp('service.ts', 'core.ts'), imp('api.ts', 'service.ts'), imp('main.ts', 'api.ts'), imp('util.ts', 'core.ts'),
    imp('core.test.ts', 'core.ts'), imp('api.test.ts', 'api.ts'), imp('svc.test.ts', 'service.ts'),
    imp('core.ts', 'pkg:zod'), imp('lonely.test.ts', 'pkg:vitest'),
    // a cycle must not loop
    imp('core.ts', 'util.ts'),
  ],
};

test('dependents walks the reverse import graph up to the given depth, nearest first', () => {
  expect(dependents(map, 'core.ts', 1)).toEqual([
    { path: 'core.test.ts', depth: 1 }, { path: 'service.ts', depth: 1 }, { path: 'util.ts', depth: 1 },
  ]);
  expect(dependents(map, 'core.ts', 3)).toEqual([
    { path: 'core.test.ts', depth: 1 }, { path: 'service.ts', depth: 1 }, { path: 'util.ts', depth: 1 },
    { path: 'api.ts', depth: 2 }, { path: 'svc.test.ts', depth: 2 },
    { path: 'api.test.ts', depth: 3 }, { path: 'main.ts', depth: 3 },
  ]);
  expect(dependents(map, 'main.ts', 5)).toEqual([]);
  expect(dependents(map, 'missing.ts', 2)).toEqual([]);
  expect(dependents(map, 'core.ts', 0)).toEqual([]);
});

test('dependents of an external package lists its direct importers', () => {
  expect(dependents(map, 'pkg:zod', 1)).toEqual([{ path: 'core.ts', depth: 1 }]);
});

test('testsFor finds test files that import a module directly or through one hop', () => {
  expect(testsFor(map, 'core.ts')).toEqual(['core.test.ts', 'svc.test.ts']);
  expect(testsFor(map, 'service.ts')).toEqual(['api.test.ts', 'svc.test.ts']);
  expect(testsFor(map, 'api.ts')).toEqual(['api.test.ts']);
  expect(testsFor(map, 'main.ts')).toEqual([]);
});

test('a test file is not its own test', () => {
  const m: CodeMap = { files: [file('a.ts'), file('a.test.ts', true), file('h.test.ts', true)], symbols: [], imports: [imp('a.test.ts', 'h.test.ts'), imp('h.test.ts', 'a.ts')] };
  expect(testsFor(m, 'h.test.ts')).toEqual(['a.test.ts']);
  expect(testsFor(m, 'a.ts')).toEqual(['a.test.ts', 'h.test.ts']);
});
