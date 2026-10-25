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

test('a Godot project: .gd symbols, and preload/load/extends paths and class_name references become edges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbcodemap-godot-'));
  dirs.push(dir);
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('game/project.godot', '[application]\nconfig/name="Demo"\n');
  w('game/actors/actor.gd', 'class_name Actor\nextends CharacterBody2D\n\nvar hp := 3\n');
  w('game/actors/player.gd', 'class_name Player\nextends Actor\n\nconst Bullet = preload("res://weapons/bullet.gd")\n\nfunc shoot():\n\tvar b = Bullet.new()\n');
  w('game/weapons/bullet.gd', 'extends "res://actors/actor.gd"\n\nfunc _process(delta):\n\tpass\n');
  w('game/main.gd', 'extends Node2D\n\nfunc _ready():\n\tvar p: Player = load("actors/player.gd").new()\n');
  w('game/test/test_player.gd', 'extends GutTest\n\nfunc test_shoot():\n\tPlayer.new().shoot()\n');
  execFileSync('git', ['-C', dir, 'init', '-q']);

  const m = await buildCodeMap(dir, OPTS);
  expect(paths(m)).toEqual(['game/actors/actor.gd', 'game/actors/player.gd', 'game/main.gd', 'game/project.godot', 'game/test/test_player.gd', 'game/weapons/bullet.gd']);
  expect(m.files.find((f) => f.path === 'game/test/test_player.gd')?.isTest).toBe(true);
  expect(m.symbols.filter((s) => s.path === 'game/actors/player.gd').map((s) => [s.name, s.kind, s.exported])).toEqual([
    ['Player', 'class', true], ['Bullet', 'const', true], ['shoot', 'function', true],
  ]);
  const targets = (from: string) => m.imports.filter((i) => i.from === from).map((i) => i.to).sort();
  expect(targets('game/actors/player.gd')).toEqual(['game/actors/actor.gd', 'game/weapons/bullet.gd']);
  expect(targets('game/weapons/bullet.gd')).toEqual(['game/actors/actor.gd']);
  expect(targets('game/main.gd')).toEqual(['game/actors/player.gd']);
  expect(targets('game/actors/actor.gd')).toEqual([]); // CharacterBody2D is the engine's
  expect(edge(m, 'game/main.gd', 'game/actors/player.gd')!.names.sort()).toEqual(['*', 'Player']);
  expect(testsFor(m, 'game/actors/player.gd')).toEqual(['game/test/test_player.gd']);
  expect(testsFor(m, 'game/weapons/bullet.gd')).toEqual(['game/test/test_player.gd']); // through player.gd

  // A class_name that appears later is picked up by an unchanged file that already referred to it.
  w('game/ui/hud.gd', 'extends Control\n\nfunc show_hp():\n\tScore.add(1)\n');
  const second = await buildCodeMap(dir, OPTS, m);
  w('game/ui/score.gd', 'class_name Score\n');
  const third = await buildCodeMap(dir, OPTS, second);
  expect(edge(third, 'game/ui/hud.gd', 'game/ui/score.gd')).toBeTruthy();
});

test('a Swift package: an import of a local module links to that module\'s files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbcodemap-swift-'));
  dirs.push(dir);
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('Package.swift', 'let package = Package(name: "App", targets: [\n  .executableTarget(name: "App", dependencies: ["Core"]),\n  .target(name: "Core"),\n  .testTarget(name: "CoreTests", dependencies: ["Core"]),\n])\n');
  w('Sources/App/main.swift', 'import Foundation\nimport Core\n\nlet s = Store()\n');
  w('Sources/Core/Store.swift', 'public struct Store {}\n');
  w('Sources/Core/Model.swift', 'public struct Model {}\n');
  w('Tests/CoreTests/StoreTests.swift', 'import XCTest\n@testable import Core\n\nfinal class StoreTests: XCTestCase {}\n');
  const m = await buildCodeMap(dir, OPTS);
  const targets = (from: string) => m.imports.filter((i) => i.from === from).map((i) => i.to).sort();
  expect(targets('Sources/App/main.swift')).toEqual(['Sources/Core/Model.swift', 'Sources/Core/Store.swift', 'pkg:Foundation']);
  expect(targets('Tests/CoreTests/StoreTests.swift')).toEqual(['Sources/Core/Model.swift', 'Sources/Core/Store.swift', 'pkg:XCTest']);
  expect(testsFor(m, 'Sources/Core/Store.swift')).toEqual(['Tests/CoreTests/StoreTests.swift']);
});

