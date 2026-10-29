import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runnerTestSystemPaths } from './codexRunner.testOptions.ts';
import { isolatedRunnerArgs, RUNNER_TOKEN_FILE, runOnRunner } from './codexRunner.ts';

/**
 * The codex-runner container as docker-compose.yml defines it, next to a stand-in for the worker that holds what the
 * worker holds (a transcripts mount and secrets in its environment). Nothing of the worker's may be readable from the
 * runner: not by a full walk of its filesystem, and not by codex itself when asked to read it.
 *
 * Skipped without a Docker daemon (SKIP_DOCKER_TESTS=1 skips it too). The codex part also needs a Codex login on this
 * machine (~/.codex/auth.json, or CODEX_AUTH_FILE) and makes one small model call; SKIP_CODEX_CLI_TEST=1 skips it.
 */
const repoRoot = resolve(import.meta.dirname, '../../../..');
const docker = (args: string[], o: { input?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', input: o.input, timeout: o.timeout ?? 120_000, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const dockerUp = (() => {
  if (process.env.SKIP_DOCKER_TESTS === '1') return false;
  try {
    docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();
const authFile = process.env.CODEX_AUTH_FILE || join(homedir(), '.codex', 'auth.json');
const codexLogin = existsSync(authFile) && statSync(authFile).size > 0 && process.env.SKIP_CODEX_CLI_TEST !== '1';

const id = `fgrt${process.pid}${Date.now().toString(36)}`;
const IMAGE = 'fg-codex-runner:test';
const systemPathsOptions = runnerTestSystemPaths(process.env.FG_TEST_RUNNER_UNMASK_SYSTEM_PATHS);
const runnerAppArmor = process.env.CODEX_RUNNER_APPARMOR || 'unconfined';
const CANARY = `CANARY-${id}-7d1e`;
const SECRET = `WORKERSECRET-${id}-99a0`;
const INSIDE = `INSIDE-${id}-3c4b`;

describe.skipIf(!dockerUp)('codex-runner container', () => {
  let root = '';
  let scratch = '';
  let url = '';

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fb-runner-docker-')));
    scratch = join(root, 'scratch');
    const workerOnly = join(root, 'transcripts');
    mkdirSync(join(scratch, 'fb-mirror-job'), { recursive: true });
    mkdirSync(workerOnly);
    writeFileSync(join(workerOnly, 'canary.txt'), `${CANARY}\n`);
    writeFileSync(join(scratch, 'fb-mirror-job', 'notes.txt'), `${INSIDE}\n`);
    const home = join(root, 'codex-home');
    mkdirSync(home);
    writeFileSync(join(home, 'old-history.txt'), 'OLD_HISTORY');
    const auth = join(root, 'auth.json');
    writeFileSync(auth, codexLogin ? readFileSync(authFile) : '');
    docker(['build', '--target', 'codex-runner', '-t', IMAGE, repoRoot], { timeout: 600_000 });
    docker(['network', 'create', `${id}-net`]);
    // Linux bind mounts keep the host uid: like Compose's HOST_UID/HOST_GID, run both services as the owner
    // of scratch and auth.json. Docker Desktop translates bind-mount ownership, so keep the image user there.
    const user = process.platform === 'linux' ? ['--user', `${process.getuid!()}:${process.getgid!()}`] : [];
    // The worker's side: the scratch volume plus a mount and secrets only it has.
    docker(['run', '-d', ...user, '--name', `${id}-worker`, '--network', `${id}-net`, '-v', `${scratch}:/scratch`, '-v', `${workerOnly}:/transcripts:ro`, '-e', `NEO4J_PASSWORD=${SECRET}`, '--entrypoint', 'node', IMAGE, '-e', 'setInterval(() => {}, 1000)']);
    // The runner with exactly the hardening docker-compose.yml gives it (checked against the file below), published on
    // loopback only for this test.
    const launch = (compatibility: string[]) => docker([
      'run', '-d', ...user, ...compatibility, '--name', `${id}-runner`, '--network', `${id}-net`, '--init', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--security-opt', 'seccomp=unconfined', '--security-opt', `apparmor=${runnerAppArmor}`,
      '-e', 'HOME=/tmp', '-v', `${scratch}:/scratch`, '-v', `${home}:/codex`, '-v', `${auth}:/codex/auth.json`, '-p', '127.0.0.1::8790', IMAGE,
    ]);
    // Exercise the unchanged masked default before explicitly selecting test-only compatibility.
    if (systemPathsOptions.length) {
      launch([]);
      const maskedUrl = `http://${docker(['port', `${id}-runner`, '8790/tcp']).trim().split('\n')[0]}`;
      let masked: Response | undefined;
      const deadline = Date.now() + 20_000;
      while (!masked && Date.now() < deadline) {
        try { masked = await fetch(`${maskedUrl}/health`, { signal: AbortSignal.timeout(7_000) }); }
        catch { await new Promise(resolve => setTimeout(resolve, 200)); }
      }
      expect(masked, 'default runner must answer its actual sandbox readiness probe').toBeDefined();
      const readiness = await masked!.json();
      if (!masked!.ok) {
        expect(masked!.status).toBe(503);
        expect(readiness).toMatchObject({ ok: false, sandbox: false });
        expect(readiness.error).toMatch(/sandbox cannot start/i);
        const refused = await fetch(`${maskedUrl}/run`, {
          method: 'POST', headers: { authorization: `Bearer ${readFileSync(join(scratch, RUNNER_TOKEN_FILE), 'utf8')}`, 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'probe only', mirror: 'fb-mirror-job', schema: { type: 'object' } }),
          signal: AbortSignal.timeout(7_000),
        });
        expect(refused.status).toBe(503);
        expect(await refused.json()).toMatchObject({ code: 'sandbox_unavailable' });
      } else expect(readiness).toMatchObject({ ok: true, sandbox: true });
      docker(['rm', '-f', '-v', `${id}-runner`]);
    }
    launch(systemPathsOptions);
    url = `http://${docker(['port', `${id}-runner`, '8790/tcp']).trim().split('\n')[0]}`;
    // Fail at startup with the runner's diagnostics, rather than reporting missing tokens or failed docker execs.
    const logs = () => {
      const result = spawnSync('docker', ['logs', `${id}-runner`], { encoding: 'utf8', timeout: 20_000 });
      return `${result.stdout ?? ''}${result.stderr ?? ''}`;
    };
    let lastHealth = 'no HTTP response';
    const diagnostics = () => {
      const kernel = spawnSync('sudo', ['-n', 'dmesg', '--ctime'], { encoding: 'utf8', timeout: 5_000 });
      const denials = (kernel.stdout ?? '').split('\n').filter(line => /apparmor=.*DENIED|profile=.*feedback-graph-codex-runner/.test(line)).slice(-40).join('\n');
      return `${logs()}\nLast /health response: ${lastHealth}\nAppArmor diagnostics:\n${denials || kernel.stderr || 'no kernel denials available'}`;
    };
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', `${id}-runner`])) as { Running: boolean; ExitCode: number };
      if (!state.Running) throw new Error(`codex-runner exited with ${state.ExitCode}:\n${diagnostics()}`);
      try {
        const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(7_000) });
        lastHealth = `${health.status} ${await health.text()}`;
        if (health.ok) return;
      } catch (error) {
        lastHealth = String(error);
        // The process is running but has not started listening yet.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`codex-runner did not become healthy:\n${diagnostics()}`);
  }, 660_000);

  afterAll(() => {
    for (const c of [`${id}-runner`, `${id}-worker`]) {
      try {
        docker(['rm', '-f', '-v', c]);
      } catch {
        // never started
      }
    }
    for (const args of [['network', 'rm', `${id}-net`], ['volume', 'rm', `${id}-home`]]) {
      try {
        docker(args);
      } catch {
        // never created
      }
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('docker-compose.yml gives the runner only the scratch volume, its own Codex home and the login file, no secrets', () => {
    // Your own .env stays out of it: an empty env file and only the one required variable.
    const empty = join(root, 'empty.env');
    writeFileSync(empty, '');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, NEO4J_PASSWORD: 'x', CODEX_RUNNER_APPARMOR: runnerAppArmor };
    const cfg = JSON.parse(docker(['compose', '--env-file', empty, '-f', join(repoRoot, 'docker-compose.yml'), '--profile', 'codex', 'config', '--format', 'json'], { timeout: 30_000, env })) as { services: Record<string, { volumes?: { target: string; source: string }[]; environment?: Record<string, string>; ports?: unknown[]; read_only?: boolean; privileged?: boolean; cap_drop?: string[]; security_opt?: string[]; tmpfs?: string[] }> };
    const runner = cfg.services['codex-runner'];
    expect(runner.volumes!.map((v) => v.target).sort()).toEqual(['/codex', '/codex/auth.json', '/scratch']);
    expect(runner.volumes!.find((v) => v.target === '/codex')!.source).not.toBe(cfg.services.worker.volumes!.find((v) => v.target === '/codex')!.source);
    expect(Object.keys(runner.environment ?? {}).sort()).toEqual(['CODEX_HOME', 'HOME', 'RUNNER_PORT', 'RUNNER_SCRATCH']);
    expect(runner.ports ?? []).toEqual([]);
    expect(runner).toMatchObject({ read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true', 'seccomp=unconfined', `apparmor=${runnerAppArmor}`], tmpfs: ['/tmp'] });
    expect(runner.privileged).not.toBe(true);
    for (const [name, service] of Object.entries(cfg.services)) {
      if (name !== 'codex-runner') expect((service.security_opt ?? []).filter(opt => opt.startsWith('apparmor='))).toEqual([]);
    }
    // The scratch volume and the Codex login file are all the two share.
    const shared = cfg.services.worker.volumes!.filter((w) => runner.volumes!.some((r) => r.source === w.source)).map((w) => w.target);
    expect(shared.sort()).toEqual(['/codex/auth.json', '/scratch']);
  });

  test('nothing in the runner container holds the worker-only canary or the worker secrets; the mirror is there', () => {
    // The worker stand-in can read both, so the strings exist and the search below works.
    expect(docker(['exec', `${id}-worker`, 'node', '-e', 'process.stdout.write(require("fs").readFileSync("/transcripts/canary.txt","utf8") + process.env.NEO4J_PASSWORD)'])).toContain(SECRET);
    // Explicit roots cover readable descendants even when AppArmor denies listing an intermediate directory.
    const roots = ['/', '/usr/bin', '/usr/local/bin', '/usr/lib', '/runner', '/etc', '/scratch', '/codex', '/transcripts'];
    const paths = ['/scratch/fb-mirror-job/notes.txt', '/transcripts/canary.txt', '/etc/passwd', '/runner/codexRunner.ts', '/usr/local/bin/node', '/proc/self/environ', '/proc/self/cmdline'];
    const walk = `
      const fs = require('fs'), path = require('path');
      const { want, roots, paths } = JSON.parse(Buffer.from(process.argv[1], 'base64').toString());
      const found = new Set(), visited = new Set(), reads = {}, enumerated = {};
      const look = (p) => { try { const b = fs.readFileSync(p).subarray(0, 4e6).toString('latin1'); for (const w of want) if (b.includes(w)) found.add(w + ' in ' + p); return true; } catch { return false; } };
      const walk = (d) => { if (visited.has(d)) return; visited.add(d); let es; try { es = fs.readdirSync(d, { withFileTypes: true }); enumerated[d] = true; } catch { enumerated[d] = false; return; }
        for (const e of es) { const p = path.join(d, e.name);
          if (d === '/' && ['proc', 'sys', 'dev'].includes(e.name)) continue;
          if (e.isDirectory()) walk(p); else if (e.isFile()) look(p); } };
      for (const root of roots) walk(root);
      for (const p of paths) reads[p] = look(p);
      for (const pid of fs.readdirSync('/proc').filter((x) => /^\\d+$/.test(x))) { look('/proc/' + pid + '/environ'); look('/proc/' + pid + '/cmdline'); }
      process.stdout.write(JSON.stringify({ roots: Object.fromEntries(roots.map(p => [p, enumerated[p]])), reads, found: [...found] }));`;
    const out = JSON.parse(docker(['exec', `${id}-runner`, 'node', '-e', walk, Buffer.from(JSON.stringify({ want: [CANARY, SECRET, INSIDE], roots, paths })).toString('base64')], { timeout: 300_000 })) as { roots: Record<string, boolean>; reads: Record<string, boolean>; found: string[] };
    expect(Object.keys(out.roots)).toEqual(roots);
    expect(Object.keys(out.reads)).toEqual(paths);
    for (const p of paths.filter(p => p !== '/transcripts/canary.txt')) expect(out.reads[p], `read positive control ${p}`).toBe(true);
    expect(out.reads['/transcripts/canary.txt']).toBe(false);
    expect(out.found).toEqual([`${INSIDE} in /scratch/fb-mirror-job/notes.txt`]);
  }, 320_000);

  test('the job namespace hides pending mirrors, runner token, old home and parent processes without a model call', () => {
    expect(readFileSync(join(root, 'codex-home', 'old-history.txt'), 'utf8')).toBe('OLD_HISTORY');
    docker(['exec', `${id}-runner`, 'node', '-e', `
      const fs = require('fs');
      fs.mkdirSync('/scratch/fb-mirror-pending', { recursive: true });
      fs.writeFileSync('/scratch/fb-mirror-pending/private.txt', 'OTHER_PROJECT');
      fs.mkdirSync('/tmp/isolation-test', { recursive: true });
    `]);
    const probe = `
      const fs = require('fs');
      const blocked = ['/scratch/.runner-token', '/scratch/fb-mirror-pending/private.txt', '/codex/old-history.txt'];
      process.stdout.write(JSON.stringify({
        current: fs.readFileSync('/repo/notes.txt', 'utf8'),
        leaks: blocked.filter(p => { try { fs.readFileSync(p); return true; } catch { return false; } }),
        pids: fs.readdirSync('/proc').filter(p => /^\\d+$/.test(p)).length,
      }));
    `;
    const args = isolatedRunnerArgs({ dir: '/scratch/fb-mirror-job', work: '/tmp/isolation-test', auth: '/codex/auth.json', bin: 'node', args: ['-e', probe] });
    const seen = JSON.parse(docker(['exec', `${id}-runner`, 'bwrap', ...args]));
    // Codex also creates a nested sandbox for its tools; exercise nested user and network namespaces without a model.
    const inner = isolatedRunnerArgs({ dir: '/repo', work: '/tmp/isolation-test', auth: '/codex/auth.json', bin: 'node', args: ['-e', probe] });
    inner.unshift('--unshare-net');
    const nested = isolatedRunnerArgs({ dir: '/scratch/fb-mirror-job', work: '/tmp/isolation-test', auth: '/codex/auth.json', bin: 'bwrap', args: inner });
    const nestedSeen = JSON.parse(docker(['exec', `${id}-runner`, 'bwrap', ...nested]));
    expect(nestedSeen.current).toContain(INSIDE);
    expect(nestedSeen.leaks).toEqual([]);
    expect(seen.current).toContain(INSIDE);
    expect(seen.leaks).toEqual([]);
    expect(seen.pids).toBeLessThanOrEqual(3);
    // The pending mirror survives for its own queued job, outside this process's mount namespace.
    expect(docker(['exec', `${id}-runner`, 'cat', '/scratch/fb-mirror-pending/private.txt'])).toBe('OTHER_PROJECT');
  });

  test('the runner wrote its token into the scratch volume and refuses requests without it', async () => {
    for (let i = 0; i < 50 && !existsSync(join(scratch, RUNNER_TOKEN_FILE)); i++) await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(join(scratch, RUNNER_TOKEN_FILE), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    const res = await fetch(`${url}/run`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const token = readFileSync(join(scratch, RUNNER_TOKEN_FILE), 'utf8');
    const outside = await fetch(`${url}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ prompt: 'x', mirror: '/transcripts', schema: { type: 'object' } }) });
    expect(outside.status).toBe(403);
  });

  test.skipIf(!codexLogin)('codex in the runner reads the mirror but cannot read the worker-only canary', async () => {
    const schema = { type: 'object', additionalProperties: false, required: ['files'], properties: { files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } } } };
    const prompt = 'Run `cat` on each of these files and put each in files with its exact text as content, or the exact error you got: notes.txt, /repo/notes.txt, /transcripts/canary.txt, /scratch/fb-mirror-job/notes.txt. Then run `cat /proc/*/environ | tr "\\0" "\\n"` and add it as one more entry with path "environ". Return the JSON.';
    const r = await runOnRunner({ url, scratch, job: { prompt, mirror: 'fb-mirror-job', schema, timeoutMs: 240_000 } });
    if (r.code !== 0 && /log ?in|auth|401|unauthori/i.test(r.stdout + r.stderr)) {
      console.warn('the Codex login could not be used in the container; skipping the live codex check');
      return;
    }
    expect(r.code, r.stderr.slice(-2000)).toBe(0);
    const seen = `${r.output}\n${r.stdout}\n${r.stderr}`;
    expect(seen).not.toContain(CANARY);
    expect(seen).not.toContain(SECRET);
    // A positive control: the same run could read the mirror, so the canary stayed unread because it is not there.
    expect(r.output).toContain(INSIDE);
  }, 300_000);
});
