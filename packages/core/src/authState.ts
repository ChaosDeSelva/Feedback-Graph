import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Whether the API runs with an owner or API token, as the API itself decides it (the trimmed API_TOKEN or FG_OWNER_TOKEN
 * of loadConfig): only then can the owner review, pause and roll back what the learning loop does. The worker holds
 * neither token, so the API writes this answer to AUTH_STATE_FILE_NAME in its settings folder, and the worker reads it
 * there (AUTH_STATE_FILE) each round: the two never disagree, as they did when compose derived the worker's flag from
 * the raw values (a token of spaces was set for compose and none for the API).
 */
export const apiAuthConfigured = (c: { apiToken: string | null; ownerToken: string | null }) => !!(c.apiToken || c.ownerToken);

export const AUTH_STATE_FILE_NAME = 'auth-state.json';
/**
 * The API rewrites the file this often while it listens and its store answers; an answer older than
 * AUTH_STATE_STALE_MS is from an API that stopped, crash-loops or lost its store, which nobody can review the loop in.
 */
export const AUTH_STATE_BEAT_MS = 30_000;
export const AUTH_STATE_STALE_MS = 4 * AUTH_STATE_BEAT_MS;

/**
 * The file in the API's settings folder (beside ROOTS_FILE or INTEGRATIONS_FILE, as service.ts keeps them), read from
 * the environment as loadConfig reads it, so the API can write it before anything that can fail.
 */
export const apiAuthStateFile = (env: NodeJS.ProcessEnv, cwd = process.cwd()) =>
  join(dirname(env.ROOTS_FILE?.trim() || env.INTEGRATIONS_FILE?.trim() || join(cwd, 'state/settings/project-roots.json')), AUTH_STATE_FILE_NAME);

/**
 * Replaces the file whole (a new file renamed over it), so a reader never sees half of it and no link there is followed;
 * `at` is when the API last vouched for the answer.
 */
export async function writeAuthState(file: string, configured: boolean, now = Date.now()): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ configured, at: new Date(now).toISOString() })}\n`, { flag: 'wx', mode: 0o644 });
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * What the API wrote, while it still vouches for it (written within AUTH_STATE_STALE_MS); false when it has not written
 * it yet, or stopped renewing it, so the loop observes at most.
 */
export async function readAuthState(file: string, now = Date.now()): Promise<boolean> {
  try {
    const s = JSON.parse(await readFile(file, 'utf8')) as { configured?: unknown; at?: unknown };
    const at = typeof s.at === 'string' ? Date.parse(s.at) : NaN;
    return s.configured === true && now - at < AUTH_STATE_STALE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
