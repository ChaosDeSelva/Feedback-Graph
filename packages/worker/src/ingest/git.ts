import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { normalizeRemote, redactSecrets, type Commit } from '@fb/core';

const run = promisify(execFile);

/** Repos under the roots are not ours: a crafted .git/config must not run fsmonitor commands or hooks. */
export const GIT_SAFE = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null'];

/**
 * A git worktree's `.git` is a file whose `gitdir:` line names its git dir by the host's absolute path, which the
 * container does not see (git then says "not a git repository"). The `--git-dir`/`--work-tree` pair that reaches it
 * through the roots mapping (host prefix → container prefix), as global git options; [] when `.git` is a directory,
 * the named path is visible as it is (or relative), or it is under no root whose container side has it.
 */
export async function worktreeGitArgs(repoPath: string, roots: readonly { host: string; container: string }[]): Promise<string[]> {
  const dotGit = join(repoPath, '.git');
  const st = await lstat(dotGit).catch(() => null);
  if (!st?.isFile() || st.size > 4096) return [];
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''));
  const gitdir = m?.[1];
  if (!gitdir || !isAbsolute(gitdir) || (await lstat(gitdir).catch(() => null))?.isDirectory()) return [];
  for (const r of [...roots].sort((a, b) => b.host.length - a.host.length)) {
    const host = r.host.replace(/\/+$/, '');
    if (!host || !gitdir.startsWith(`${host}/`)) continue;
    const mapped = `${r.container.replace(/\/+$/, '')}${gitdir.slice(host.length)}`;
    if ((await lstat(mapped).catch(() => null))?.isDirectory()) return ['--git-dir', mapped, '--work-tree', repoPath];
  }
  return [];
}

export async function commitsInWindow(repoPath: string, from: string, to: string): Promise<Commit[]> {
  try {
    const { stdout } = await run('git', [
      ...GIT_SAFE, '-C', repoPath, 'log', '--all', '--since', from, '--until', to, '--format=%H%x09%cI%x09%s',
    ], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
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
      run('git', [...GIT_SAFE, '-C', repoPath, 'rev-parse', '--show-toplevel'], { timeout: 10_000 }),
      realpath(repoPath),
    ]);
    if (top.trim() !== real) return null;
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repoPath, 'config', '--local', '--get', 'remote.origin.url'], { timeout: 10_000 });
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
