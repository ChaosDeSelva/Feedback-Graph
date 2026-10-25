import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GIT_SAFE } from '../ingest/git.ts';

const run = promisify(execFile);

export type Churn = Map<string, { commits: number; lastTs: string }>;

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
      ...GIT_SAFE, '-C', repoPath, ...gitArgs, 'log', `--since=${since}`, '--no-merges', '-M', '--numstat', '-z', '--relative', `--format=${HEADER}%H%x09%cI`,
    ], { timeout: 60_000, maxBuffer: 256 * 1024 * 1024 }));
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
    if (!sha) return;
    let seen = shas.get(path);
    if (!seen) shas.set(path, (seen = new Set()));
    if (seen.has(sha)) return;
    seen.add(sha);
    const e = out.get(path);
    if (e) e.commits++;
    else out.set(path, { commits: 1, lastTs: ts });
  };

  // -z: "<header>\n<added>\t<deleted>\t<path>\0" per file; a rename has an empty path then "\0<old>\0<new>\0".
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    const h = t.indexOf(HEADER);
    if (h >= 0) {
      const line = t.slice(h + 1);
      const nl = line.indexOf('\n');
      const [s, iso] = (nl < 0 ? line : line.slice(0, nl)).split('\t');
      const d = new Date(iso);
      sha = s;
      ts = Number.isFinite(d.getTime()) ? d.toISOString() : iso;
      t = nl < 0 ? '' : line.slice(nl + 1);
    }
    t = t.replace(/^\n+/, '');
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(t);
    if (!m) continue;
    if (m[3]) {
      touch(current(m[3]));
    } else {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      if (oldPath === undefined || newPath === undefined) break;
      const now = current(newPath);
      currentName.set(oldPath, now);
      touch(now);
    }
  }
  return out;
}
