import { lstat } from 'node:fs/promises';
import { posix } from 'node:path';
import { isGitDir, projectFolders, projectFromCwd, type CandidateSnapshot, type FolderCandidate, type OutsideFolder, type Root } from '@fb/core';
import { projectRemote } from '../ingest/git.ts';
import type { FileState } from '../state.ts';
import { cachedHead, codexCwds, readSessionHead, type HeadFile, type SessionHead } from './heads.ts';

export type CandidateOpts = {
  roots: Root[];
  /** Claude Code transcripts and Codex rollout files, already listed (symlinks left out). */
  files: HeadFile[];
  state: FileState;
  codexSessionsFound: boolean;
  remote?: (repoPath: string) => Promise<string | null>;
  readHead?: (path: string, source: HeadFile['source']) => Promise<SessionHead>;
  /**
   * The existing project a folder (not a project itself) is another clone of, by its remote
   * (GraphStore.canonicalProject with dryRun). Set: each git folder's row says so in `cloneOf`.
   */
  cloneOf?: (folder: { key: string; repoPath: string; remote: string }) => Promise<string | null>;
  now?: () => string;
  /** The host's home folder (HOST_HOME): never suggested as a root. */
  hostHome?: string;
};

/** How many parent folders of out-of-root sessions are suggested as roots. */
export const MAX_SUGGESTED_ROOTS = 8;

/** Temporary folders: sessions there are throwaway runs, never a projects folder. */
const TEMP = /^\/(private\/)?(tmp|var)(\/|$)/;

/**
 * The folder to suggest as a root for a session that ran outside every root: its cwd's parent, so the cwd becomes a
 * project under it. Null for a parent inside a dot-folder (~/.config) or an agent's worktrees, a temporary folder, the
 * home folder itself, and folders too near the top of the disk to be a projects folder (/, /Users, /tmp).
 */
export function suggestedRoot(cwd: string, hostHome = ''): string | null {
  const parent = posix.dirname(trim(cwd) || '/');
  const parts = parent.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p.startsWith('.') || p === 'worktrees') || TEMP.test(parent)) return null;
  if (parent === trim(hostHome) || /^\/(Users|home)\/[^/]+$/.test(parent)) return null;
  return parent;
}

/**
 * A suggestion inside another suggestion is covered by it (one root there brings in both): its sessions count toward
 * the outermost one, and it is not suggested on its own.
 */
function foldNested(folders: OutsideFolder[]): OutsideFolder[] {
  const outer = folders.filter((f) => !folders.some((o) => o !== f && f.path.startsWith(`${o.path}/`)));
  return outer.map((o) => {
    const inside = folders.filter((f) => f === o || f.path.startsWith(`${o.path}/`));
    return {
      path: o.path,
      claudeSessions: inside.reduce((n, f) => n + f.claudeSessions, 0),
      codexSessions: inside.reduce((n, f) => n + f.codexSessions, 0),
    };
  });
}

/** Side-by-side suggestions from this many up are offered as the folder holding them (dated Codex workspaces...). */
const SIBLINGS = 3;

/** Three or more suggestions in one folder become that folder, when it could be a root itself. */
function groupSiblings(folders: OutsideFolder[], hostHome = ''): OutsideFolder[] {
  const byParent = new Map<string, OutsideFolder[]>();
  for (const f of folders) {
    const parent = posix.dirname(f.path);
    byParent.set(parent, [...(byParent.get(parent) ?? []), f]);
  }
  return [...byParent].flatMap(([parent, group]) =>
    group.length >= SIBLINGS && suggestedRoot(`${parent}/x`, hostHome) === parent
      ? [{
        path: parent,
        claudeSessions: group.reduce((n, f) => n + f.claudeSessions, 0),
        codexSessions: group.reduce((n, f) => n + f.codexSessions, 0),
      }]
      : group);
}

/**
 * The snapshot to store, plus each file's folder key for the ingest step: null when there is nothing in it to
 * ingest, a list for a Codex rollout that was in several folders.
 */
export type CandidateBuild = CandidateSnapshot & { folderOf: Map<string, string | string[] | null> };

const trim = (p: string) => p.replace(/\/+$/, '');

