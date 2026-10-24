import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from './types.ts';

/**
 * A project root (host and container side of one mount). `nested`: the git repos found one or two levels inside a
 * top-level folder that is not a repo itself (e.g. `github.com/org/repo` under ~/src), as paths relative to the root;
 * each is a project of its own. Set by discoverLayout (refreshLayout keeps it current); unset, every project is a
 * top-level folder.
 */
export type Root = { host: string; container: string; nested?: readonly string[] };

/** Between the segments of a nested project's key: `/` cannot be in a key (URLs, file names, env lists). */
export const NESTED_KEY_SEP = '__';

/** The project key of a folder at this path under its root: the folder name, or the segments joined by NESTED_KEY_SEP. */
export const keyOfRel = (rel: string) => rel.split('/').filter(Boolean).join(NESTED_KEY_SEP);

/** The folder (relative to the root) a project key names under this root: a nested repo's path, or the key itself. */
export function relOfKey(key: string, root: Root): string {
  return root.nested?.find((n) => keyOfRel(n) === key) ?? key;
}

const trim = (p: string) => p.replace(/\/+$/, '');

/** The project folder a path (relative to the root) is in: the deepest nested repo containing it, else its top-level folder. */
function projectRel(rest: string, root: Root): string | null {
  const top = rest.split('/')[0];
  if (!top) return null;
  let best = top;
  for (const n of root.nested ?? []) {
    if ((rest === n || rest.startsWith(`${n}/`)) && n.length > best.length) best = n;
  }
  return best;
}

/** The root a host cwd is under (the longest match) and the project folder in it, relative to that root. */
function locate(cwd: string, roots: Root[]): { root: Root; rel: string } | null {
  for (const root of [...roots].sort((a, b) => b.host.length - a.host.length)) {
    const prefix = trim(root.host) + '/';
    if (!cwd.startsWith(prefix)) continue;
    const rel = projectRel(cwd.slice(prefix.length), root);
    return rel ? { root, rel } : null;
  }
  return null;
}

/** Map a session's host cwd to its project: the deepest nested git repo it is in, else the top-level folder under its root. */
export function projectFromCwd(cwd: string, roots: Root[]): Project | null {
  const hit = locate(cwd, roots);
  if (!hit) return null;
  const key = keyOfRel(hit.rel);
  return { key, name: hit.rel, repoPath: `${trim(hit.root.container)}/${hit.rel}` };
}

/** The project's folder on the machine the session ran on (the host side of its root), for a session's host cwd. */
export function hostRepoPath(cwd: string, roots: Root[]): string | null {
  const hit = locate(cwd, roots);
  return hit ? `${trim(hit.root.host)}/${hit.rel}` : null;
}

/** Parse PROJECT_ROOTS / HOST_PROJECT_ROOTS (comma-separated, same order). */
export function rootsFromEnv(container: string, host: string): Root[] {
  const c = container.split(',').map((s) => s.trim()).filter(Boolean);
  const h = host.split(',').map((s) => s.trim()).filter(Boolean);
  if (c.length !== h.length) throw new Error('PROJECT_ROOTS and HOST_PROJECT_ROOTS must have the same length');
  return c.map((container, i) => ({ container, host: h[i] }));
}

/** A git work tree: `.git` is a directory, or a file for a worktree or submodule. Never followed if it is a link. */
export async function isGitDir(dir: string): Promise<boolean> {
  const s = await lstat(join(dir, '.git')).catch(() => null);
  return !!s && (s.isDirectory() || s.isFile());
}

/** Folders that are never searched for nested repos (dependency and build trees can be huge and hold vendored clones). */
const NOT_SEARCHED = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', '__pycache__']);
/** Per folder: a folder with more subfolders than this is not a tree of checkouts. */
const MAX_SUBDIRS = 500;

/**
 * Plain subfolders (no dot-folders, no links: dirent types come from lstat). `inside`: below a top-level folder, where
 * dependency trees are skipped and a folder with too many subfolders is not searched.
 */
async function subdirs(dir: string, inside = false): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name.startsWith('.') || (inside && NOT_SEARCHED.has(d.name))) continue;
    out.push(d.name);
    if (inside && out.length > MAX_SUBDIRS) return [];
  }
  return out.sort();
}

/**
 * The nested git repos under one root: inside each top-level folder that is not a git repo, the repos one level down
 * (~/code/client/app) or two (~/src/github.com/org/repo). A top-level folder with none stays a project itself.
 * `keepWhole`: top-level folders not to split (one already selected or excluded as a whole keeps meaning what it
 * meant). A nested key that equals a top-level folder's name is left out (the folder wins).
 */
export async function discoverNested(container: string, o: { keepWhole?: (topKey: string) => boolean } = {}): Promise<string[]> {
  const tops = await subdirs(container);
  const names = new Set(tops);
  const out: string[] = [];
  for (const top of tops) {
    if (o.keepWhole?.(top)) continue;
    const topDir = join(container, top);
    if (await isGitDir(topDir)) continue;
    for (const child of await subdirs(topDir, true)) {
      const rel = `${top}/${child}`;
      if (await isGitDir(join(container, rel))) {
        out.push(rel);
        continue;
      }
      for (const grand of await subdirs(join(container, rel), true)) {
        const deeper = `${rel}/${grand}`;
        if (await isGitDir(join(container, deeper))) out.push(deeper);
      }
    }
  }
  return out.filter((rel) => !names.has(keyOfRel(rel)));
}

/** Set each root's `nested` from its folders now (in place: every holder of these roots sees the new layout). */
export async function refreshLayout(roots: Root[], o: { keepWhole?: (topKey: string) => boolean } = {}): Promise<void> {
  for (const r of roots) r.nested = await discoverNested(r.container, o);
}

/** One project folder under a root: a top-level folder that holds no nested repos, or a nested repo. */
export type ProjectFolder = { key: string; rel: string; root: Root; container: string; host: string };

/**
 * Every project folder under the roots, by the layout the roots carry (refreshLayout): top-level folders, except
 * that a folder holding nested repos is replaced by those repos. First root wins a key. No dot-folders, no links.
 */
export async function projectFolders(roots: Root[]): Promise<ProjectFolder[]> {
  const out: ProjectFolder[] = [];
  const seen = new Set<string>();
  const add = (root: Root, rel: string) => {
    const key = keyOfRel(rel);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, rel, root, container: `${trim(root.container)}/${rel}`, host: `${trim(root.host || root.container)}/${rel}` });
  };
  for (const root of roots) {
    const containers = new Set((root.nested ?? []).map((n) => n.split('/')[0]));
    for (const top of await subdirs(root.container)) {
      if (!containers.has(top)) add(root, top);
    }
    for (const n of root.nested ?? []) add(root, n);
  }
  return out;
}
