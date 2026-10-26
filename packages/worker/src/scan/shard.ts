import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FactScope } from '@fb/core';

/**
 * How an agentic scan splits a repo. One pass over a monorepo with one fact budget is a skim by construction; one pass
 * per package (or service) with its own budget reaches the code, and a rescan only revisits the packages that changed.
 *
 * A shard is a set of roots (directories; '' is the rest of the repo). A file belongs to the shard whose root is the
 * longest one above it, so a package nested in another is its own shard. What a rescan of a shard replaces is its
 * scope (shardScope): everything under its roots except what a deeper root of another shard claims. The rest shard's
 * scope ('' minus every other root) also takes project-wide facts ('.') and paths no package claims.
 */
export type Shard = { key: string; roots: string[]; files: string[] };
/** The paths a shard owns: under one of `prefixes` ('' is everything) and under none of `except` (FactsStore.replaceScopeFacts). */
export type ShardScope = FactScope;

/**
 * Shards per repo at most: past this the smallest are merged, so a repo of 200 services is not 200 agent runs. High
 * enough that a 10,000-file monorepo split at MAX_SHARD_FILES is not merged back into big shards.
 */
export const MAX_SHARDS = 40;
/** A shard with fewer files than this is merged into the next smallest one: an agent run for two files is waste. */
export const MIN_SHARD_FILES = 5;
/**
 * A shard with more files than this is split by its subdirectories: one agent run over 7,000 files read 31 of them. A
 * directory holding more than this many files directly cannot be split (a scope is a set of directories).
 */
export const MAX_SHARD_FILES = 400;
/** Directories whose children are taken as shards when the repo declares no workspace (src/webapp, src/billing). */
const SOURCE_ROOTS = ['src', 'packages', 'services', 'apps', 'cmd'];
/**
 * Folders that hold services or apps, at any depth: each directory directly under one is a shard of its own
 * (src/webapp/apps/api, services/billing, cmd/server), and small ones merge only with a sibling in the same folder.
 */
const CONTAINER_DIRS = new Set(['apps', 'services', 'packages', 'cmd', 'libs', 'crates', 'modules', 'plugins']);
/** Files that make their directory a package or service of its own, whether or not a workspace file names it. */
const PACKAGE_MANIFESTS = ['package.json', 'go.mod', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'Package.swift', 'composer.json', 'Gemfile', 'mix.exs', 'pom.xml', 'build.gradle', 'build.gradle.kts'];
/** A manifest under one of these is test data, not a package. */
const FIXTURE_DIRS = new Set(['fixtures', '__fixtures__', 'testdata', 'test-fixtures', 'node_modules']);
/**
 * Folders whose files are worth little to an agent changing the code. Their files get a small, capped share of a shard's
 * fact budget (shardFactBudget) and only a sample of them is listed to the agent; a top-level one is a shard of its
 * own, and no manifest or app folder under one makes a shard. Which folder is one depends on its kind (lowValueRule):
 * tests, fixtures and snapshots (TEST_DIRS) and vendored or generated code (GENERATED_DIRS) at any depth; shelved code
 * (SHELVED_DIRS: the attic, archives, specs) only by position, since src/features/archive or a packages/spec library is
 * real source.
 */
const TEST_DIRS = new Set([
  'test', 'tests', '__tests__', 'e2e', 'fixtures', '__fixtures__', 'testdata', 'test-fixtures', 'test_data', '__mocks__', 'mocks', 'snapshots', '__snapshots__',
]);
const GENERATED_DIRS = new Set(['vendor', 'vendored', 'third_party', 'third-party', 'generated', '__generated__', 'node_modules']);
/**
 * Low-value only at the repo's top level or directly under a service root (a directory holding a manifest, or one
 * directly under a CONTAINER_DIRS folder), and never when the folder holds a package manifest itself or sits in a
 * features/ folder.
 */
