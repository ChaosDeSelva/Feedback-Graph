import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateSnapshot, FolderCandidate, Root } from '@fb/core';
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
};

/**
 * The snapshot to store, plus each file's folder key for the ingest step: null when there is nothing in it to
 * ingest, a list for a Codex rollout that was in several folders.
 */
export type CandidateBuild = CandidateSnapshot & { folderOf: Map<string, string | string[] | null> };

const trim = (p: string) => p.replace(/\/+$/, '');

/** The top-level folder a cwd is in, by the same rule as projectFromCwd, and the root it is under. */
function folderOfCwd(cwd: string, roots: Root[]): { key: string; root: Root } | null {
  for (const root of [...roots].sort((a, b) => b.host.length - a.host.length)) {
    const prefix = trim(root.host) + '/';
    if (!cwd.startsWith(prefix)) continue;
    const key = cwd.slice(prefix.length).split('/')[0];
    return key ? { key, root } : null;
  }
  return null;
}

const shown = (root: Root) => trim(root.host || root.container);

async function isGit(dir: string): Promise<boolean> {
  // A worktree or submodule has a .git file; either counts. Never followed if it is a link.
  const s = await lstat(join(dir, '.git')).catch(() => null);
  return !!s && (s.isDirectory() || s.isFile());
}

/**
 * Every top-level folder under the roots, plus folders sessions ran in that are gone, each with its session counts.
 * Cheap: a file's cwd comes from its head, read once and cached. Sessions outside every root are only counted.
 */
export async function buildCandidates(o: CandidateOpts): Promise<CandidateBuild> {
  const remote = o.remote ?? projectRemote;
  const readHead = o.readHead ?? readSessionHead;
  const rows = new Map<string, FolderCandidate & { container: string }>();

  for (const root of o.roots) {
    for (const d of await readdir(root.container, { withFileTypes: true }).catch(() => [])) {
      // Dirent types come from lstat: a symlinked folder is not a directory here.
      if (!d.isDirectory() || d.name.startsWith('.') || rows.has(d.name)) continue;
      const container = `${trim(root.container)}/${d.name}`;
      rows.set(d.name, { key: d.name, path: `${shown(root)}/${d.name}`, exists: true, git: false, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null, container });
    }
  }

  const outsideRoots = { claudeSessions: 0, codexSessions: 0 };
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
      continue;
    }
    for (const { key, root } of at.values()) {
      let row = rows.get(key);
      if (!row) {
        row = { key, path: `${shown(root)}/${key}`, exists: false, git: false, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null, container: `${trim(root.container)}/${key}` };
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
      row.git = await isGit(container);
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
    outsideRoots,
    codexSessionsFound: o.codexSessionsFound,
    folderOf,
  };
}
