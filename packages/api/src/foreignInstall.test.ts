import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { expect, test, vi } from 'vitest';
import { sandbox } from './testing/restoreSandbox.ts';

// backup.sh and restore.sh refuse before touching anything when the containers under this checkout's name are another folder's,
// or the environment names another install than .env does.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });

test('backup and restore refuse to act when this name\'s containers were started from another folder, before any docker compose call', async () => {
  const s = sandbox();
  await s.make();
  for (const name of ['backup.sh', 'restore.sh']) {
    const r = name === 'restore.sh' ? await s.restore({ STARTED_IN: '/srv/other/feedback-graph' }) : await s.script(name, [], { STARTED_IN: '/srv/other/feedback-graph' });
    expect(r.code, name).toBe(1);
    expect(r.err, name).toContain('the containers named t were started from /srv/other/feedback-graph, not this folder');
    expect(s.ran(), name).not.toContain('docker compose');
  }
  expect(s.which()).toBe('live');
  expect(existsSync(join(s.repo, '.restore'))).toBe(false);
  // Its own folder's containers are no reason to refuse.
  expect((await s.restore({ STARTED_IN: s.repo })).code).toBe(0);
  expect(s.which()).toBe('backup');
});

test('a leftover one-off container (a killed backup\'s, with no folder label) does not hide that another folder runs this name', async () => {
  const s = sandbox();
  await s.make();
  const other = { STARTED_IN: '/srv/other/feedback-graph', LEFTOVER: '', DOCKER_INFO: '1' };
  for (const name of ['backup.sh', 'restore.sh']) {
    const r = name === 'restore.sh' ? await s.restore(other) : await s.script(name, [], other);
    expect(r.code, name).toBe(1);
    expect(r.err, name).toContain('the containers named t were started from /srv/other/feedback-graph, not this folder');
  }
  expect(s.ran()).not.toContain('docker compose');
  expect((await s.script('doctor.sh', [], other)).out).toContain('FAIL  install: the containers named t were started from /srv/other/feedback-graph, not this folder');
  expect((await s.script('fg', ['status'], other)).err).toContain('WARNING: the containers named t were started from /srv/other/feedback-graph, not this folder');
  // One that names this folder (as backup.sh and restore.sh now label theirs) is no reason to refuse.
  expect((await s.restore({ STARTED_IN: s.repo, LEFTOVER: '/srv/other/feedback-graph' })).code).toBe(0);
  expect(s.which()).toBe('backup');
  // The one-off containers a backup and a restore run name the folder they were started from.
  await s.make();
  expect((await s.script('backup.sh')).code).toBe(0);
  expect((await s.restore()).code).toBe(0);
  const oneoffs = s.ran().split('\n').filter((l) => /^docker (run|create) /.test(l));
  expect(oneoffs.length).toBeGreaterThan(2);
  for (const l of oneoffs) expect(l).toContain(`--label com.docker.compose.project.working_dir=${s.repo} --label com.docker.compose.oneoff=True`);
});

test('.env decides the install: a different FG_INSTANCE in the environment stops backup, restore, doctor and fg; the same one does not', async () => {
  const s = sandbox();
  await s.make();
  for (const name of ['backup.sh', 'restore.sh', 'doctor.sh', 'fg']) {
    const r = await s.script(name, name === 'restore.sh' ? ['backups/b1'] : name === 'fg' ? ['status'] : [], { FG_INSTANCE: 'other' });
    expect(r.code, name).toBe(1);
    expect(r.out + r.err, name).toContain('FG_INSTANCE=other in your environment is not this checkout\'s install (t, from');
  }
  expect(s.ran()).not.toContain('compose');
  expect((await s.restore({ FG_INSTANCE: 't' })).code).toBe(0);
});

test('setup and install-agent stop too when the environment names another install than the .env', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const repo = mkdtempSync(join(tmpdir(), 'fg-instance-env-'));
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  for (const f of ['setup.sh', 'install-agent.sh', 'lib/env.sh', 'lib/ollama.sh', 'lib/runner-apparmor.sh', 'lib/api-settings.sh', 'lib/state-fs.sh']) copyFileSync(join(root, 'scripts', f), join(repo, 'scripts', f));
  writeFileSync(join(repo, '.env'), 'FG_INSTANCE=t\n');
  for (const script of ['setup.sh', 'install-agent.sh']) {
    const r = await execResult('bash', [join(repo, 'scripts', script)], { cwd: repo, env: { PATH: '/usr/bin:/bin', HOME: repo, FG_INSTANCE: 'other' } });
    expect(r.status, script).toBe(1);
    expect(r.stderr, script).toContain("FG_INSTANCE=other in your environment is not this checkout's install (t, from");
  }
});
