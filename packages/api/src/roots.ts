import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The project roots the owner saved in Settings, as host paths. The api writes them; scripts/setup.sh reads them,
 * mounts exactly these folders (docker-compose.override.yml) and restarts the containers. Saved is not mounted: the
 * mounted roots are PROJECT_ROOTS / HOST_PROJECT_ROOTS.
 */
export type SavedRoots = { roots: string[]; updatedAt: string };

export type RootsStore = {
  /** Null when nothing was saved yet (or the file is damaged). */
  read(): Promise<SavedRoots | null>;
  write(roots: string[]): Promise<SavedRoots>;
};

/** At most this many roots: each is a bind mount on every service that reads projects. */
export const MAX_ROOTS = 20;

/** Characters a root cannot hold: `:` splits a Docker mount, `,` the env lists, the rest break .env lines and shells. */
// eslint-disable-next-line no-control-regex -- Deliberately reject or strip control bytes at this boundary.
const FORBIDDEN = /[:|\\"$,\u0000-\u001f\u007f]/;

const trimSlash = (p: string) => p.replace(/\/+$/, '') || '/';

/** Check and tidy roots typed in Settings: absolute, mountable, deduped in order. `~` is the host's home (HOST_HOME). */
export function normalizeRoots(input: string[], hostHome: string | null): { roots: string[] } | { error: string } {
  const out: string[] = [];
  const home = hostHome ? trimSlash(hostHome) : null;
  for (const raw of input) {
    let p = raw.trim();
    if (!p) continue;
    if (home && (p === '~' || p.startsWith('~/'))) p = home + p.slice(1);
    if (!p.startsWith('/')) return { error: `${p}: give an absolute path (starting with /${home ? ' or ~/' : ''})` };
    if (FORBIDDEN.test(p)) return { error: `${p}: a project folder path cannot contain : | \\ " $ , or control characters (Docker mounts and .env use them)` };
    p = trimSlash(p.replace(/\/{2,}/g, '/'));
    if (p.split('/').some((s) => s === '.' || s === '..')) return { error: `${p}: write the path without . or .. parts` };
    if (p === '/') return { error: 'the whole disk (/) cannot be a project folder: choose the folder that holds your projects' };
    if (p === home) return { error: `${p} is your home folder: choose the folder that holds your projects (containers see only the folders you choose)` };
    if (p.length > 1024) return { error: `${p.slice(0, 40)}...: path too long` };
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_ROOTS) return { error: `at most ${MAX_ROOTS} project folders (got ${out.length})` };
  return { roots: out };
}

/** The roots file (ROOTS_FILE, in the api's writable settings folder). Written whole: a temp file renamed over it. */
export function rootsFile(path: string, now: () => string = () => new Date().toISOString()): RootsStore {
  return {
    async read() {
      const text = await readFile(path, 'utf8').catch(() => null);
      if (text === null) return null;
      try {
        const j = JSON.parse(text) as { roots?: unknown; updatedAt?: unknown };
        if (!Array.isArray(j.roots) || !j.roots.every((r) => typeof r === 'string')) return null;
        return { roots: j.roots as string[], updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : '' };
      } catch {
        return null;
      }
    },
    async write(roots) {
      const saved: SavedRoots = { roots, updatedAt: now() };
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp.${process.pid}`;
      // Pretty-printed, one root per line: scripts/setup.sh reads it without Node.
      await writeFile(tmp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o644 });
      await rename(tmp, path);
      return saved;
    },
  };
}
