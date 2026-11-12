import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
const helper = resolve(import.meta.dirname, '../../scripts/lib/api-settings.sh');
async function fixture(fn) { const root = await mkdtemp(join(tmpdir(), 'fg-api-settings-')); try { await mkdir(join(root, 'state/settings'), { recursive: true }); await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
const migrate = root => execFileSync('bash', ['-c', 'source "$FG_HELPER"; prepare_api_settings "$FG_ROOT"'], { env: { ...process.env, FG_HELPER: helper, FG_ROOT: root }, encoding: 'utf8', stdio: 'pipe' });

test('migration moves only API-owned files, preserves exact values, and is idempotent', async () => fixture(async root => {
  for (const name of ['project-roots.json', 'integrations.json', '.run-key-salt', 'worker-private.json']) await writeFile(join(root, 'state/settings', name), `original:${name}`);
  migrate(root); migrate(root);
  for (const name of ['project-roots.json', 'integrations.json', '.run-key-salt']) {
    expect(await readFile(join(root, 'state/api-settings', name), 'utf8')).toBe(`original:${name}`);
    expect((await stat(join(root, 'state/api-settings', name))).mode & 0o777).toBe(0o600);
  }
  expect(await readFile(join(root, 'state/settings/worker-private.json'), 'utf8')).toBe('original:worker-private.json');
  expect((await stat(join(root, 'state/api-settings'))).mode & 0o777).toBe(0o700);
}));

// The worker writes state/settings: once state/api-settings exists, a file there is never taken for a setting.
test('migration runs only into a new api settings folder: later files in state/settings are left where they are', async () => fixture(async root => {
  await mkdir(join(root, 'state/api-settings')); await writeFile(join(root, 'state/settings/integrations.json'), 'old'); await writeFile(join(root, 'state/api-settings/integrations.json'), 'new');
  await writeFile(join(root, 'state/settings/project-roots.json'), 'planted');
  migrate(root);
  expect(await readFile(join(root, 'state/settings/integrations.json'), 'utf8')).toBe('old');
  await expect(stat(join(root, 'state/api-settings/project-roots.json'))).rejects.toThrow();
  expect(await readFile(join(root, 'state/api-settings/integrations.json'), 'utf8')).toBe('new');
}));

test('migration never follows an unexpected settings symlink', async () => fixture(async root => {
  await writeFile(join(root, 'outside'), 'keep'); await symlink(join(root, 'outside'), join(root, 'state/settings/integrations.json'));
  expect(() => migrate(root)).toThrow(); expect(await readFile(join(root, 'outside'), 'utf8')).toBe('keep');
}));
