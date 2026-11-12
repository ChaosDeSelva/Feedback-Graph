import { lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSecretPath } from '@fb/core';

/** The instruction files agents read, in the order listed within one folder. */
export const AGENT_DOC_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * The AGENTS.md and CLAUDE.md files on the path from the repo root to each of `files` (repo-relative), nearest first:
 * the deepest folder's before its parents', the root's last. A named folder counts as on its own path (its AGENTS.md
 * governs all of it). A file reached twice (two named files in one folder, a CLAUDE.md that links to the AGENTS.md
 * beside it) is listed once, under its first name. Only regular files or links that stay inside the repo and are not a
 * secret file (`AGENTS.md -> ../.env` would send an agent to read it) count; nothing is read but their existence.
 */
export async function agentDocsFor(repoPath: string, files: string[]): Promise<string[]> {
  const root = await realpath(repoPath).catch(() => null);
  if (!root) return [];
  const dirs = new Map<string, number>();
  for (const raw of files) {
    const f = raw.replace(/\/+$/, '');
    const folder = await stat(join(root, f)).then((st) => st.isDirectory(), () => false);
    const segs = folder ? f.split('/') : f.split('/').slice(0, -1);
    for (let i = segs.length; i >= 0; i--) {
      const dir = segs.slice(0, i).join('/');
      if (!dirs.has(dir)) dirs.set(dir, i);
    }
  }
  // Deepest first; one depth in path order, so the answer does not depend on the order files were named in.
  const ordered = [...dirs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([dir]) => dir);
  const found = await Promise.all(ordered.flatMap((dir) => AGENT_DOC_NAMES.map(async (name) => {
    const rel = dir ? `${dir}/${name}` : name;
    const st = await lstat(join(root, rel)).catch(() => null);
    if (!st || !(st.isFile() || st.isSymbolicLink())) return null;
    const real = await realpath(join(root, rel)).catch(() => null);
    if (!real || !real.startsWith(`${root}/`) || isSecretPath(real.slice(root.length + 1)) || !(await lstat(real)).isFile()) return null;
    return { rel, real };
  })));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of found) {
    if (!x || seen.has(x.real)) continue;
    seen.add(x.real);
    out.push(x.rel);
  }
  return out;
}
