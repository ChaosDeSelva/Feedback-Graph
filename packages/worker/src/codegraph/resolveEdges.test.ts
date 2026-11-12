import { expect, test } from 'vitest';
import { makeResolver, parseJsonc } from './resolve.ts';

const resolver = (files: Record<string, string>) => makeResolver(Object.keys(files), (p) => files[p]);
const tos = (r: { to: string | null }[]) => r.map((x) => x.to);

test('JSONC: an escaped quote inside a string and an unterminated block comment', () => {
  expect(parseJsonc('{ "a": "say \\"hi\\" // not a comment" }')).toEqual({ a: 'say "hi" // not a comment' });
  expect(parseJsonc('{ "a": 1 } /* never closed')).toEqual({ a: 1 });
});

test('tsconfig: extends an absolute path, an unscoped workspace package, the folder above, a list, and a missing package', () => {
  const r = resolver({
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@root/*": ["src/*"] } } }',
    'configs/package.json': JSON.stringify({ name: 'shared-config' }),
    'configs/strict.json': '{ "compilerOptions": { "paths": { "@strict/*": ["src/strict/*"] } } }',
    'configs/abs.json': '{ "compilerOptions": { "paths": { "@abs/*": ["src/abs/*"] } } }',
    // extends: the folder above (the root tsconfig.json), then an absolute path; the later one wins for `paths`
    'apps/one/tsconfig.json': '{ "extends": ["../..", "/configs/abs.json"] }',
    'apps/two/tsconfig.json': '{ "extends": "shared-config/strict.json" }',
    'apps/three/tsconfig.json': '{ "extends": "not-in-repo/base.json", "compilerOptions": { "paths": { "@three/*": ["./*"] } } }',
    'src/abs/x.ts': '', 'configs/src/strict/y.ts': '', 'apps/one/a.ts': '', 'apps/two/b.ts': '', 'apps/three/c.ts': '', 'apps/three/d.ts': '',
  });
  const at = (from: string, spec: string) => tos(r(from, 'typescript', { spec, names: [] }));
  expect(at('apps/one/a.ts', '@abs/x')).toEqual(['src/abs/x.ts']);
  // paths without a baseUrl are relative to the config that declares them
  expect(at('apps/two/b.ts', '@strict/y')).toEqual(['configs/src/strict/y.ts']);
  expect(at('apps/three/c.ts', '@three/d')).toEqual(['apps/three/d.ts']);
});

test('tsconfig: the longer of two matching wildcards wins, a baseUrl outside the repo is ignored, odd path values give nothing', () => {
  const r = resolver({
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@/*': ['src/*'], '@/lib/*': ['lib/*'], '@null/*': null, '@str/*': 'src/*', '@mixed/*': [1, 'src/*'] } } }),
    'src/lib/x.ts': '', 'lib/x.ts': '', 'src/a.ts': '', 'src/b.ts': '',
  });
  const at = (spec: string) => r('src/a.ts', 'typescript', { spec, names: [] });
  expect(tos(at('@/lib/x'))).toEqual(['lib/x.ts']);
  // baseUrl leaves the repo: paths resolve from the tsconfig's folder
  expect(tos(at('@/b'))).toEqual(['src/b.ts']);
  expect(at('@null/b')).toEqual([{ to: 'pkg:@null/b', names: [], unresolved: true }]);
  expect(at('@str/b')).toEqual([{ to: 'pkg:@str/b', names: [], unresolved: true }]);
  expect(tos(at('@mixed/b'))).toEqual(['src/b.ts']);
});

test('solution-style configs beside each other are tried in name order', () => {
  const r = resolver({
    'tsconfig.lib.json': '{ "compilerOptions": { "paths": { "@x/*": ["lib/*"] } } }',
    'tsconfig.app.json': '{ "compilerOptions": { "paths": { "@x/*": ["app/*"] } } }',
    'tsconfig.web.json': '{ "compilerOptions": { "paths": { "@x/*": ["web/*"] } } }',
    'app/a.ts': '', 'lib/a.ts': '', 'main.ts': '',
  });
  expect(tos(r('main.ts', 'typescript', { spec: '@x/a', names: [] }))).toEqual(['app/a.ts']);
});

test('a config that is valid JSON but not an object is no config', () => {
  const r = resolver({ 'tsconfig.json': '[1, 2]', 'package.json': '"just a string"', 'src/a.ts': '' });
  expect(r('src/a.ts', 'typescript', { spec: 'lodash', names: [] })).toEqual([{ to: 'pkg:lodash', names: [] }]);
});

test('#-imports: no package.json above, a key that does not match, a target with no file, a target outside the repo', () => {
  const none = resolver({ 'src/a.ts': '' });
  expect(none('src/a.ts', 'typescript', { spec: '#x', names: [] })).toEqual([{ to: 'pkg:#x', names: [], unresolved: true }]);
  const r = resolver({
    'package.json': JSON.stringify({ name: 'app', imports: { '#db': './src/db.ts', '#gone': './src/gone.ts', '#up': '../../x.ts' } }),
    'src/a.ts': '',
  });
  const at = (spec: string) => r('src/a.ts', 'typescript', { spec, names: [] });
  for (const spec of ['#other', '#gone', '#up']) expect(at(spec), spec).toEqual([{ to: `pkg:${spec}`, names: [], unresolved: true }]);
});

test('@types packages declare the module they type, scoped ones as @scope/pkg', () => {
  const r = resolver({
    'package.json': JSON.stringify({ devDependencies: { '@types/node-fetch': '2', '@types/babel__core': '7' } }),
    'src/a.ts': '',
  });
  const at = (spec: string) => r('src/a.ts', 'typescript', { spec, names: [] });
  expect(at('node-fetch')).toEqual([{ to: 'pkg:node-fetch', names: [] }]);
  expect(at('@babel/core')).toEqual([{ to: 'pkg:@babel/core', names: [] }]);
  expect(at('left-pad')).toEqual([{ to: 'pkg:left-pad', names: [], unresolved: true }]);
});

test('workspace packages: a root package, string and array exports, condition-only exports, null targets, and no entry at all', () => {
  const r = resolver({
    'package.json': JSON.stringify({ name: 'root-pkg', exports: './main.ts' }),
    'main.ts': '',
    'packages/arr/package.json': JSON.stringify({ name: 'arr', exports: ['./missing.js', './src/entry.ts'] }),
    'packages/arr/src/entry.ts': '', 'packages/arr/src/sub.ts': '',
    'packages/cond/package.json': JSON.stringify({ name: 'cond', exports: { import: './lib/mod.js', require: null } }),
    'packages/cond/src/mod.ts': '',
    'packages/empty/package.json': JSON.stringify({ name: 'empty' }),
    'packages/escape/package.json': JSON.stringify({ name: 'escape', main: '../../../out.js' }),
    'apps/a.ts': '',
  });
  const at = (spec: string) => r('apps/a.ts', 'typescript', { spec, names: [] });
  expect(tos(at('root-pkg'))).toEqual(['main.ts']);
  expect(tos(at('arr'))).toEqual(['packages/arr/src/entry.ts']);
  expect(tos(at('arr/sub'))).toEqual(['packages/arr/src/sub.ts']);
  expect(tos(at('cond'))).toEqual(['packages/cond/src/mod.ts']);
  expect(at('empty')).toEqual([{ to: 'pkg:empty', names: [], unresolved: true }]);
  expect(at('escape')).toEqual([{ to: 'pkg:escape', names: [], unresolved: true }]);
  // a path from the repo root
  expect(tos(at('/main'))).toEqual(['main.ts']);
});

test('Python: relative imports at the repo root, and names in a folder with no __init__.py', () => {
  const r = resolver({ '__init__.py': '', 'a.py': '', 'b.py': '', 'ns/c.py': '' });
  expect(r('a.py', 'python', { spec: '.', names: ['b'] })).toEqual([{ to: 'b.py', names: ['b'] }]);
  expect(r('a.py', 'python', { spec: '.', names: ['helper'] })).toEqual([{ to: '__init__.py', names: ['helper'] }]);
  // ns is a namespace package: a name that is no module of it has nowhere to go
  expect(r('a.py', 'python', { spec: '.ns', names: ['c', 'missing'] })).toEqual([{ to: 'ns/c.py', names: ['c'] }]);
});

test('Go: a go.mod without a module line, and an import path that climbs out of the repo', () => {
  const r = resolver({ 'go.mod': 'go 1.22\n', 'svc/go.mod': 'module example.com/svc\n', 'svc/x/x.go': '' });
  expect(tos(r('svc/x/x.go', 'go', { spec: 'example.com/other', names: ['*'] }))).toEqual(['pkg:example.com/other']);
  expect(tos(r('svc/x/x.go', 'go', { spec: 'example.com/svc/../../../x', names: ['*'] }))).toEqual(['pkg:example.com/svc/../../../x']);
});

test('Rust: a workspace Cargo.toml without a package, crate paths outside any crate, super chains, missing modules', () => {
  const r = resolver({
    'Cargo.toml': '[workspace]\nmembers = ["app"]\n',
    'app/Cargo.toml': '[package]\nname = "app"\n',
    'app/src/lib.rs': '', 'app/src/a/mod.rs': '', 'app/src/a/b/mod.rs': '', 'app/src/a/b/c.rs': '', 'app/src/top.rs': '',
    'tools/gen.rs': '',
    'empty/Cargo.toml': '[package]\nname = "empty"\n', 'empty/build.rs': '',
  });
  expect(tos(r('tools/gen.rs', 'rust', { spec: 'crate::x', names: ['x'] }))).toEqual([]);
  expect(tos(r('app/src/a/b/c.rs', 'rust', { spec: 'super::super::super::top', names: ['top'] }))).toEqual(['app/src/top.rs']);
  // a crate with neither lib.rs nor main.rs: its root module is no file
  expect(tos(r('empty/build.rs', 'rust', { spec: 'crate::x', names: ['x'] }))).toEqual([]);
});

test('files whose content the resolver was not given declare no namespace, Swift target or Godot class', () => {
  const r = makeResolver(['App/A.cs', 'Package.swift', 'Sources/Kit/k.swift', 'game/p.gd', 'game/q.gd'], () => undefined);
  expect(tos(r('App/A.cs', 'csharp', { spec: 'App.Core', names: ['*'] }))).toEqual(['pkg:App.Core']);
  expect(tos(r('Sources/Kit/k.swift', 'swift', { spec: 'Kit', names: ['*'] }))).toEqual([]);
  expect(tos(r('game/p.gd', 'gdscript', { spec: 'Player', names: ['Player'] }))).toEqual([]);
});

test('Swift: a target without a name, and a target path outside the repo', () => {
  const r = resolver({
    'Package.swift': 'let p = Package(targets: [ .target(path: "Sources/Anon"), .target(name: "Out", path: "../../elsewhere"), .target(name: "Kit") ])',
    'Sources/Kit/k.swift': '', 'Sources/Anon/a.swift': '', 'App/main.swift': '',
  });
  expect(tos(r('App/main.swift', 'swift', { spec: 'Kit', names: ['*'] }))).toEqual(['Sources/Kit/k.swift']);
  expect(tos(r('App/main.swift', 'swift', { spec: 'Out', names: ['*'] }))).toEqual(['pkg:Out']);
});

test('an import from a language with no resolver is a package', () => {
  const r = resolver({ 'a.rb': '' });
  expect(r('a.rb', 'ruby', { spec: 'json', names: ['*'] })).toEqual([{ to: 'pkg:json', names: ['*'] }]);
});
