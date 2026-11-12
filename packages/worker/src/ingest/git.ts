import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { GIT_SAFE, gitSafeEnv, normalizeRemote, redactSecrets, type Commit } from '@fb/core';

const run = promisify(execFile);

// Moved to core so the API reads diffs the same way; kept exported here for the worker's imports.
export { GIT_SAFE, gitSafeEnv, worktreeGitArgs } from '@fb/core';

/** The first of these refs the repository has, or null (a branch deleted since, or never fetched here). */
async function firstRef(repoPath: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const ok = await run('git', [...GIT_SAFE, '-C', repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeout: 10_000, env: gitSafeEnv() }).then(() => true, () => false);
    if (ok) return ref;
  }
  return null;
}

const toplevel = (dir: string) => run('git', [...GIT_SAFE, '-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 10_000, env: gitSafeEnv() }).then((r) => r.stdout.trim(), () => null);

/** `dir` when it is a worktree of its own (its top is not the repository's): a subfolder's HEAD is the checkout's now. */
async function ownWorktree(repoPath: string, dir: string): Promise<string | null> {
  const [top, main] = await Promise.all([toplevel(dir), toplevel(repoPath)]);
  return top && main && top !== main ? dir : null;
}

/**
 * The commits made in the window that the session can have made: those on its branch (a local branch, else the
 * remote's) or, with no branch known, on the HEAD of the worktree it ran in (`worktree`, a folder inside the repo or a
 * worktree of it). Neither known: every branch's (`--all`), as before. Other branches' commits in the same hours are
 * someone else's work, and DURING them tied a session to every PR merged while it ran.
 */
export async function commitsInWindow(repoPath: string, from: string, to: string, o: { branch?: string | null; worktree?: string | null } = {}): Promise<Commit[]> {
  try {
    const branch = o.branch?.trim() && !o.branch.includes('..') ? await firstRef(repoPath, [`refs/heads/${o.branch.trim()}`, `refs/remotes/origin/${o.branch.trim()}`]) : null;
    const tree = !branch && o.worktree ? await ownWorktree(repoPath, o.worktree) : null;
    const where = branch ? ['-C', repoPath, 'log', branch] : tree ? ['-C', tree, 'log', 'HEAD'] : ['-C', repoPath, 'log', '--all'];
    const { stdout } = await run('git', [
      ...GIT_SAFE, ...where, '--since', from, '--until', to, '--format=%H%x09%cI%x09%s', '--',
    ], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: gitSafeEnv() });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ts, ...subject] = line.split('\t');
        const d = new Date(ts);
        // UTC, like turn timestamps; an unparseable date keeps its text rather than losing every commit.
        return { sha, ts: Number.isFinite(d.getTime()) ? d.toISOString() : ts, subject: subject.join('\t') };
      });
  } catch {
    return [];
  }
}

/**
 * The canonical origin of the repo rooted exactly at repoPath, or null. A folder inside another repo (a demo app
 * kept in the tool's own repo) is not that repo's clone, so it gets no remote rather than its parent's.
 */
export async function projectRemote(repoPath: string): Promise<string | null> {
  try {
    if (!(await lstat(repoPath)).isDirectory()) return null;
    const [{ stdout: top }, real] = await Promise.all([
      run('git', [...GIT_SAFE, '-C', repoPath, 'rev-parse', '--show-toplevel'], { timeout: 10_000, env: gitSafeEnv() }),
      realpath(repoPath),
    ]);
    if (top.trim() !== real) return null;
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'config', '--local', '--get', 'remote.origin.url'], { timeout: 10_000, env: gitSafeEnv() });
    const id = normalizeRemote(stdout);
    // An id the redactor would alter looks like a secret: no remote beats storing it, or a mangled one that collides.
    return id && redactSecrets(id) === id ? id : null;
  } catch {
    return null;
  }
}

/** A remote rarely changes: re-reading it for every transcript change and every backfill pass would run git each cycle. */
export function cachedRemote(read: (repoPath: string) => Promise<string | null>, ttlMs: number, now = Date.now) {
  const cache = new Map<string, { at: number; remote: string | null }>();
  return async (repoPath: string): Promise<string | null> => {
    const hit = cache.get(repoPath);
    if (hit && now() - hit.at <= ttlMs) return hit.remote;
    const remote = await read(repoPath);
    cache.set(repoPath, { at: now(), remote });
    return remote;
  };
}