const SHELVED_DIRS = new Set(['spec', 'specs', 'attic', 'archive', 'archived']);
/** Test files, snapshots and generated code by name, wherever they are. */
const LOW_VALUE_FILE = /(\.(test|spec)\.[cm]?[jt]sx?|_test\.go|_test\.py|\.snap|_snapshot\.json|\.generated\.\w+|\.pb\.go|_pb2\.py)$|(^|\/)test_[^/]*\.py$/;

/** Whether the folder dirSegs[0..i] is low-value, given the directories that hold a package manifest. */
function lowValueDirAt(dirSegs: string[], i: number, manifestDirs: ReadonlySet<string>): boolean {
  const name = dirSegs[i];
  if (TEST_DIRS.has(name) || GENERATED_DIRS.has(name)) return true;
  if (!SHELVED_DIRS.has(name)) return false;
  if (manifestDirs.has(dirSegs.slice(0, i + 1).join('/'))) return false;
  if (i === 0) return true;
  if (dirSegs[i - 1] === 'features') return false;
  const parent = dirSegs.slice(0, i).join('/');
  return manifestDirs.has(parent) || (i >= 2 && CONTAINER_DIRS.has(dirSegs[i - 2]));
}

/** Directories (not the root) holding one of PACKAGE_MANIFESTS, among repo-relative `paths`. */
const manifestDirsOf = (paths: string[]) => new Set(paths.filter((p) => PACKAGE_MANIFESTS.includes(p.slice(p.lastIndexOf('/') + 1)) && p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/'))));

/**
 * Low-value files (tests, fixtures, archives, vendored and generated code; LOW_VALUE_FILE by name) among repo-relative
 * `paths`, which say where the package manifests are (a shelved name holding one is a package, not the attic).
 */
export function lowValueRule(paths: string[]): (path: string) => boolean {
  const manifests = manifestDirsOf(paths);
  return (path) => {
    if (LOW_VALUE_FILE.test(path)) return true;
    const dirs = path.split('/').slice(0, -1);
    return dirs.some((_, i) => lowValueDirAt(dirs, i, manifests));
  };
}

/** lowValueRule knowing no manifests: what a path alone says. */
export const isLowValue = lowValueRule([]);

/** The workspace files planShards reads, from the repo root. */
export const WORKSPACE_FILES = ['pnpm-workspace.yaml', 'package.json', 'go.work', 'Cargo.toml'];

export const under = (path: string, root: string) => root === '' || path === root || path.startsWith(`${root}/`);
export const inScope = (path: string, s: ShardScope) => s.prefixes.some((r) => under(path, r)) && !s.except.some((r) => under(path, r));

/** The most facts one agent run is asked for (the answer schema allows 120). */
export const MAX_SHARD_BUDGET = 120;
/**
 * Facts asked of a shard's agent run: 10 for a handful of files, growing with the square root for small shards and
 * with the file count (one per five files) for big ones, MAX_SHARD_BUDGET at most. 0.6.0 stopped at 60 from 225 files.
 */
export const shardBudget = (files: number) => Math.min(MAX_SHARD_BUDGET, Math.max(10, Math.round(4 * Math.sqrt(files)), Math.round(files / 5)));
/** Facts low-value files (isLowValue) add to a shard's budget at most, however many there are. */
export const MAX_LOW_VALUE_BUDGET = 8;
/** Facts `files` low-value files are worth: a few, growing slowly, MAX_LOW_VALUE_BUDGET at most; 0 for none. */
export const lowValueBudget = (files: number) => (files ? Math.min(MAX_LOW_VALUE_BUDGET, Math.max(2, Math.round(Math.sqrt(files) / 2))) : 0);
/**
 * A shard's fact budget from its mix: shardBudget over its source files plus lowValueBudget over its tests, fixtures and
 * archives (0.6.2 gave 300 test files the budget of 300 source files), MAX_SHARD_BUDGET at most. A shard of only
 * low-value files (the attic) gets lowValueBudget alone.
 */
export const shardFactBudget = (core: number, low: number) => Math.min(MAX_SHARD_BUDGET, (core ? shardBudget(core) : 0) + lowValueBudget(low));

/** Its roots, less the deeper roots of other shards (which own their own files and facts). */
export function shardScope(shard: Shard, all: Shard[]): ShardScope {
  const others = all.filter((s) => s !== shard).flatMap((s) => s.roots).filter((o) => o !== '');
  return { prefixes: shard.roots, except: others.filter((o) => shard.roots.some((r) => r !== o && under(o, r))) };
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const clean = (p: string) => p.trim().replace(/^["']|["']$/g, '').replace(/^\.\//, '').replace(/\/+$/, '');

/** A workspace glob as a regex over directories: `*` is one segment, `**` any depth. */
function globRe(pattern: string): RegExp {
  const body = pattern.split('/').map((seg) => (seg === '**' ? '.+' : seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+'))).join('/');
  return new RegExp(`^${body}$`);
}

/** Directories matched by include patterns ('!x' excludes), among `dirs`. */
function matchDirs(patterns: string[], dirs: Set<string>): string[] {
  const inc = patterns.filter((p) => !p.startsWith('!')).map(clean).filter((p) => p && p !== '.');
  const exc = patterns.filter((p) => p.startsWith('!')).map((p) => clean(p.slice(1)));
  return [...dirs].filter((d) => d && inc.some((p) => globRe(p).test(d)) && !exc.some((p) => globRe(p).test(d)));
}

/** Directories holding a file named `name`. */
const dirsWith = (paths: string[], name: string) => new Set(paths.filter((p) => p === name || p.endsWith(`/${name}`)).map(dirOf));

/** Package roots the repo's workspace files declare (pnpm, npm/yarn, go.work, Cargo). */
function workspaceRoots(paths: string[], files: Record<string, string>): string[] {
  const roots = new Set<string>();
  const pnpm = files['pnpm-workspace.yaml'];
  if (pnpm) {
    const block = pnpm.match(/^packages:\s*\n((?:[ \t]*(?:-.*|#.*)?\n?)*)/m)?.[1] ?? '';
    const pats = [...block.matchAll(/^\s*-\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/\s+#.*$/, ''));
    for (const d of matchDirs(pats, dirsWith(paths, 'package.json'))) roots.add(d);
  }
  const pkg = files['package.json'];
  if (pkg) {
    try {
      const ws = (JSON.parse(pkg) as { workspaces?: string[] | { packages?: string[] } }).workspaces;
      const pats = Array.isArray(ws) ? ws : ws?.packages;
      if (Array.isArray(pats)) for (const d of matchDirs(pats.filter((p) => typeof p === 'string'), dirsWith(paths, 'package.json'))) roots.add(d);
    } catch {
      // not JSON: no npm workspace
    }
  }
  const gowork = files['go.work']?.replace(/\/\/.*$/gm, '');
  if (gowork) {
    const uses = [...gowork.matchAll(/^use\s*\(([\s\S]*?)\)/gm)].flatMap((m) => m[1].split('\n')).concat([...gowork.matchAll(/^use\s+([^(\s]\S*)/gm)].map((m) => m[1]));
    const dirs = new Set(paths.flatMap((p) => p.split('/').slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join('/'))));
    for (const d of matchDirs(uses.map(clean).filter(Boolean), dirs)) roots.add(d);
  }
  const cargo = files['Cargo.toml'];
  const ws = cargo?.match(/^\[workspace\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
  if (ws) {
    const list = (key: string) => [...(ws.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))?.[1] ?? '').matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    for (const d of matchDirs([...list('members'), ...list('exclude').map((e) => `!${e}`)], dirsWith(paths, 'Cargo.toml'))) roots.add(d);
  }
  return [...roots];
}

/** The fallback: each directory directly under a common source root (src/webapp, services/billing, cmd/server). */
function sourceDirRoots(paths: string[], manifests: ReadonlySet<string>): string[] {
  const roots = new Set<string>();
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.length >= 3 && SOURCE_ROOTS.includes(segs[0]) && !lowValueDirAt(segs, 1, manifests)) roots.add(`${segs[0]}/${segs[1]}`);
  }
  return [...roots];
}

/** Under a fixture or low-value folder (the attic, tests): no package or app there is a shard of its own. */
const inLowValueDir = (dirSegs: string[], manifests: ReadonlySet<string>) => dirSegs.some((s, i) => FIXTURE_DIRS.has(s) || lowValueDirAt(dirSegs, i, manifests));

/** Directories other than the repo root that hold a package manifest (PACKAGE_MANIFESTS), outside fixtures and archives. */
function manifestRoots(paths: string[], manifests: ReadonlySet<string>): string[] {
  const roots = new Set<string>();
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.length < 2 || !PACKAGE_MANIFESTS.includes(segs.at(-1)!) || inLowValueDir(segs.slice(0, -1), manifests)) continue;
    roots.add(segs.slice(0, -1).join('/'));
  }
  return [...roots];
}

/** Every directory directly under a CONTAINER_DIRS folder, at any depth (src/webapp/apps/api), outside fixtures and archives. */
function containerRoots(paths: string[], manifests: ReadonlySet<string>): string[] {
  const roots = new Set<string>();
  for (const p of paths) {
    const dirs = p.split('/').slice(0, -1);
    for (let i = 0; i + 1 < dirs.length; i++) {
      if (inLowValueDir(dirs.slice(0, i + 2), manifests)) break;
      if (CONTAINER_DIRS.has(dirs[i])) roots.add(dirs.slice(0, i + 2).join('/'));
    }
  }
  return [...roots];
}

/** Top-level low-value folders (attic/, tests/): one shard each, so their files never weigh on the rest's budget. */
function lowValueRoots(paths: string[], manifests: ReadonlySet<string>): string[] {
  return [...new Set(paths.map((p) => p.split('/')).filter((s) => s.length >= 2 && lowValueDirAt(s, 0, manifests)).map((s) => s[0]))];
}

/**
 * A root's files, split while there are more than MAX_SHARD_FILES: each subdirectory holding at least MIN_SHARD_FILES
 * of them becomes a root of its own (split in turn); files directly under the root and smaller subdirectories stay.
 */
function split(root: string, files: string[]): [string, string[]][] {
  if (files.length <= MAX_SHARD_FILES) return [[root, files]];
  const depth = root === '' ? 0 : root.split('/').length;
  const own: string[] = [];
  const children = new Map<string, string[]>();
  for (const p of files) {
    const segs = p.split('/');
    if (segs.length <= depth + 1) own.push(p);
    else {
      const child = segs.slice(0, depth + 1).join('/');
      if (!children.has(child)) children.set(child, []);
      children.get(child)!.push(p);
    }
  }
  const big = [...children].filter(([, fs]) => fs.length >= MIN_SHARD_FILES);
  if (!big.length) return [[root, files]];
  for (const [, fs] of [...children].filter(([, fs]) => fs.length < MIN_SHARD_FILES)) own.push(...fs);
  return [...(own.length ? [[root, own] as [string, string[]]] : []), ...big.flatMap(([child, fs]) => split(child, fs))];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (roots: string[]) => roots.map((r) => r || '.').join('+');

const parentOf = (root: string) => (root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '');

/**
 * Split repo-relative `paths` into shards along service boundaries. The roots: the workspace packages the repo declares
 * (`files` holds the root's WORKSPACE_FILES), every directory holding its own package manifest (a Go or Python service
 * in a JS workspace is no workspace member), every directory directly under an apps/, services/, packages/ or cmd/
 * folder at any depth (CONTAINER_DIRS: src/webapp/apps/api), and each top-level low-value folder (attic/, tests/);
 * without a declared or manifest root, also the directories under SOURCE_ROOTS. Nothing under a fixture or low-value
 * folder is a root of its own. A shard over MAX_SHARD_FILES is split by its subdirectories.
 *
 * Merging only ever joins related folders: a shard under MIN_SHARD_FILES merges with its smallest sibling (same parent
 * folder) when that parent is a CONTAINER_DIRS folder or neither is a service of its own (a subdirectory split off, a
 * SOURCE_ROOTS guess), else folds into the shard of the folder above it (the rest of the repo at the top); a tiny rest
 * of the repo takes in the smallest shard. While there are more than MAX_SHARDS, the two smallest siblings that may
 * merge are merged (else the smallest folds into the shard above it). 0.6.2 merged the smallest shards whatever they
 * were, so 27 of 40 shards of a big monorepo joined unrelated services. Sorted by key; empty when there are no paths.
 */
export function planShards(paths: string[], files: Record<string, string>): Shard[] {
  if (!paths.length) return [];
  const manifests = manifestDirsOf(paths);
  const declared = [...new Set([...workspaceRoots(paths, files), ...manifestRoots(paths, manifests)])];
  const services = new Set([...declared, ...containerRoots(paths, manifests)]);
  const roots = [...new Set(['', ...services, ...lowValueRoots(paths, manifests), ...(declared.length ? [] : sourceDirRoots(paths, manifests))])].sort((a, b) => b.length - a.length);
  const byRoot = new Map<string, string[]>();
  for (const p of paths) {
    const root = roots.find((r) => under(p, r))!;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(p);
  }
  const shards: Shard[] = [...byRoot].flatMap(([root, fs]) => split(root, fs)).map(([root, fs]) => ({ key: keyOf([root]), roots: [root], files: fs }));
  const order = (a: Shard, b: Shard) => a.files.length - b.files.length || cmp(a.key, b.key);
  const merge = (small: Shard, into: Shard) => {
    shards.splice(shards.indexOf(small), 1);
    const roots = [...into.roots, ...small.roots];
    shards.splice(shards.indexOf(into), 1, { key: keyOf(roots), roots, files: [...into.files, ...small.files] });
  };
  const first = (s: Shard) => s.roots[0];
  // The siblings it may merge with, smallest first: same parent folder, and that a container (apps/) or neither a service.
  const siblings = (s: Shard) => {
    if (first(s) === '') return [];
    const parent = parentOf(first(s));
    const container = CONTAINER_DIRS.has(parent.slice(parent.lastIndexOf('/') + 1));
    return shards.filter((o) => o !== s && first(o) !== '' && parentOf(first(o)) === parent && (container || (!services.has(first(s)) && !services.has(first(o)))));
  };
  // The shard holding the folder above it: the one with the longest root over its first root (the rest at the top).
  const above = (s: Shard) => {
    let best: Shard | null = null;
    let depth = -1;
    for (const o of shards) {
      if (o === s) continue;
      for (const r of o.roots) if (r !== first(s) && under(first(s), r) && r.length > depth) [best, depth] = [o, r.length];
    }
    return best;
  };
  // A tiny shard with nothing related to merge with (a lone top-level service, no rest of the repo) stays as it is.
  const alone = new Set<Shard>();
  for (;;) {
    shards.sort(order);
    const tiny = shards.find((s) => s.files.length < MIN_SHARD_FILES && !alone.has(s));
    if (!tiny || shards.length < 2) break;
    const into = first(tiny) === '' ? null : (siblings(tiny)[0] ?? above(tiny));
    if (first(tiny) === '') merge(shards.find((o) => o !== tiny)!, tiny);
    else if (into) merge(tiny, into);
    else alone.add(tiny);
  }
  while (shards.length > MAX_SHARDS) {
    shards.sort(order);
    let pair: [Shard, Shard] | null = null;
    for (const s of shards) {
      const sib = siblings(s)[0];
      if (sib && (!pair || s.files.length + sib.files.length < pair[0].files.length + pair[1].files.length)) pair = [s, sib];
    }
    const small = pair ? null : shards.find((s) => above(s));
    if (pair) merge(pair[0], pair[1]);
    else if (small) merge(small, above(small)!);
    else break;
  }
  return shards.sort((a, b) => cmp(a.key, b.key));
}

/** planShards over a repo on disk: reads the workspace files at its root (a missing one is simply not a workspace). */
export async function shardRepo(repoPath: string, paths: string[]): Promise<Shard[]> {
  const files: Record<string, string> = {};
  for (const name of WORKSPACE_FILES) {
    const text = await readFile(join(repoPath, name), 'utf8').catch(() => null);
    if (text !== null) files[name] = text;
  }
  return planShards(paths, files);
}
