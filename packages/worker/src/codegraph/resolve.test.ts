import { expect, test } from 'vitest';
import { makeResolver } from './resolve.ts';

/** A repo as path -> content; files with no interesting content get ''. */
const resolver = (files: Record<string, string>) => makeResolver(Object.keys(files), (p) => files[p]);
const tos = (r: { to: string }[]) => r.map((x) => x.to);

test('relative TS/JS imports: extensions, index files, the .js -> .ts ESM convention, JSON', () => {
  const r = resolver({
    'src/a.ts': '', 'src/b.ts': '', 'src/c/index.ts': '', 'src/d.tsx': '', 'src/e.js': '', 'lib/x.mjs': '', 'data.json': '', 'src/types.d.ts': '',
  });
  const at = (spec: string) => tos(r('src/a.ts', 'typescript', { spec, names: [] }));
  expect(at('./b')).toEqual(['src/b.ts']);
  expect(at('./b.js')).toEqual(['src/b.ts']);
  expect(at('./c')).toEqual(['src/c/index.ts']);
  expect(at('./c/index.js')).toEqual(['src/c/index.ts']);
  expect(at('./d')).toEqual(['src/d.tsx']);
  expect(at('./d.js')).toEqual(['src/d.tsx']);
  expect(at('./e')).toEqual(['src/e.js']);
  expect(at('./e.js')).toEqual(['src/e.js']);
  expect(at('./types')).toEqual(['src/types.d.ts']);
  expect(at('../lib/x.mjs')).toEqual(['lib/x.mjs']);
  expect(at('../data.json')).toEqual(['data.json']);
  expect(at('./a')).toEqual([]); // itself
  expect(at('./missing')).toEqual([]);
  expect(at('../../outside')).toEqual([]);
  expect(at('react')).toEqual(['pkg:react']);
  expect(at('@scope/pkg/sub/path')).toEqual(['pkg:@scope/pkg']);
  expect(at('node:fs')).toEqual(['pkg:node:fs']);
  expect(r('src/a.ts', 'typescript', { spec: './b', names: ['x', 'y'] })).toEqual([{ to: 'src/b.ts', names: ['x', 'y'] }]);
});

test('tsconfig paths and baseUrl, with comments, trailing commas and extends; the nearest tsconfig wins', () => {
  const r = resolver({
    'tsconfig.json': `{
      // root config
      "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~lib": ["lib/x.mjs"], }, },
    }`,
    'tsconfig.base.json': '{ "compilerOptions": { "paths": { "#app/*": ["./packages/app/src/*"] } } }',
    'packages/app/tsconfig.json': '{ "extends": "../../tsconfig.base.json", /* no paths here */ "compilerOptions": {} }',
    'src/a.ts': '', 'src/b.ts': '', 'lib/x.mjs': '', 'packages/app/src/main.ts': '', 'packages/app/src/util/index.ts': '',
  });
  expect(tos(r('src/a.ts', 'typescript', { spec: '@/b', names: [] }))).toEqual(['src/b.ts']);
  expect(tos(r('src/a.ts', 'typescript', { spec: '~lib', names: [] }))).toEqual(['lib/x.mjs']);
  expect(tos(r('src/a.ts', 'typescript', { spec: 'src/b', names: [] }))).toEqual(['src/b.ts']); // baseUrl
  expect(tos(r('packages/app/src/main.ts', 'typescript', { spec: '#app/util', names: [] }))).toEqual(['packages/app/src/util/index.ts']);
  // the app's own tsconfig has no baseUrl, so the root one does not apply there
  expect(tos(r('packages/app/src/main.ts', 'typescript', { spec: 'src/b', names: [] }))).toEqual(['pkg:src']);
});

test('workspace package names resolve to the package entry or source', () => {
  const r = resolver({
    'packages/core/package.json': JSON.stringify({ name: '@fb/core', main: 'src/index.ts', exports: { '.': './src/index.ts', './types': './src/types.ts' } }),
    'packages/core/src/index.ts': '', 'packages/core/src/types.ts': '',
    'packages/util/package.json': JSON.stringify({ name: 'util-lib' }),
    'packages/util/src/index.ts': '', 'packages/util/src/deep.ts': '',
    'packages/built/package.json': JSON.stringify({ name: 'built', main: 'dist/index.js', exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } } }),
    'packages/built/src/index.ts': '',
    'packages/broken/package.json': '{ not json',
    'apps/web/src/main.ts': '',
  });
  const at = (spec: string) => tos(r('apps/web/src/main.ts', 'typescript', { spec, names: [] }));
  expect(at('@fb/core')).toEqual(['packages/core/src/index.ts']);
  expect(at('@fb/core/types')).toEqual(['packages/core/src/types.ts']);
  expect(at('util-lib')).toEqual(['packages/util/src/index.ts']);
  expect(at('util-lib/deep')).toEqual(['packages/util/src/deep.ts']);
  expect(at('built')).toEqual(['packages/built/src/index.ts']);
  expect(at('zod')).toEqual(['pkg:zod']);
});

