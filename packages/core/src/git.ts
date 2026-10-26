import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/**
 * Repos under the roots are not ours: a crafted .git/config must not run fsmonitor commands (git status calls one),
 * hooks, an external diff or a signature program (log.showSignature runs gpg.program), and no attributes file outside
 * the repo applies. The system config is skipped (gitSafeEnv), so the container's safe.directory comes back here.
 * A command that reads the working tree (status) can still run a clean filter the repo's own attributes name:
 * filterOverrides switches every configured one off; the API's diff reader (api diff.ts) reads only committed objects.
 */
export const GIT_SAFE = [
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
  '-c', 'log.showSignature=false', '-c', 'diff.external=', '-c', 'safe.directory=*',
];

/** The environment for git on a repo that is not ours: no system or global config, no system attributes, no prompt. */
export function gitSafeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * `-c` options that switch off every filter driver the repo configures, from the output of
 * `git config -z --name-only --get-regexp '^filter\.'` (`filter.<name>.<key>` each ended by NUL, includes followed): an empty
 * clean and process command is no filter, and required=false keeps git from failing for want of one. A filter named in
 * .gitattributes but not configured runs nothing. Null when a name cannot be passed with -c (it holds `=` or a line
 * break): the caller then must not run a working-tree command at all.
 */
export function filterOverrides(configNames: string): string[] | null {
  const names = new Set<string>();
  for (const key of configNames.split('\0')) {
    if (!key) continue;
    if (!key.toLowerCase().startsWith('filter.')) continue;
    const name = key.slice('filter.'.length, key.lastIndexOf('.'));
    if (!name || key.lastIndexOf('.') < 'filter.'.length) continue;
    if (/[=\n\r]/.test(name)) return null;
    names.add(name);
  }
  return [...names].flatMap((n) => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
}

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

