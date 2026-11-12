import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { expect, test } from 'vitest';
import { OwnerSessions } from './auth.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);

// scripts/restore.sh on a copy, restoring a Postgres backup with a stand-in docker that accepts every command, so only
// what the script does to state/ is exercised.
test('a restore refuses owner browser sessions issued before it, so an older revocation file cannot revive a signed-out one', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'fg-restore-'));
  const bin = join(repo, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), bin, join(repo, 'state', 'api-settings')]) mkdirSync(d, { recursive: true });
  for (const f of ['scripts/restore.sh', 'scripts/lib/store.sh', 'scripts/lib/env.sh', 'scripts/lib/json.sh', 'scripts/lib/restore-journal.sh', 'scripts/lib/state-fs.sh']) copyFileSync(join(repoRoot, f), join(repo, f));
  writeFileSync(join(repo, '.env'), 'STORE=postgres\nPOSTGRES_PASSWORD=pw\n');
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\ncase " $* " in *" config --format json "*) echo \'{"name":"t"}\' ;; *" df -Pk "*) printf \'F 1 0 1000000 0%% /d\\nF 1 0 1000000 0%% /d\\n\' ;; *" -i "* | *" exec -T "*) cat >/dev/null ;; esac\nexit 0\n');
  chmodSync(join(bin, 'docker'), 0o755);

  const file = join(repo, 'state', 'api-settings', 'owner-session-revocations.json');
  const key = 'k'.repeat(48);
  const cookie = new OwnerSessions(key, file).create();
  // The backup holds the revocation file as it was before the owner signed that browser out.
  writeFileSync(file, '{"notBefore":0,"revoked":{}}\n');
  const backup = join(repo, 'backups', 'b1');
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, 'postgres.dump'), 'dump');
  writeFileSync(join(backup, 'STORE'), 'postgres\n');
  await run('tar', ['-czf', join(backup, 'state.tgz'), 'state'], { cwd: repo });
  await run('sh', ['-c', 'shasum -a 256 postgres.dump state.tgz STORE > SHA256SUMS'], { cwd: backup });
  new OwnerSessions(key, file).remove(cookie);
  expect(new OwnerSessions(key, file).has(cookie)).toBe(false);

  await run('bash', [join(repo, 'scripts', 'restore.sh'), backup], { cwd: repo, env: { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`, FORCE: '1' } });
  const after = new OwnerSessions(key, file);
  expect(after.has(cookie)).toBe(false);
  // Signing in again works.
  expect(after.has(after.create(Date.now() + 1000), Date.now() + 1000)).toBe(true);
  rmSync(repo, { recursive: true, force: true });
}, SCRIPT_TEST_TIMEOUT_MS);

test('without a terminal and without FORCE=1 it says why it refuses, and changes nothing', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'fg-restore-'));
  const bin = join(repo, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), bin, join(repo, 'state')]) mkdirSync(d, { recursive: true });
  for (const f of ['scripts/restore.sh', 'scripts/lib/store.sh', 'scripts/lib/env.sh', 'scripts/lib/json.sh', 'scripts/lib/restore-journal.sh', 'scripts/lib/state-fs.sh']) copyFileSync(join(repoRoot, f), join(repo, f));
  writeFileSync(join(repo, '.env'), 'STORE=postgres\nPOSTGRES_PASSWORD=pw\n');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> '${join(repo, 'docker-calls')}'\nexit 0\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const backup = join(repo, 'backups', 'b1');
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, 'postgres.dump'), 'dump');
  writeFileSync(join(backup, 'STORE'), 'postgres\n');
  await run('tar', ['-czf', join(backup, 'state.tgz'), 'state'], { cwd: repo });
  await run('sh', ['-c', 'shasum -a 256 postgres.dump state.tgz STORE > SHA256SUMS'], { cwd: backup });

  const r = await execResult('bash', [join(repo, 'scripts', 'restore.sh'), backup], { cwd: repo, env: { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}` } });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`not restoring: there is no terminal to ask whether to replace the current postgres store and worker state; run FORCE=1 ./scripts/restore.sh ${backup}`);
  expect(existsSync(join(repo, 'docker-calls')) ? readFileSync(join(repo, 'docker-calls'), 'utf8') : '').not.toMatch(/stop|restore|exec/);
  rmSync(repo, { recursive: true, force: true });
}, SCRIPT_TEST_TIMEOUT_MS);
