import { expect, test } from 'vitest';
import { inScope, MAX_SHARDS, MIN_SHARD_FILES, planShards, shardBudget, shardScope, type Shard } from './shard.ts';

/** n files under dir (dir/f0.ts, ...), plus a manifest when given. */
const pkg = (dir: string, n: number, manifest?: string) => [...(manifest ? [`${dir}/${manifest}`] : []), ...Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`)];
const summary = (shards: Shard[]) => shards.map((s) => [s.key, s.files.length]);

/** Every file lands in exactly one shard, and that shard's scope (what a rescan replaces) is the only one holding it. */
function expectPartition(paths: string[], shards: Shard[]) {
  expect(shards.flatMap((s) => s.files).sort()).toEqual([...paths].sort());
  for (const p of paths) {
    const owners = shards.filter((s) => inScope(p, shardScope(s, shards)));
    expect(owners.map((s) => s.key), p).toEqual([shards.find((s) => s.files.includes(p))!.key]);
  }
}

test('a pnpm workspace is split by its packages; the rest (root files, docs) is one more shard', () => {
  const paths = ['package.json', 'README.md', 'pnpm-workspace.yaml', ...pkg('docs', 5), ...pkg('packages/core', 8, 'package.json'), ...pkg('packages/api', 6, 'package.json'), ...pkg('apps/web', 7, 'package.json'), ...pkg('apps/not-listed', 6)];
  const shards = planShards(paths, { 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - \"apps/web\"\n  - '!packages/skip'\n" });
  expect(summary(shards)).toEqual([['.', 14], ['apps/web', 8], ['packages/api', 7], ['packages/core', 9]]);
  expect(shards.find((s) => s.key === '.')!.roots).toEqual(['']);
  expectPartition(paths, shards);
});

test('package.json workspaces (array or object form), go.work and Cargo workspace members are read too', () => {
  const npm = [...pkg('libs/a', 6, 'package.json'), ...pkg('libs/b', 6, 'package.json'), 'package.json'];
  expect(summary(planShards(npm, { 'package.json': JSON.stringify({ workspaces: ['libs/*'] }) })).map((s) => s[0])).toEqual(['libs/a+.', 'libs/b']);
  expect(summary(planShards(npm, { 'package.json': JSON.stringify({ workspaces: { packages: ['libs/**'] } }) })).map((s) => s[0])).toEqual(['libs/a+.', 'libs/b']);

  const go = [...pkg('svc/billing', 6, 'go.mod'), ...pkg('svc/auth', 6, 'go.mod'), ...pkg('tools', 6), 'go.work'];
  const goShards = planShards(go, { 'go.work': 'go 1.22\n\nuse (\n\t./svc/billing\n\t./svc/auth // the login service\n)\nuse ./tools\n' });
  expect(goShards.map((s) => s.key)).toEqual(['svc/auth', 'svc/billing', 'tools+.']);

  const cargo = [...pkg('crates/core', 6, 'Cargo.toml'), ...pkg('crates/cli', 6, 'Cargo.toml'), ...pkg('xtask', 6, 'Cargo.toml'), 'Cargo.toml'];
  const cargoShards = planShards(cargo, { 'Cargo.toml': '[workspace]\nmembers = [\n  "crates/*",\n  "xtask",\n]\nexclude = ["crates/old"]\n' });
  expect(cargoShards.map((s) => s.key)).toEqual(['crates/cli+.', 'crates/core', 'xtask']);
  expectPartition(cargo, cargoShards);
});

test('without a workspace, top-level directories under src/, services/, apps/, cmd/ and packages/ are the shards', () => {
  const paths = ['README.md', 'Makefile', 'go.mod', ...pkg('src/webapp', 9), ...pkg('src/billing', 7), ...pkg('cmd/server', 5), ...pkg('deploy', 6), 'src/main.go'];
  const shards = planShards(paths, {});
  expect(summary(shards)).toEqual([['.', 10], ['cmd/server', 5], ['src/billing', 7], ['src/webapp', 9]]);
  expectPartition(paths, shards);
});

test('a repo with no package structure is one shard covering everything', () => {
  const paths = ['README.md', 'main.py', ...pkg('lib', 30)];
  const shards = planShards(paths, {});
  expect(shards).toEqual([{ key: '.', roots: [''], files: paths }]);
  expect(shardScope(shards[0], shards)).toEqual({ prefixes: [''], except: [] });
  expect(planShards([], {})).toEqual([]);
});

test(`tiny shards (under ${MIN_SHARD_FILES} files) merge into the next smallest, and a repo with many packages is capped at ${MAX_SHARDS}`, () => {
  const tiny = [...pkg('src/a', 2), ...pkg('src/b', 1), ...pkg('src/big', 20), ...pkg('src/mid', 8), ...pkg('docs', 9)];
  const merged = planShards(tiny, {});
  // b (1) goes into a (2), a+b (3) into mid (8)
  expect(summary(merged)).toEqual([['.', 9], ['src/big', 20], ['src/mid+src/a+src/b', 11]]);
  expect(merged.find((s) => s.key.startsWith('src/mid'))!.roots).toEqual(['src/mid', 'src/a', 'src/b']);
  expectPartition(tiny, merged);

  const many = Array.from({ length: 40 }, (_, i) => pkg(`services/s${String(i).padStart(2, '0')}`, 5 + i)).flat();
  const capped = planShards(many, {});
  expect(capped).toHaveLength(MAX_SHARDS);
  expect(capped.flatMap((s) => s.files)).toHaveLength(many.length);
  expectPartition(many, capped);
});

test('a package nested in another is its own shard; the outer package scope leaves it out', () => {
  const paths = [...pkg('packages/app', 6, 'package.json'), ...pkg('packages/app/plugins/x', 6, 'package.json'), 'package.json', ...pkg('scripts', 6)];
  const shards = planShards(paths, { 'package.json': JSON.stringify({ workspaces: ['packages/app', 'packages/app/plugins/*'] }) });
  expect(summary(shards)).toEqual([['.', 7], ['packages/app', 7], ['packages/app/plugins/x', 7]]);
  const app = shards.find((s) => s.key === 'packages/app')!;
  expect(shardScope(app, shards)).toEqual({ prefixes: ['packages/app'], except: ['packages/app/plugins/x'] });
  expect(shardScope(shards[0], shards)).toEqual({ prefixes: [''], except: ['packages/app', 'packages/app/plugins/x'] });
  expectPartition(paths, shards);
});

test('the rest scope also owns project-wide facts (".") and paths no package claims; a package owns its own directory', () => {
  const shards = planShards([...pkg('src/a', 6), ...pkg('src/b', 6), 'README.md', ...pkg('docs', 5)], {});
  const [rest, a] = shards;
  expect(inScope('.', shardScope(rest, shards))).toBe(true);
  expect(inScope('somewhere/else.ts', shardScope(rest, shards))).toBe(true);
  expect(inScope('src/a', shardScope(a, shards))).toBe(true);
  expect(inScope('src/ab/x.ts', shardScope(a, shards))).toBe(false);
  expect(inScope('.', shardScope(a, shards))).toBe(false);
});

test('the fact budget scales with the shard, from 10 to 60', () => {
  expect(shardBudget(1)).toBe(10);
  expect(shardBudget(5)).toBe(10);
  expect(shardBudget(50)).toBeGreaterThan(20);
  expect(shardBudget(100)).toBeGreaterThan(shardBudget(50));
  expect(shardBudget(400)).toBe(60);
  expect(shardBudget(20_000)).toBe(60);
});