test('maxFiles and maxBytes bound the map', async () => {
  const dir = fixture(true);
  writeFileSync(join(dir, 'packages/app/src/huge.ts'), `export const big = '${'x'.repeat(5000)}';\n`);
  const m = await buildCodeMap(dir, { maxFiles: 3, maxBytes: 4000 });
  expect(m.files).toHaveLength(3);
  expect(paths(m)).not.toContain('packages/app/src/huge.ts');
  // The cap is counted, so the map can say what it left out.
  expect(m.candidates).toBe((await buildCodeMap(dir, OPTS)).candidates);
  expect(m.candidates).toBeGreaterThan(3);
});

test('a capped map keeps source and the files sessions edited, not the alphabetically first config', async () => {
  const dir = fixture(true);
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, `a${i}.yaml`), 'x: 1\n');
  const m = await buildCodeMap(dir, { maxFiles: 6, maxBytes: 200_000, priority: ['a3.yaml'] });
  expect(paths(m)).toContain('a3.yaml');
  expect(paths(m).filter((p) => p.endsWith('.yaml'))).toEqual(['a3.yaml']);
  expect(paths(m).some((p) => p.endsWith('.ts'))).toBe(true);
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

test('the map counts imports that look local but resolve to no file, so answers can say the import graph is incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbcodemap-'));
  dirs.push(dir);
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('package.json', JSON.stringify({ name: 'shop', dependencies: { zod: '3' } }));
  w('tsconfig.json', '{ "compilerOptions": { "paths": { "@app/*": ["src/*"] } } }');
  w('src/a.ts', "import { b } from '@app/b';\nimport { gone } from '@app/gone';\nimport { x } from '@shared-ui/lib';\nimport { z } from 'zod';\nexport const a = 1;\n");
  w('src/b.ts', "import { gone } from '@app/gone';\nexport const b = 1;\n");
  const m = await buildCodeMap(dir, OPTS);
  expect(edge(m, 'src/a.ts', 'src/b.ts')).toBeTruthy();
  expect(m.unresolved).toBe(3);
  const clean = mkdtempSync(join(tmpdir(), 'fbcodemap-'));
  dirs.push(clean);
  writeFileSync(join(clean, 'a.ts'), "import { z } from 'zod';\n");
  expect((await buildCodeMap(clean, OPTS)).unresolved).toBe(0);
});

test('an aborted signal stops the build: it rejects instead of returning a partial map', async () => {
  const dir = fixture(false);
  const ac = new AbortController();
  ac.abort(new Error('the worker is shutting down'));
  await expect(buildCodeMap(dir, { ...OPTS, signal: ac.signal })).rejects.toThrow('shutting down');
});

