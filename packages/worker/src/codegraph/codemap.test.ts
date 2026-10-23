import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { buildCodeMap } from './codemap.ts';
import { dependents, testsFor } from './queries.ts';
import type { CodeMap } from './types.ts';

const OPTS = { maxFiles: 5000, maxBytes: 200_000 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(git: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'fbcodemap-'));
  const outside = mkdtempSync(join(tmpdir(), 'fbcodemap-outside-'));
  dirs.push(dir, outside);
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  // TS workspace with a path alias
  w('package.json', JSON.stringify({ name: 'root', private: true }));
  w('tsconfig.json', '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["packages/app/src/*"] } },\n}\n');
  w('packages/core/package.json', JSON.stringify({ name: '@demo/core', exports: { '.': './src/index.ts' } }));
  w('packages/core/src/index.ts', "export * from './repo.js';\n");
  w('packages/core/src/repo.ts', 'export class Repo {\n  save() {}\n}\nexport function load() {\n  const local = 1;\n  return local;\n}\n');
  w('packages/app/src/main.ts', "import { Repo } from '@demo/core';\nimport { helper } from '@app/util';\nimport { z } from 'zod';\nexport const main = () => new Repo();\n");
  w('packages/app/src/util.ts', 'export const helper = () => 1;\n');
  w('packages/app/src/__tests__/main.test.ts', "import { helper } from '../util';\n");
  w('packages/app/tests/nested/deep/integration.ts', "import { main } from '../../../src/main.ts';\n");
  w('scripts/legacy.cjs', "const { helper } = require('../packages/app/src/util');\nmodule.exports = { helper };\n");
  // Python package (src layout) with tests
  w('py/pyproject.toml', '[project]\nname = "shop"\n');
  w('py/src/shop/__init__.py', '');
  w('py/src/shop/cart.py', 'from .pricing import price\n\nclass Cart:\n    def total(self):\n        return price(1)\n');
  w('py/src/shop/pricing.py', 'def price(n):\n    return n\n');
  w('py/tests/test_cart.py', 'from shop.cart import Cart\n\ndef test_total():\n    assert Cart().total() == 1\n');
  // secret files: never listed, never parsed
  w('.env', 'TOKEN=abc123456789');
  w('packages/app/src/secrets.ts', 'export const leaked = 1;\n');
  // symlinks: to a file inside, to a file outside, to a directory outside
  writeFileSync(join(outside, 'outside.ts'), 'export const outsideSymbol = 1;\n');
  symlinkSync(join(dir, 'packages/core/src/repo.ts'), join(dir, 'packages/app/src/alias.ts'));
  symlinkSync(join(outside, 'outside.ts'), join(dir, 'packages/app/src/outside.ts'));
  symlinkSync(outside, join(dir, 'linked'));
  if (git) execFileSync('git', ['-C', dir, 'init', '-q']);
  return dir;
}

const paths = (m: CodeMap) => m.files.map((f) => f.path);
const edge = (m: CodeMap, from: string, to: string) => m.imports.find((i) => i.from === from && i.to === to);

for (const git of [true, false]) {
  test(`buildCodeMap maps files, symbols and resolved imports (${git ? 'git' : 'plain dir'})`, async () => {
    const dir = fixture(git);
    const m = await buildCodeMap(dir, OPTS);

    expect(paths(m)).toEqual([
      'package.json', 'packages/app/src/__tests__/main.test.ts', 'packages/app/src/main.ts', 'packages/app/src/util.ts',
      'packages/app/tests/nested/deep/integration.ts', 'packages/core/package.json', 'packages/core/src/index.ts', 'packages/core/src/repo.ts',
      'py/pyproject.toml', 'py/src/shop/__init__.py', 'py/src/shop/cart.py', 'py/src/shop/pricing.py', 'py/tests/test_cart.py',
      'scripts/legacy.cjs', 'tsconfig.json',
    ]);
    const repo = m.files.find((f) => f.path === 'packages/core/src/repo.ts')!;
    expect(repo).toEqual({
      path: 'packages/core/src/repo.ts', lang: 'typescript', loc: 7, isTest: false,
      hash: createHash('sha256').update(readFileSync(join(dir, 'packages/core/src/repo.ts'))).digest('hex'),
    });
    expect(m.files.filter((f) => f.isTest).map((f) => f.path)).toEqual([
      'packages/app/src/__tests__/main.test.ts', 'packages/app/tests/nested/deep/integration.ts', 'py/tests/test_cart.py',
    ]);
    expect(m.files.find((f) => f.path === 'py/src/shop/cart.py')?.lang).toBe('python');
    expect(m.files.find((f) => f.path === 'tsconfig.json')?.lang).toBe('json');

    expect(m.symbols.filter((s) => s.path === 'packages/core/src/repo.ts')).toEqual([
      { id: 'packages/core/src/repo.ts#Repo', path: 'packages/core/src/repo.ts', name: 'Repo', kind: 'class', exported: true, lines: '1-3' },
      { id: 'packages/core/src/repo.ts#load', path: 'packages/core/src/repo.ts', name: 'load', kind: 'function', exported: true, lines: '4-7' },
      { id: 'packages/core/src/repo.ts#Repo.save', path: 'packages/core/src/repo.ts', name: 'Repo.save', kind: 'method', exported: true, lines: '2-2' },
    ]);
    expect(m.symbols.find((s) => s.id === 'py/src/shop/cart.py#Cart.total')).toMatchObject({ kind: 'method', exported: true });
    expect(m.symbols.some((s) => s.name === 'local' || s.name === 'leaked' || s.name === 'outsideSymbol')).toBe(false);

    expect(edge(m, 'packages/app/src/main.ts', 'packages/core/src/index.ts')).toEqual({ from: 'packages/app/src/main.ts', to: 'packages/core/src/index.ts', names: ['Repo'], spec: '@demo/core' });
    expect(edge(m, 'packages/app/src/main.ts', 'packages/app/src/util.ts')?.names).toEqual(['helper']);
    expect(edge(m, 'packages/app/src/main.ts', 'pkg:zod')).toBeTruthy();
    expect(edge(m, 'packages/core/src/index.ts', 'packages/core/src/repo.ts')?.names).toEqual(['*']);
    expect(edge(m, 'scripts/legacy.cjs', 'packages/app/src/util.ts')).toBeTruthy();
    expect(edge(m, 'py/src/shop/cart.py', 'py/src/shop/pricing.py')?.names).toEqual(['price']);
    expect(edge(m, 'py/tests/test_cart.py', 'py/src/shop/cart.py')?.names).toEqual(['Cart']);
    expect(m.imports.every((i) => paths(m).includes(i.to) || i.to.startsWith('pkg:'))).toBe(true);

    expect(testsFor(m, 'packages/app/src/util.ts')).toEqual(['packages/app/src/__tests__/main.test.ts', 'packages/app/tests/nested/deep/integration.ts']);
    expect(testsFor(m, 'packages/app/src/main.ts')).toEqual(['packages/app/tests/nested/deep/integration.ts']);
    expect(testsFor(m, 'py/src/shop/pricing.py')).toEqual(['py/tests/test_cart.py']);
    expect(dependents(m, 'packages/core/src/repo.ts', 3).map((d) => d.path)).toEqual([
      'packages/core/src/index.ts', 'packages/app/src/main.ts', 'packages/app/tests/nested/deep/integration.ts',
    ]);
  });
}