test('Python: relative imports, package-absolute imports, src layouts, submodules named in from-imports', () => {
  const r = resolver({
    'pyproject.toml': '', 'pkg/__init__.py': '', 'pkg/mod.py': '', 'pkg/sub/__init__.py': '', 'pkg/sub/leaf.py': '',
    'tools/pyproject.toml': '', 'tools/src/proj/__init__.py': '', 'tools/src/proj/core.py': '',
    'scripts/run.py': '', 'scripts/helper.py': '', 'ns/inner.py': '',
  });
  const leaf = (spec: string, names: string[]) => r('pkg/sub/leaf.py', 'python', { spec, names });
  expect(leaf('.', ['x'])).toEqual([{ to: 'pkg/sub/__init__.py', names: ['x'] }]);
  expect(leaf('..mod', ['f'])).toEqual([{ to: 'pkg/mod.py', names: ['f'] }]);
  expect(leaf('..', ['mod', 'other'])).toEqual([{ to: 'pkg/mod.py', names: ['mod'] }, { to: 'pkg/__init__.py', names: ['other'] }]);
  expect(leaf('pkg.mod', ['*'])).toEqual([{ to: 'pkg/mod.py', names: ['*'] }]);
  expect(tos(leaf('pkg.mod.func', ['*']))).toEqual(['pkg/mod.py']);
  expect(tos(leaf('pkg', ['sub']))).toEqual(['pkg/sub/__init__.py']);
  expect(tos(leaf('proj.core', ['*']))).toEqual(['tools/src/proj/core.py']);
  expect(tos(leaf('ns', ['inner']))).toEqual(['ns/inner.py']); // namespace package
  expect(tos(leaf('os.path', ['*']))).toEqual(['pkg:os']);
  expect(tos(leaf('....toofar', ['x']))).toEqual([]);
  expect(tos(leaf('.nope', ['x']))).toEqual([]);
  expect(tos(r('scripts/run.py', 'python', { spec: 'helper', names: ['*'] }))).toEqual(['scripts/helper.py']);
});

test('Go: in-module packages fan out to the package files (not its tests); the rest are packages', () => {
  const r = resolver({
    'go.mod': 'module example.com/m\n\ngo 1.22\n', 'pkg/util/a.go': '', 'pkg/util/b.go': '', 'pkg/util/a_test.go': '', 'pkg/util/inner/c.go': '', 'cmd/main.go': '',
  });
  const at = (spec: string) => tos(r('cmd/main.go', 'go', { spec, names: ['*'] }));
  expect(at('example.com/m/pkg/util')).toEqual(['pkg/util/a.go', 'pkg/util/b.go']);
  expect(at('fmt')).toEqual(['pkg:fmt']);
  expect(at('github.com/x/y/z')).toEqual(['pkg:github.com/x/y/z']);
  expect(at('example.com/m/nope')).toEqual(['pkg:example.com/m/nope']);
});

test('Rust: mod declarations, crate/self/super paths, bare module paths, workspace crates', () => {
  const r = resolver({
    'Cargo.toml': '[package]\nname = "my-crate"\n', 'src/lib.rs': '', 'src/a.rs': '', 'src/a/b.rs': '', 'src/c/mod.rs': '', 'src/c/d.rs': '',
    'crates/other/Cargo.toml': '[package]\nname = "other-crate"\nversion = "0.1.0"\n', 'crates/other/src/lib.rs': '', 'crates/other/src/x.rs': '',
  });
  const at = (from: string, spec: string) => tos(r(from, 'rust', { spec, names: [] }));
  expect(at('src/lib.rs', 'mod a')).toEqual(['src/a.rs']);
  expect(at('src/lib.rs', 'mod c')).toEqual(['src/c/mod.rs']);
  expect(at('src/lib.rs', 'crate::a::b::Thing')).toEqual(['src/a/b.rs']);
  expect(at('src/lib.rs', 'crate::a::Item')).toEqual(['src/a.rs']);
  expect(at('src/lib.rs', 'a::b')).toEqual(['src/a/b.rs']);
  expect(at('src/lib.rs', 'std::io')).toEqual(['pkg:std']);
  expect(at('src/lib.rs', 'other_crate::x::Y')).toEqual(['crates/other/src/x.rs']);
  expect(at('src/lib.rs', 'serde::Serialize')).toEqual(['pkg:serde']);
  expect(at('src/a.rs', 'mod b')).toEqual(['src/a/b.rs']);
  expect(at('src/a.rs', 'self::b::T')).toEqual(['src/a/b.rs']);
  expect(at('src/a.rs', 'super::c::d::Z')).toEqual(['src/c/d.rs']);
  expect(at('src/c/d.rs', 'super::Q')).toEqual(['src/c/mod.rs']);
  expect(at('src/c/d.rs', 'crate::Root')).toEqual(['src/lib.rs']);
  expect(at('src/a.rs', 'mod missing')).toEqual([]);
});

test('C#: a using of an in-repo namespace links the files that declare it; Swift modules are packages', () => {
  const r = resolver({
    'A/Foo.cs': 'namespace App.Core {\n class Foo {}\n}', 'A/Bar.cs': 'namespace App.Core;\nclass Bar {}', 'B/Use.cs': 'using App.Core;',
    'C/Other.cs': 'namespace App.Core.Sub { }',
  });
  expect(tos(r('B/Use.cs', 'csharp', { spec: 'App.Core', names: ['*'] }))).toEqual(['A/Bar.cs', 'A/Foo.cs']);
  expect(tos(r('B/Use.cs', 'csharp', { spec: 'System.Text', names: ['*'] }))).toEqual(['pkg:System.Text']);
  expect(tos(r('A/Foo.cs', 'csharp', { spec: 'App.Core', names: ['*'] }))).toEqual(['A/Bar.cs']);
  expect(tos(resolver({ 'a.swift': '' })('a.swift', 'swift', { spec: 'Foundation', names: ['*'] }))).toEqual(['pkg:Foundation']);
});
