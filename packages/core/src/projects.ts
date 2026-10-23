import type { Project } from './types.ts';

export type Root = { host: string; container: string };

/** Map a session's host cwd to the top-level project dir under one of the roots. */
export function projectFromCwd(cwd: string, roots: Root[]): Project | null {
  for (const root of [...roots].sort((a, b) => b.host.length - a.host.length)) {
    const prefix = root.host.replace(/\/+$/, '') + '/';
    if (!cwd.startsWith(prefix)) continue;
    const key = cwd.slice(prefix.length).split('/')[0];
    if (!key) return null;
    return { key, name: key, repoPath: `${root.container.replace(/\/+$/, '')}/${key}` };
  }
  return null;
}

/** The project's folder on the machine the session ran on (the host side of its root), for a session's host cwd. */
export function hostRepoPath(cwd: string, roots: Root[]): string | null {
  for (const root of [...roots].sort((a, b) => b.host.length - a.host.length)) {
    const prefix = root.host.replace(/\/+$/, '') + '/';
    if (!cwd.startsWith(prefix)) continue;
    const key = cwd.slice(prefix.length).split('/')[0];
    return key ? prefix + key : null;
  }
  return null;
}

/** Parse PROJECT_ROOTS / HOST_PROJECT_ROOTS (comma-separated, same order). */
export function rootsFromEnv(container: string, host: string): Root[] {
  const c = container.split(',').map((s) => s.trim()).filter(Boolean);
  const h = host.split(',').map((s) => s.trim()).filter(Boolean);
  if (c.length !== h.length) throw new Error('PROJECT_ROOTS and HOST_PROJECT_ROOTS must have the same length');
  return c.map((container, i) => ({ container, host: h[i] }));
}
