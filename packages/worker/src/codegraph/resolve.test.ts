import { expect, test } from 'vitest';
import { makeResolver } from './resolve.ts';

/** A repo as path -> content; files with no interesting content get ''. */
const resolver = (files: Record<string, string>) => makeResolver(Object.keys(files), (p) => files[p]);
const tos = (r: { to: string | null }[]) => r.map((x) => x.to);

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

test('path aliases in a monorepo: extends from a workspace package, solution-style tsconfigs, ${configDir}, package imports', () => {
  const r = resolver({
    'package.json': JSON.stringify({ name: 'acme', workspaces: ['packages/*', 'apps/*'], devDependencies: { typescript: '5' } }),
    'packages/tsconfig/package.json': JSON.stringify({ name: '@acme/tsconfig' }),
    'packages/tsconfig/base.json': '{ "compilerOptions": { "paths": { "@shared/*": ["${configDir}/src/shared/*"] } } }',
    // the app extends a config from a workspace package, and adds its own aliases relative to its own folder
    'apps/web/tsconfig.json': '{ "extends": "@acme/tsconfig/base.json", "compilerOptions": { "baseUrl": ".", "paths": { "@web-core/*": ["../../packages/core/src/*"], "@shared/*": ["./src/shared/*"] } } }',
    'apps/web/src/main.ts': '', 'apps/web/src/shared/util.ts': '',
    'packages/core/src/users/router.ts': '',
    // solution style: tsconfig.json only references; the aliases live in tsconfig.app.json beside it
    'apps/admin/tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
    'apps/admin/tsconfig.app.json': '{ "compilerOptions": { "paths": { "@admin/*": ["./src/*"] } } }',
    'apps/admin/src/page.tsx': '', 'apps/admin/src/lib/api.ts': '',
    // ${configDir} is the folder of the config that uses it, even when the paths come from a config it extends
    'apps/docs/tsconfig.json': '{ "extends": "../../packages/tsconfig/base.json" }',
    'apps/docs/src/index.ts': '', 'apps/docs/src/shared/theme.ts': '',
    // package.json "imports": #-specifiers of the nearest package
    'apps/api/package.json': JSON.stringify({ name: 'api', imports: { '#db/*': './src/db/*.ts', '#config': './src/config.ts' } }),
    'apps/api/src/server.ts': '', 'apps/api/src/db/pool.ts': '', 'apps/api/src/config.ts': '',
  });
  const at = (from: string, spec: string) => tos(r(from, 'typescript', { spec, names: [] }));
  expect(at('apps/web/src/main.ts', '@web-core/users/router')).toEqual(['packages/core/src/users/router.ts']);
  expect(at('apps/web/src/main.ts', '@shared/util')).toEqual(['apps/web/src/shared/util.ts']);
  expect(at('apps/admin/src/page.tsx', '@admin/lib/api')).toEqual(['apps/admin/src/lib/api.ts']);
  expect(at('apps/docs/src/index.ts', '@shared/theme')).toEqual(['apps/docs/src/shared/theme.ts']);
  expect(at('apps/api/src/server.ts', '#db/pool')).toEqual(['apps/api/src/db/pool.ts']);
  expect(at('apps/api/src/server.ts', '#config')).toEqual(['apps/api/src/config.ts']);
});

