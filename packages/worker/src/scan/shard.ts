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

/** Shards per repo at most: past this the smallest are merged, so a repo of 200 services is not 200 agent runs. */
export const MAX_SHARDS = 24;
/** A shard with fewer files than this is merged into the next smallest one: an agent run for two files is waste. */
export const MIN_SHARD_FILES = 5;
/** Directories whose children are taken as shards when the repo declares no workspace. */
const SOURCE_ROOTS = ['src', 'packages', 'services', 'apps', 'cmd'];

/** The workspace files planShards reads, from the repo root. */
export const WORKSPACE_FILES = ['pnpm-workspace.yaml', 'package.json', 'go.work', 'Cargo.toml'];

export const under = (path: string, root: string) => root === '' || path === root || path.startsWith(`${root}/`);
export const inScope = (path: string, s: ShardScope) => s.prefixes.some((r) => under(path, r)) && !s.except.some((r) => under(path, r));

/** Facts asked of a shard's agent run: 10 for a handful of files, growing with the square root, 60 at most. */
export const shardBudget = (files: number) => Math.min(60, Math.max(10, Math.round(4 * Math.sqrt(files))));

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
function sourceDirRoots(paths: string[]): string[] {
  const roots = new Set<string>();
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.length >= 3 && SOURCE_ROOTS.includes(segs[0])) roots.add(`${segs[0]}/${segs[1]}`);
  }
  return [...roots];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf = (roots: string[]) => roots.map((r) => r || '.').join('+');

/**
 * Split repo-relative `paths` into shards: workspace packages when the repo declares a workspace (`files` holds the
 * root's WORKSPACE_FILES), else the directories under SOURCE_ROOTS, else one shard. The smallest shards are merged
 * until none is under MIN_SHARD_FILES and there are at most MAX_SHARDS. Sorted by key; empty when there are no paths.
 */
export function planShards(paths: string[], files: Record<string, string>): Shard[] {
  if (!paths.length) return [];
  const declared = workspaceRoots(paths, files);
  const roots = ['', ...(declared.length ? declared : sourceDirRoots(paths))].sort((a, b) => b.length - a.length);
  const byRoot = new Map<string, string[]>();
  for (const p of paths) {
    const root = roots.find((r) => under(p, r))!;
    byRoot.set(root, [...(byRoot.get(root) ?? []), p]);
  }
  const shards: Shard[] = [...byRoot].map(([root, fs]) => ({ key: keyOf([root]), roots: [root], files: fs }));
  const order = (a: Shard, b: Shard) => a.files.length - b.files.length || cmp(a.key, b.key);
  for (;;) {
    shards.sort(order);
    if (shards.length < 2 || (shards.length <= MAX_SHARDS && shards[0].files.length >= MIN_SHARD_FILES)) break;
    const [small, into] = shards.splice(0, 2);
    const roots = [...into.roots, ...small.roots];
    shards.push({ key: keyOf(roots), roots, files: [...into.files, ...small.files] });
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
