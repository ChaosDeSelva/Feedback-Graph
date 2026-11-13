import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';

// The worker mounts ./state read-write, so a compromised container can leave a link, a FIFO or a folder anywhere under
// it. Each host script that writes or reads there is run on a copy, with a link planted where it writes or reads, and a
// "host file" outside state/ that the link names: it must be left as it was, and never read into state/ or the output.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const LIBS = ['env.sh', 'json.sh', 'ollama.sh', 'runner-apparmor.sh', 'api-settings.sh', 'restore-journal.sh', 'store.sh', 'state-fs.sh'];

function world() {
  const base = mkdtempSync(join(tmpdir(), 'fglinks-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), join(home, 'code'), bin]) mkdirSync(d, { recursive: true });
  for (const f of ['setup.sh', 'doctor.sh', 'restore.sh', 'backup.sh', 'fg', ...LIBS.map((l) => `lib/${l}`)]) copyFileSync(join(repoRoot, 'scripts', f), join(repo, 'scripts', f));
  copyFileSync(join(repoRoot, '.env.example'), join(repo, '.env.example'));
  writeFileSync(join(repo, 'scripts', 'install-agent.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(repo, 'scripts', 'install-agent.sh'), 0o755);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('uname', 'echo Darwin');
  stub('curl', `case "$*" in *api/status*) echo '{}' ;; *) exit 7 ;; esac`);
  stub('nc', 'exit 1');
  stub('docker', 'exit 0');
  /** A file outside state/ that a planted link names. */
  const hostFile = (name: string, text: string) => {
    const p = join(base, name);
    writeFileSync(p, text);
    return p;
  };
  const plant = (rel: string, target: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    symlinkSync(target, join(repo, rel));
  };
  const run = async (script: string, args: string[] = [], env: Record<string, string> = {}) => {
    const r = await execResult('bash', [join(repo, 'scripts', script), ...args], {
      cwd: repo,
      env: { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`, HOME: home, PROJECTS_DIRS: join(home, 'code'), ...env },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { base, repo, home, stub, hostFile, plant, run };
}

test('setup never writes its lock owner through a link a container left in state/; its lock is in .host/, and a lock left in state/ goes', async () => {
  const w = world();
  const canary = w.hostFile('canary', 'host file\n');
  w.plant('state/.setup.lock/pid', canary);
  expect((await w.run('setup.sh')).code).toBe(0);
  expect(readFileSync(canary, 'utf8')).toBe('host file\n');
  expect(existsSync(join(w.repo, 'state', '.setup.lock'))).toBe(false);
  expect(existsSync(join(w.repo, '.host', 'setup.lock'))).toBe(false);
});

test('setup writes the project roots file in place of a link, never through one', async () => {
  const w = world();
  const canary = w.hostFile('canary', 'host file\n');
  for (const name of ['project-roots.json.tmp', 'project-roots.json.new']) w.plant(`state/api-settings/${name}`, canary);
  expect((await w.run('setup.sh')).code).toBe(0);
  expect(readFileSync(canary, 'utf8')).toBe('host file\n');
  const roots = join(w.repo, 'state', 'api-settings', 'project-roots.json');
  expect(lstatSync(roots).isFile()).toBe(true);
  expect(JSON.parse(readFileSync(roots, 'utf8')).roots).toEqual([join(w.home, 'code')]);
});

test('setup refuses a link where a folder or file it mounts belongs, and creates or chmods nothing through it', async () => {
  const login = world();
  const absent = join(login.base, 'created-through-link');
  login.plant('state/codex-auth.json', absent);
  const r = await login.run('setup.sh');
  expect(r.code).toBe(1);
  expect(r.out).toContain('state/codex-auth.json is a link or not a file');
  expect(existsSync(absent)).toBe(false);

  const control = world();
  const outside = join(control.base, 'outside');
  mkdirSync(outside, { mode: 0o755 });
  chmodSync(outside, 0o755);
  control.plant('state/runner-control', outside);
  const c = await control.run('setup.sh');
  expect(c.code).toBe(1);
  expect(c.out).toContain('state/runner-control is a link or not a folder');
  expect(statSync(outside).mode & 0o777).toBe(0o755);
});

test('setup --runner-procfs-compat never copies a host file a linked runner flag names into state/', async () => {
  const w = world();
  const secret = w.hostFile('secret', 'sandbox: x\nSECRET-CANARY-7f3a\n');
  w.plant('state/runner-control/codex-runner-disabled', secret);
  await w.run('setup.sh', ['--yes', '--skip-agents', '--runner-procfs-compat']);
  expect(readFileSync(secret, 'utf8')).toBe('sandbox: x\nSECRET-CANARY-7f3a\n');
  const flag = join(w.repo, 'state', 'runner-control', 'codex-runner-disabled');
  expect(lstatSync(flag).isSymbolicLink()).toBe(true);
  const files = (readdirSync(join(w.repo, 'state'), { recursive: true }) as string[]).map((f) => join(w.repo, 'state', f)).filter((f) => lstatSync(f).isFile());
  for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain('SECRET-CANARY');
});

/** doctor with a Codex runner whose sandbox probe fails, so it writes the runner flag. */
function failingRunner(w: ReturnType<typeof world>) {
  writeFileSync(join(w.repo, '.env'), 'API_PORT=8787\nCODEX_RUNNER_URL=http://codex-runner:8790\n');
  w.stub('docker', `[ "$1" = info ] && exit 0
case "$*" in
  "ps -a "*) ;;
  *" ps "*) printf 'neo4j\\nworker\\napi\\ncodex-runner\\n' ;;
  *"/health"*) echo "sandbox failed"; exit 1 ;;
esac
exit 0`);
}

test('doctor writes the runner flag in place of a link, never through it, and never prints a file a link names', async () => {
  const w = world();
  failingRunner(w);
  const canary = w.hostFile('canary', 'host file\n');
  w.plant('state/runner-control/codex-runner-disabled', canary);
  const r = await w.run('doctor.sh');
  expect(r.out).not.toContain('host file');
  expect(readFileSync(canary, 'utf8')).toBe('host file\n');
  const flag = join(w.repo, 'state', 'runner-control', 'codex-runner-disabled');
  // The link names a host file, so it was no flag: the probe ran, failed, and its flag replaced the link.
  expect(lstatSync(flag).isFile()).toBe(true);
  expect(readFileSync(flag, 'utf8')).toContain('sandbox: nested sandbox startup failed');
});

test('fg status never prints a file a linked runner flag names', async () => {
  const w = world();
  writeFileSync(join(w.repo, '.env'), 'API_PORT=8787\nSCAN_LLM=codex-cli\n');
  const secret = w.hostFile('secret', 'SECRET-CANARY-7f3a\n');
  w.plant('state/runner-control/codex-runner-disabled', secret);
  w.stub('node', 'exit 1');
  const r = await w.run('fg', ['status']);
  expect(r.out).not.toContain('SECRET-CANARY');
  expect(r.out).not.toContain('codex runner disabled');
  // A plain flag is still said.
  const plain = world();
  writeFileSync(join(plain.repo, '.env'), 'API_PORT=8787\nSCAN_LLM=codex-cli\n');
  mkdirSync(join(plain.repo, 'state', 'runner-control'), { recursive: true });
  writeFileSync(join(plain.repo, 'state', 'runner-control', 'codex-runner-disabled'), 'network: reached the api\n');
  plain.stub('node', 'exit 1');
  expect((await plain.run('fg', ['status'])).out).toContain('WARN codex runner disabled: network: reached the api');
});

/** A Postgres backup of state/ as it is now, and a stand-in docker that accepts every command. */
async function postgresBackup(w: ReturnType<typeof world>) {
  writeFileSync(join(w.repo, '.env'), 'STORE=postgres\nPOSTGRES_PASSWORD=pw\n');
  w.stub('docker', `case " $* " in *" config --format json "*) echo '{"name":"t"}' ;; *" df -Pk "*) printf 'F 1 0 1000000 0%% /d\\nF 1 0 1000000 0%% /d\\n' ;; *" -i "* | *" exec -T "*) cat >/dev/null ;; esac\nexit 0`);
  mkdirSync(join(w.repo, 'state', 'api-settings'), { recursive: true });
  const r = await w.run('backup.sh');
  expect(r.code, r.out).toBe(0);
  return { out: r.out, dir: join('backups', readdirSync(join(w.repo, 'backups'))[0]) };
}

test('restore writes its marker in place of a link a container left in state/, never through it', async () => {
  const w = world();
  const b = await postgresBackup(w);
  const canary = w.hostFile('canary', 'host file\n');
  w.plant('state/.restore-incomplete', canary);
  const r = await w.run('restore.sh', [b.dir], { FORCE: '1' });
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(canary, 'utf8')).toBe('host file\n');
});

test('a backup leaves out a link or FIFO a container left in state/, says so, and restores', async () => {
  const w = world();
  mkdirSync(join(w.repo, 'state', 'settings'), { recursive: true });
  writeFileSync(join(w.repo, 'state', 'settings', 'kept'), 'kept\n');
  w.plant('state/settings/link', w.hostFile('canary', 'host file\n'));
  execFileSync('mkfifo', [join(w.repo, 'state', 'fifo')]);
  const b = await postgresBackup(w);
  expect(b.out).toContain('left out of state.tgz');
  const listing = execFileSync('tar', ['-tzf', join(w.repo, b.dir, 'state.tgz')], { encoding: 'utf8' });
  expect(listing).toContain('state/settings/kept');
  expect(listing).not.toMatch(/link|fifo/);
  const r = await w.run('restore.sh', [b.dir], { FORCE: '1' });
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(join(w.repo, 'state', 'settings', 'kept'), 'utf8')).toBe('kept\n');
});