test('an import that looks local but resolves to nothing is marked unresolved; real packages and builtins are not', () => {
  const r = resolver({
    'package.json': JSON.stringify({ dependencies: { react: '18', '@tanstack/react-router': '1' }, devDependencies: { vitest: '3' } }),
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@app/*": ["src/*"] } } }',
    'src/a.ts': '',
  });
  const at = (spec: string) => r('src/a.ts', 'typescript', { spec, names: [] });
  expect(at('@app/missing')).toEqual([{ to: 'pkg:@app/missing', names: [], unresolved: true }]);
  expect(at('@shared-ui/lib')).toEqual([{ to: 'pkg:@shared-ui/lib', names: [], unresolved: true }]);
  expect(at('#internal/x')).toEqual([{ to: 'pkg:#internal', names: [], unresolved: true }]);
  expect(at('react')).toEqual([{ to: 'pkg:react', names: [] }]);
  expect(at('@tanstack/react-router')).toEqual([{ to: 'pkg:@tanstack/react-router', names: [] }]);
  expect(at('vitest/config')).toEqual([{ to: 'pkg:vitest', names: [] }]);
  expect(at('node:fs')).toEqual([{ to: 'pkg:node:fs', names: [] }]);
  expect(at('path')).toEqual([{ to: 'pkg:path', names: [] }]);
  expect(at('virtual:pwa')).toEqual([{ to: 'pkg:virtual:pwa', names: [] }]);
  // Without any declared dependency there is nothing to tell a package from an alias: only a paths match counts.
  const bare = resolver({ 'src/a.ts': '' });
  expect(bare('src/a.ts', 'typescript', { spec: 'lodash', names: [] })).toEqual([{ to: 'pkg:lodash', names: [] }]);
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
  // A relative import that names no file is counted as unresolved, with no edge.
  expect(leaf('.nope', ['x'])).toEqual([{ to: null, names: ['x'], unresolved: true }]);
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

test('C#: a using of an in-repo namespace links the files that declare it; Swift system modules are packages', () => {
  const r = resolver({
    'A/Foo.cs': 'namespace App.Core {\n class Foo {}\n}', 'A/Bar.cs': 'namespace App.Core;\nclass Bar {}', 'B/Use.cs': 'using App.Core;',
    'C/Other.cs': 'namespace App.Core.Sub { }',
  });
  expect(tos(r('B/Use.cs', 'csharp', { spec: 'App.Core', names: ['*'] }))).toEqual(['A/Bar.cs', 'A/Foo.cs']);
  expect(tos(r('B/Use.cs', 'csharp', { spec: 'System.Text', names: ['*'] }))).toEqual(['pkg:System.Text']);
  expect(tos(r('A/Foo.cs', 'csharp', { spec: 'App.Core', names: ['*'] }))).toEqual(['A/Bar.cs']);
  expect(tos(resolver({ 'a.swift': '' })('a.swift', 'swift', { spec: 'Foundation', names: ['*'] }))).toEqual(['pkg:Foundation']);
});

test('Swift: an import of a Package.swift target or a Sources/<Module> folder links every file of that module', () => {
  const r = resolver({
    'Package.swift': [
      '// swift-tools-version:5.9',
      'let package = Package(name: "App", targets: [',
      '  .executableTarget(name: "App", dependencies: ["Core", .product(name: "Collections", package: "swift-collections")]),',
      '  .target(name: "Core", dependencies: []),',
      '  .target(name: "Net", path: "Lib/Networking"),',
      '  // .target(name: "Old"),',
      '  .testTarget(name: "CoreTests", dependencies: ["Core"]),',
      '])',
    ].join('\n'),
    'Sources/App/main.swift': '', 'Sources/Core/Model.swift': '', 'Sources/Core/Store/Disk.swift': '', 'Sources/Core/notes.md': '',
    'Lib/Networking/Client.swift': '', 'Tests/CoreTests/ModelTests.swift': '', 'ios/Sources/Widget/W.swift': '',
  });
  const at = (from: string, spec: string) => tos(r(from, 'swift', { spec, names: ['*'] }));
  expect(at('Sources/App/main.swift', 'Core')).toEqual(['Sources/Core/Model.swift', 'Sources/Core/Store/Disk.swift']);
  expect(at('Sources/App/main.swift', 'Net')).toEqual(['Lib/Networking/Client.swift']);
  expect(at('Tests/CoreTests/ModelTests.swift', 'Core')).toEqual(['Sources/Core/Model.swift', 'Sources/Core/Store/Disk.swift']);
  expect(at('Sources/App/main.swift', 'CoreTests')).toEqual(['Tests/CoreTests/ModelTests.swift']);
  expect(at('Sources/App/main.swift', 'Core.Model')).toEqual(['Sources/Core/Model.swift', 'Sources/Core/Store/Disk.swift']); // import struct Core.Model
  expect(at('Sources/Core/Model.swift', 'Core')).toEqual(['Sources/Core/Store/Disk.swift']); // never itself
  // No Package.swift entry: the Sources/<Module> convention.
  expect(at('Sources/App/main.swift', 'Widget')).toEqual(['ios/Sources/Widget/W.swift']);
  expect(at('Sources/App/main.swift', 'Old')).toEqual(['pkg:Old']); // commented out
  expect(at('Sources/App/main.swift', 'Foundation')).toEqual(['pkg:Foundation']);
  expect(at('Sources/App/main.swift', 'Collections')).toEqual(['pkg:Collections']);
});

test('GDScript: res:// paths from the folder holding project.godot, relative paths, and class_name references', () => {
  const r = resolver({
    'game/project.godot': '', 'game/actors/player.gd': 'class_name Player\nextends CharacterBody2D', 'game/actors/actor.gd': 'class_name Actor',
    'game/weapons/bullet.gd': '', 'game/main.gd': '', 'game/ui/hud.gd': '',
    'tools/project.godot': '', 'tools/editor.gd': '', 'tools/player.gd': 'class_name Player',
    'loose.gd': '',
  });
  const at = (from: string, spec: string) => tos(r(from, 'gdscript', { spec, names: ['*'] }));
  expect(at('game/main.gd', 'res://weapons/bullet.gd')).toEqual(['game/weapons/bullet.gd']);
  expect(at('game/ui/hud.gd', 'res://actors/player.gd')).toEqual(['game/actors/player.gd']);
  expect(at('game/ui/hud.gd', '../weapons/bullet.gd')).toEqual(['game/weapons/bullet.gd']);
  expect(at('game/main.gd', 'res://missing.gd')).toEqual([]);
  expect(at('game/main.gd', 'uid://b2x4')).toEqual([]);
  expect(at('game/main.gd', 'Actor')).toEqual(['game/actors/actor.gd']);
  // Both projects declare Player: each file gets its own project's.
  expect(at('game/main.gd', 'Player')).toEqual(['game/actors/player.gd']);
  expect(at('tools/editor.gd', 'Player')).toEqual(['tools/player.gd']);
  expect(at('game/main.gd', 'Node2D')).toEqual([]); // an engine class: no edge
  expect(at('game/actors/player.gd', 'Player')).toEqual([]); // never itself
  // Without a project.godot above it, res:// is the repo root.
  expect(at('loose.gd', 'res://game/main.gd')).toEqual(['game/main.gd']);
});

test('a monorepo with @acme-core/* aliases: extends chains through a workspace package, per-package tsconfigs, workspace names', () => {
  const json = (v: unknown) => JSON.stringify(v);
  const r = resolver({
    'package.json': json({ name: 'acme', private: true, workspaces: ['apps/*', 'packages/*'], devDependencies: { typescript: '5' } }),
    'tsconfig.base.json': `{
      // shared by every app and package
      "compilerOptions": { "baseUrl": ".", "paths": { "@acme-core/*": ["packages/acme-core/src/*"], "@acme-core/ui": ["packages/ui/src/index.ts"] } },
    }`,
    // apps/web -> @acme/tsconfig/nextjs.json -> ../../tsconfig.base.json: three configs, the paths in the last one
    'packages/tsconfig/package.json': json({ name: '@acme/tsconfig' }),
    'packages/tsconfig/nextjs.json': json({ extends: '../../tsconfig.base.json', compilerOptions: { jsx: 'preserve' } }),
    'apps/web/tsconfig.json': json({ extends: '@acme/tsconfig/nextjs.json', compilerOptions: { plugins: [{ name: 'next' }] } }),
    'apps/web/src/chat/markdown.tsx': '',
    'packages/acme-core/src/markdown/pipeline.ts': '',
    'packages/acme-core/src/markdown/legacy-threads.ts': '',
    // a package with its own tsconfig: its paths replace the base ones, relative to its own baseUrl
    'packages/acme-core/tsconfig.json': json({ extends: '../../tsconfig.base.json', compilerOptions: { baseUrl: '.', paths: { '~/*': ['./src/*'], '@acme-core/*': ['./src/*'] } } }),
    'packages/acme-core/src/agent/render.ts': '',
    'packages/ui/package.json': json({ name: '@acme-core/ui-kit' }),
    'packages/ui/src/index.ts': '',
    // workspace packages by name, with subpath exports; an alias pattern that names no file falls through to them
    'packages/db/package.json': json({ name: '@acme-core/db', exports: { '.': './src/index.ts', './*': './src/*.ts' } }),
    'packages/db/src/index.ts': '', 'packages/db/src/client.ts': '',
    'apps/api/package.json': json({ name: '@acme/api', dependencies: { '@acme-core/db': 'workspace:*', hono: '4' } }),
    'apps/api/src/routes/agent.ts': '',
  });
  const at = (from: string, spec: string) => r(from, 'typescript', { spec, names: [] });
  expect(tos(at('apps/web/src/chat/markdown.tsx', '@acme-core/markdown/pipeline'))).toEqual(['packages/acme-core/src/markdown/pipeline.ts']);
  expect(tos(at('apps/web/src/chat/markdown.tsx', '@acme-core/ui'))).toEqual(['packages/ui/src/index.ts']);
  expect(tos(at('packages/acme-core/src/agent/render.ts', '~/markdown/legacy-threads'))).toEqual(['packages/acme-core/src/markdown/legacy-threads.ts']);
  expect(tos(at('packages/acme-core/src/agent/render.ts', '@acme-core/markdown/pipeline'))).toEqual(['packages/acme-core/src/markdown/pipeline.ts']);
  expect(tos(at('apps/api/src/routes/agent.ts', '@acme-core/db'))).toEqual(['packages/db/src/index.ts']);
  expect(tos(at('apps/api/src/routes/agent.ts', '@acme-core/db/client'))).toEqual(['packages/db/src/client.ts']);
  expect(tos(at('apps/api/src/routes/agent.ts', '@acme-core/markdown/legacy-threads'))).toEqual(['packages/acme-core/src/markdown/legacy-threads.ts']);
  expect(at('apps/api/src/routes/agent.ts', 'hono')).toEqual([{ to: 'pkg:hono', names: [] }]);
  // Under the alias but no such file: counted, not taken for a package.
  expect(at('apps/web/src/chat/markdown.tsx', '@acme-core/nothing/here')).toEqual([{ to: 'pkg:@acme-core/nothing', names: [], unresolved: true }]);
});

test('Python in a monorepo: service packages, src layouts and relative imports resolve; local-looking misses are counted', () => {
  const r = resolver({
    'services/billing/pyproject.toml': '', 'services/billing/billing/__init__.py': '', 'services/billing/billing/event_handlers.py': '',
    'services/billing/billing/api.py': '', 'services/billing/tests/test_handlers.py': '',
    'services/search/pyproject.toml': '', 'services/search/src/search/__init__.py': '', 'services/search/src/search/index.py': '',
    'services/search/tests/test_index.py': '',
    'tools/logging/__init__.py': '', 'tools/run.py': '',
  });
  const at = (from: string, spec: string, names: string[]) => r(from, 'python', { spec, names });
  expect(tos(at('services/billing/billing/api.py', 'billing.event_handlers', ['handle']))).toEqual(['services/billing/billing/event_handlers.py']);
  expect(tos(at('services/billing/billing/api.py', 'billing', ['event_handlers']))).toEqual(['services/billing/billing/event_handlers.py']);
  expect(tos(at('services/billing/billing/api.py', '.event_handlers', ['handle']))).toEqual(['services/billing/billing/event_handlers.py']);
  expect(tos(at('services/billing/tests/test_handlers.py', 'billing.event_handlers', ['*']))).toEqual(['services/billing/billing/event_handlers.py']);
  expect(tos(at('services/search/tests/test_index.py', 'search.index', ['Index']))).toEqual(['services/search/src/search/index.py']);
  // A package of this repo, a module it does not have: unresolved, not a third-party package.
  expect(at('services/billing/billing/api.py', 'billing.missing', ['x'])).toEqual([{ to: 'pkg:billing', names: ['x'], unresolved: true }]);
  expect(at('services/billing/billing/api.py', 'search.gone', ['Index'])).toEqual([{ to: 'pkg:search', names: ['Index'], unresolved: true }]);
  // Third-party and the standard library stay packages, even when a folder of the repo shares the name.
  expect(at('services/billing/billing/api.py', 'requests', ['*'])).toEqual([{ to: 'pkg:requests', names: ['*'] }]);
  expect(at('services/billing/billing/api.py', 'logging', ['*'])).toEqual([{ to: 'pkg:logging', names: ['*'] }]);
});
