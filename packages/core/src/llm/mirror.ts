import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { GIT_SAFE, gitSafeEnv } from '../git.ts';
import { isSecretPath, SKIP_DIRS } from '../secrets.ts';

const run = promisify(execFile);
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 300_000_000;
const MAX_FILES = 50_000;

async function listFiles(repo: string): Promise<string[]> {
  try {
    const { stdout } = await run('git', [...GIT_SAFE, '-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard'], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      env: gitSafeEnv(),
    });
    return stdout.split('\n').filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (out.length >= MAX_FILES) return;
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name)) await walk(join(dir, d.name));
        } else if (d.isFile()) out.push(relative(repo, join(dir, d.name)));
      }
    };
    await walk(repo);
    return out;
  }
}

/**
 * A throwaway copy of `repo` for agents that cannot be denied individual files (Codex's read-only sandbox reads
 * anything): no secret files, no heavy or generated folders, no git metadata. The caller removes it with `dispose`.
 * This only keeps secrets out of the agent's cwd; it confines nothing. Absolute paths stay readable, which is why
 * codex-cli runs in the codex-runner sidecar (`parent` is its scratch volume, codexRunner.ts) or, inside the worker,
 * only with ALLOW_UNCONFINED_CODEX=1 (CODEX_UNCONFINED in providers.ts).
 */
export async function mirrorForAgent(repo: string, parent: string = tmpdir()): Promise<{ dir: string; files: number; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(parent, 'fb-mirror-'));
  let total = 0;
  let files = 0;
  for (const rel of (await listFiles(repo)).slice(0, MAX_FILES)) {
    if (isSecretPath(rel) || rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    // lstat, never stat: a tracked symlink (notes.txt -> ../.env, or -> /codex/auth.json) must not be followed.
    const s = await lstat(join(repo, rel)).catch(() => null);
    if (!s?.isFile() || s.size > MAX_FILE_BYTES || total + s.size > MAX_TOTAL_BYTES) continue;
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    if (await copyFile(join(repo, rel), join(dir, rel), constants.COPYFILE_EXCL).then(() => true, () => false)) {
      total += s.size;
      files++;
    }
  }
  return { dir, files, dispose: () => rm(dir, { recursive: true, force: true }) };
}