test('maxFiles and maxBytes bound the map', async () => {
  const dir = fixture(true);
  writeFileSync(join(dir, 'packages/app/src/huge.ts'), `export const big = '${'x'.repeat(5000)}';\n`);
  const m = await buildCodeMap(dir, { maxFiles: 3, maxBytes: 4000 });
  expect(m.files).toHaveLength(3);
  expect(paths(m)).not.toContain('packages/app/src/huge.ts');
});

test('incremental: unchanged files reuse the previous entries without reparsing; changes, additions and deletions are picked up', async () => {
  const dir = fixture(true);
  const first = await buildCodeMap(dir, OPTS);

  // Tamper with the previous map for an unchanged file: if it were reparsed, the marker would disappear.
  const prev: CodeMap = {
    ...first,
    symbols: first.symbols.map((s) => (s.id === 'packages/core/src/repo.ts#load' ? { ...s, lines: 'FROM-PREV' } : s)),
  };
  writeFileSync(join(dir, 'packages/app/src/util.ts'), "export const helper = () => 2;\nexport function extra() {}\nimport './fresh';\n");
  const second = await buildCodeMap(dir, OPTS, prev);
  expect(second.symbols.find((s) => s.id === 'packages/core/src/repo.ts#load')?.lines).toBe('FROM-PREV');
  expect(second.symbols.find((s) => s.id === 'packages/app/src/util.ts#extra')).toBeTruthy();
  expect(second.files.find((f) => f.path === 'packages/app/src/util.ts')?.hash).not.toBe(first.files.find((f) => f.path === 'packages/app/src/util.ts')?.hash);
  expect(edge(second, 'packages/app/src/util.ts', 'packages/app/src/fresh.ts')).toBeUndefined();

  // A new file makes an unchanged importer's dangling import resolve; a deleted file drops the edges to it.
  writeFileSync(join(dir, 'packages/app/src/fresh.ts'), 'export {};\n');
  unlinkSync(join(dir, 'packages/core/src/repo.ts'));
  const third = await buildCodeMap(dir, OPTS, second);
  expect(edge(third, 'packages/app/src/util.ts', 'packages/app/src/fresh.ts')).toBeTruthy();
  expect(third.imports.some((i) => i.to === 'packages/core/src/repo.ts')).toBe(false);
  expect(third.symbols.some((s) => s.path === 'packages/core/src/repo.ts')).toBe(false);

  // A previous map without raw specifiers (an older format) is reparsed rather than trusted.
  const stripped: CodeMap = { ...third, imports: third.imports.map(({ spec: _s, ...rest }) => rest as CodeMap['imports'][number]) };
  const fourth = await buildCodeMap(dir, OPTS, stripped);
  expect(fourth.imports).toEqual(third.imports);
});

test('smoke: maps this repo\'s packages/core with sane counts, and graph/repo.ts has importers', async () => {
  const core = resolve(dirname(fileURLToPath(import.meta.url)), '../../../core');
  const t0 = Date.now();
  const m = await buildCodeMap(core, OPTS);
  const ms = Date.now() - t0;
  expect(m.files.length).toBeGreaterThan(30);
  expect(m.files.length).toBeLessThan(500);
  expect(m.symbols.length).toBeGreaterThan(100);
  expect(m.imports.length).toBeGreaterThan(30);
  expect(m.files.every((f) => !f.path.startsWith('node_modules/'))).toBe(true);
  expect(m.imports.filter((i) => i.to === 'src/graph/repo.ts').length).toBeGreaterThan(1);
  expect(edge(m, 'src/index.ts', 'src/graph/repo.ts')).toBeTruthy();
  expect(m.imports.some((i) => i.to === 'pkg:neo4j-driver')).toBe(true);
  expect(m.symbols.find((s) => s.id === 'src/graph/repo.ts#GraphRepo')).toMatchObject({ kind: 'class', exported: true });
  expect(testsFor(m, 'src/graph/repo.ts').length).toBeGreaterThan(0);
  expect(ms).toBeLessThan(20_000);
});
