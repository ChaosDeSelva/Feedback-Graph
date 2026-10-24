import { lstat } from 'node:fs/promises';
import { isGitDir, projectFolders, projectFromCwd, type CandidateSnapshot, type FolderCandidate, type Root } from '@fb/core';
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
    outsideRoots,
    codexSessionsFound: o.codexSessionsFound,
    folderOf,
  };
}
