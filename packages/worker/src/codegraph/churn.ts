import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GIT_SAFE, gitSafeEnv } from '../ingest/git.ts';

const run = promisify(execFile);

/** renames: each path a file had before a rename in the window, to the name it has now (git -M), when one was seen. */
export type Churn = Map<string, { commits: number; lastTs: string }> & { renames?: Record<string, string> };

const HEADER = '\x01';

/**
 * Commits per file over the last `sinceDays`, keyed by each file's current path: history from before a rename counts
 * toward the new name. Paths are relative to repoPath (a subdirectory of a repo sees only its own files).
 * Not a git repo, or git failing, gives an empty map. gitArgs: worktreeGitArgs, for a worktree whose git dir is mapped.
 */
export async function churn(repoPath: string, sinceDays: number, gitArgs: readonly string[] = []): Promise<Churn> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  let stdout: string;
  try {
    ({ stdout } = await run('git', [
      ...GIT_SAFE, '-C', repoPath, ...gitArgs, 'log', '--no-textconv', '--no-ext-diff', `--since=${since}`, '--no-merges', '-M', '--numstat', '-z', '--relative', `--format=${HEADER}%H%x09%cI`,
    ], { timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: gitSafeEnv() }));
  } catch {
    return new Map();
  }

  // Newest first: a rename seen now tells us what name older commits' paths have today.
  const currentName = new Map<string, string>();
  const current = (p: string) => currentName.get(p) ?? p;
  const shas = new Map<string, Set<string>>();
  const out: Churn = new Map();
  let sha = '';
  let ts = '';
  const touch = (path: string) => {
    let seen = shas.get(path);
    if (!seen) shas.set(path, (seen = new Set()));
    if (seen.has(sha)) return;
    seen.add(sha);
    const e = out.get(path);
    if (e) e.commits++;
    else out.set(path, { commits: 1, lastTs: ts });
  };

  // -z: "<header>\0\n<added>\t<deleted>\t<path>\0" per file; a rename has an empty path then "\0<old>\0<new>\0".
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // -z ends each header with \0 too, so a header is a token of its own.
    if (t.startsWith(HEADER)) {
      const [s, iso] = t.slice(1).split('\t');
      sha = s;
      ts = new Date(iso).toISOString();
      continue;
    }
    const m = /^\n*(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(t);
    if (!m) continue;
    if (m[3]) {
      touch(current(m[3]));
    } else {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      const now = current(newPath);
      currentName.set(oldPath, now);
      touch(now);
    }
  }
  out.renames = Object.fromEntries([...currentName].filter(([from, to]) => from !== to));
  return out;
}
