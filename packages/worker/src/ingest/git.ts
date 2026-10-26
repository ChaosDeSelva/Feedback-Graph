import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { GIT_SAFE, gitSafeEnv, normalizeRemote, redactSecrets, type Commit } from '@fb/core';

const run = promisify(execFile);

// Moved to core so the API reads diffs the same way; kept exported here for the worker's imports.
export { GIT_SAFE, gitSafeEnv, worktreeGitArgs } from '@fb/core';

export async function commitsInWindow(repoPath: string, from: string, to: string): Promise<Commit[]> {
  try {
    const { stdout } = await run('git', [
      ...GIT_SAFE, '-C', repoPath, 'log', '--all', '--since', from, '--until', to, '--format=%H%x09%cI%x09%s',
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