/** A repo as path -> content, in a temp dir. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'fbcodemap-'));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

test('a capped map keeps the import index for every candidate: importers past the cap count, and the most imported files are mapped', async () => {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'shop', dependencies: { zod: '3' } }) };
  // Ten callers sort before the file they all import: path order would cap it away.
  for (let i = 0; i < 10; i++) files[`src/a${i}.ts`] = `import { log } from '../zz/utils/logging.ts';\nexport const a${i} = log;\n`;
  files['zz/utils/logging.ts'] = 'export const log = () => 1;\n';
  files['src/quiet.ts'] = 'export const quiet = 1;\n';
  const dir = repo(files);
  const m = await buildCodeMap(dir, { maxFiles: 4, maxBytes: 200_000 });
  expect(paths(m)).toEqual(['package.json', 'src/a0.ts', 'src/a1.ts', 'zz/utils/logging.ts']);
  expect(m.candidates).toBe(13);
  expect((m.outside ?? []).map((f) => f.path)).toEqual(['src/a2.ts', 'src/a3.ts', 'src/a4.ts', 'src/a5.ts', 'src/a6.ts', 'src/a7.ts', 'src/a8.ts', 'src/a9.ts', 'src/quiet.ts']);
  // Every importer is an edge, the ones past the cap too; files past the cap carry no symbols.
  expect(m.imports.filter((i) => i.to === 'zz/utils/logging.ts')).toHaveLength(10);
  expect(m.symbols.some((s) => s.path === 'src/a5.ts')).toBe(false);
  expect(m.symbols.some((s) => s.path === 'zz/utils/logging.ts')).toBe(true);
  // Churn counts too: a busy file is kept over a quiet one with the same importers.
  const busy = await buildCodeMap(dir, { maxFiles: 4, maxBytes: 200_000, churn: new Map([['src/quiet.ts', { commits: 40 }]]) });
  expect(paths(busy)).toEqual(['package.json', 'src/a0.ts', 'src/quiet.ts', 'zz/utils/logging.ts']);
  // Incremental: a file entering the map from the index gets its symbols, though it is unchanged.
  const next = await buildCodeMap(dir, { maxFiles: 4, maxBytes: 200_000, churn: new Map([['src/a7.ts', { commits: 40 }]]) }, m);
  expect(next.symbols.some((s) => s.path === 'src/a7.ts')).toBe(true);
  expect(next.imports.filter((i) => i.to === 'zz/utils/logging.ts')).toHaveLength(10);
});

test('aliases that point past the cap resolve: a capped monorepo with @acme-core/* aliases counts nothing unresolved', async () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'acme', private: true, workspaces: ['apps/*', 'packages/*'], devDependencies: { typescript: '5' } }),
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@acme-core/*': ['packages/acme-core/src/*'] } } }),
    'packages/tsconfig/package.json': JSON.stringify({ name: '@acme/tsconfig' }),
    'packages/tsconfig/nextjs.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
    'apps/web/tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig/nextjs.json' }),
    'apps/web/src/chat/a.tsx': "import { render } from '@acme-core/markdown/pipeline';\nexport const A = render;\n",
    'apps/web/src/chat/b.tsx': "import { render } from '@acme-core/markdown/pipeline';\nimport { db } from '@acme-core/db';\nexport const B = render;\n",
    'packages/acme-core/src/markdown/pipeline.ts': "export const render = () => '';\n",
    'packages/db/package.json': JSON.stringify({ name: '@acme-core/db', exports: { '.': './src/index.ts' } }),
    'packages/db/src/index.ts': 'export const db = 1;\n',
  });
  const m = await buildCodeMap(dir, { maxFiles: 6, maxBytes: 200_000 });
  expect(m.candidates).toBeGreaterThan(6);
  expect(m.unresolved).toBe(0);
  expect(m.imports.filter((i) => i.to === 'packages/acme-core/src/markdown/pipeline.ts').map((i) => i.from).sort()).toEqual(['apps/web/src/chat/a.tsx', 'apps/web/src/chat/b.tsx']);
  expect(edge(m, 'apps/web/src/chat/b.tsx', 'packages/db/src/index.ts')).toBeTruthy();
});

test('Python services: absolute, relative and src-layout imports become edges; a local module that is missing is counted', async () => {
  const dir = repo({
    'services/billing/pyproject.toml': '[project]\nname = "billing"\n',
    'services/billing/billing/__init__.py': '',
    'services/billing/billing/event_handlers.py': 'def handle(e):\n    return e\n',
    'services/billing/billing/api.py': 'from billing.event_handlers import handle\nfrom billing.missing import nope\nimport requests\n',
    'services/billing/billing/worker.py': 'from . import event_handlers\n',
    'services/billing/tests/test_handlers.py': 'from billing import event_handlers\n\ndef test_it():\n    pass\n',
  });
  const m = await buildCodeMap(dir, OPTS);
  expect(m.imports.filter((i) => i.to === 'services/billing/billing/event_handlers.py').map((i) => i.from).sort()).toEqual([
    'services/billing/billing/api.py', 'services/billing/billing/worker.py', 'services/billing/tests/test_handlers.py',
  ]);
  expect(edge(m, 'services/billing/billing/api.py', 'pkg:requests')).toBeTruthy();
  expect(m.unresolved).toBe(1);
  expect(testsFor(m, 'services/billing/billing/event_handlers.py')).toEqual(['services/billing/tests/test_handlers.py']);
});