/** The project folder a cwd is in, by projectFromCwd (nested repos included), and the root it is under. */
function folderOfCwd(cwd: string, roots: Root[]): { key: string; rel: string; root: Root } | null {
  const p = projectFromCwd(cwd, roots);
  if (!p) return null;
  const root = [...roots].sort((a, b) => b.host.length - a.host.length).find((r) => cwd.startsWith(trim(r.host) + '/'))!;
  return { key: p.key, rel: p.name, root };
}

const shown = (root: Root) => trim(root.host || root.container);

/**
 * Every project folder under the roots (top-level folders, and the git repos nested in folders that are not repos,
 * by the layout the roots carry), plus folders sessions ran in that are gone, each with its session counts.
 * Cheap: a file's cwd comes from its head, read once and cached. Sessions outside every root are only counted.
 */
export async function buildCandidates(o: CandidateOpts): Promise<CandidateBuild> {
  const remote = o.remote ?? projectRemote;
  const readHead = o.readHead ?? readSessionHead;
  const rows = new Map<string, FolderCandidate & { container: string }>();

  for (const f of await projectFolders(o.roots)) {
    rows.set(f.key, { key: f.key, path: f.host, exists: true, git: false, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null, container: f.container });
  }

  const outsideRoots = { claudeSessions: 0, codexSessions: 0 };
  const outside = new Map<string, OutsideFolder>();
  const folderOf = new Map<string, string | string[] | null>();
  for (const f of o.files) {
    const head = await cachedHead(o.state, f, readHead);
    if (!head.human || !head.cwd) {
      folderOf.set(f.path, null);
      continue;
    }
    // A Codex session can move between folders (turn_context): it belongs to each folder it was in.
    const cwds = f.source === 'codex' ? [head.cwd, ...(await codexCwds(o.state, f))] : [head.cwd];
    const at = new Map<string, NonNullable<ReturnType<typeof folderOfCwd>>>();
    for (const cwd of cwds) {
      const hit = folderOfCwd(cwd, o.roots);
      if (hit && !at.has(hit.key)) at.set(hit.key, hit);
    }
    const keys = [...at.keys()];
    folderOf.set(f.path, keys.length === 0 ? null : keys.length === 1 ? keys[0] : keys);
    const count = f.source === 'codex' ? 'codexSessions' : 'claudeSessions';
    if (!keys.length) {
      outsideRoots[count]++;
      const parent = suggestedRoot(head.cwd, o.hostHome);
      if (parent) {
        const row = outside.get(parent) ?? { path: parent, claudeSessions: 0, codexSessions: 0 };
        row[count]++;
        outside.set(parent, row);
      }
      continue;
    }
    for (const { key, rel, root } of at.values()) {
      let row = rows.get(key);
      if (!row) {
        // Gone, or a folder that holds nested repos where a session ran outside all of them (it is still a project).
        const container = `${trim(root.container)}/${rel}`;
        const exists = !!(await lstat(container).catch(() => null))?.isDirectory();
        row = { key, path: `${shown(root)}/${rel}`, exists, git: false, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null, container };
        rows.set(key, row);
      }
      row[count]++;
      const ts = new Date(f.mtimeMs).toISOString();
      if (!row.lastActivity || ts > row.lastActivity) row.lastActivity = ts;
    }
  }

  const candidates: FolderCandidate[] = [];
  for (const { container, ...row } of [...rows.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    if (row.exists) {
      row.git = await isGitDir(container);
      row.remote = row.git ? await remote(container) : null;
    }
    if (o.cloneOf) {
      const of = row.remote ? await o.cloneOf({ key: row.key, repoPath: container, remote: row.remote }).catch(() => null) : null;
      row.cloneOf = of && of !== row.key ? of : null;
    }
    candidates.push(row);
  }

  return {
    builtAt: o.now?.() ?? new Date().toISOString(),
    roots: o.roots.map(shown),
    candidates,
    outsideRoots: {
      ...outsideRoots,
      folders: foldNested(groupSiblings(foldNested([...outside.values()]), o.hostHome))
        .sort((a, b) => b.claudeSessions + b.codexSessions - (a.claudeSessions + a.codexSessions) || a.path.localeCompare(b.path))
        .slice(0, MAX_SUGGESTED_ROOTS),
    },
    codexSessionsFound: o.codexSessionsFound,
    folderOf,
  };
}
