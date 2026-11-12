import { utimesSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { createRunnerServer, isolatedRunnerArgs, mirrorLeaseOwner, mirrorLeasePath, purgeStaleRunnerMirrors, createCodexRunner, resolveMirror, runnerReadiness, runnerStartHint, runOnRunner, RUNNER_TOKEN_FILE, RunnerUnavailableError, writeRunnerToken, type RunnerOpts } from './codexRunner.ts';
import type { Exec } from './exec.ts';
import { SCRIPT_TEST_TIMEOUT_MS } from '../testing/exec.ts';
import { makeProvider } from './providers.ts';
import { providerUnavailableReason } from './unavailable.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'fb-runner-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, `t${++n}`);
  mkdirSync(join(d, 'scratch', 'fb-mirror-1'), { recursive: true });
  mkdirSync(join(d, 'outside'), { recursive: true });
  writeFileSync(join(d, 'scratch', 'fb-mirror-1', 'a.ts'), 'export const a = 1');
  writeFileSync(join(d, 'outside', 'canary.txt'), 'CANARY');
  return { scratch: join(d, 'scratch'), outside: join(d, 'outside') };
};

/** True while pid exists (a zombie included, until its parent reaps it). */
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A real runner on a loopback port, with a stand-in for codex unless the test brings its own. */
async function start(o: Partial<RunnerOpts> & { scratch: string }) {
  const token = await writeRunnerToken(o.scratch);
  const calls: { cmd: string; args: string[]; cwd: string; stdin: string; env: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
  const fake: Exec = async (cmd, args, x) => {
    calls.push({ cmd, args, ...x });
    writeFileSync(args[args.indexOf('-o') + 1], '{"answer":"ok"}');
    return { code: 0, stdout: 'done', stderr: '' };
  };
  const runner = createCodexRunner({ exec: fake, token, isolate: false, ...o });
  const server = createServer((req, res) => void runner.handle(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: object | string, auth: string | null = `Bearer ${token}`) =>
    fetch(`${url}/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { url, token, calls, post, runner };
}

const job = { prompt: 'look around', mirror: 'fb-mirror-1', schema: { type: 'object', properties: { answer: { type: 'string' } } } };

test('a job needs the token: none, a wrong one and a non-Bearer header are all refused, and codex never starts', async () => {
  const { scratch } = fresh();
  const r = await start({ scratch });
  for (const auth of [null, 'Bearer nope', `Basic ${r.token}`, r.token, `Bearer ${r.token}x`]) {
    const res = await r.post(job, auth);
    expect(res.status).toBe(401);
  }
  expect(r.calls).toEqual([]);
  expect((await fetch(`${r.url}/health`)).status).toBe(200);
  expect((await fetch(`${r.url}/run`, { headers: { authorization: `Bearer ${r.token}` } })).status).toBe(405);
});

test('the Bearer scheme is matched in any case (RFC 7235): bearer and BEARER carry the token too', async () => {
  const { scratch } = fresh();
  const r = await start({ scratch });
  for (const scheme of ['bearer', 'BEARER', 'BeArEr']) expect((await r.post(job, `${scheme} ${r.token}`)).status).toBe(200);
});

test('the token is written to the scratch volume atomically, readable by its owner only, and new on every start', async () => {
  const { scratch } = fresh();
  const a = await writeRunnerToken(scratch);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(readFileSync(join(scratch, RUNNER_TOKEN_FILE), 'utf8')).toBe(a);
  expect(statSync(join(scratch, RUNNER_TOKEN_FILE)).mode & 0o077).toBe(0);
  expect(await writeRunnerToken(scratch)).not.toBe(a);
});

test('an accepted job runs codex exec read-only in the mirror, with the prompt on stdin and none of the runner env', async () => {
  const { scratch } = fresh();
  const saved = { ...process.env };
  Object.assign(process.env, { NEO4J_PASSWORD: 'pw', GITHUB_TOKEN: 'gh', CODEX_HOME: '/codex', PATH: '/usr/bin' });
  try {
    const r = await start({ scratch });
    const res = await r.post({ ...job, model: 'gpt-5.1-codex' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 0, stdout: 'done', stderr: '', output: '{"answer":"ok"}' });
    const c = r.calls[0];
    expect(c.cmd).toBe('codex');
    expect(c.args.slice(0, 5)).toEqual(['exec', '-s', 'read-only', '-C', join(scratch, 'fb-mirror-1')]);
    expect(c.args).toEqual(expect.arrayContaining(['--skip-git-repo-check', '--ephemeral', '--output-schema', '-m', 'gpt-5.1-codex']));
    expect(c.cwd).toMatch(/fb-codex-/);
    expect(c.stdin).toBe('look around');
    expect(c.env.NEO4J_PASSWORD).toBeUndefined();
    expect(c.env.GITHUB_TOKEN).toBeUndefined();
    expect(c.env.CODEX_HOME).toBe('/codex');
    // The schema and answer files live in the runner's own temp folder, removed after the job.
    expect(existsSync(c.args[c.args.indexOf('--output-schema') + 1])).toBe(false);
  } finally {
    process.env = saved;
  }
});

test('the mirror must be a directory inside the scratch volume: no traversal, no absolute path outside, no symlink out', async () => {
  const { scratch, outside } = fresh();
  symlinkSync(outside, join(scratch, 'escape'));
  writeFileSync(join(scratch, 'file.txt'), 'x');
  const r = await start({ scratch });
  const cases: [string, number][] = [
    ['../outside', 400],
    ['fb-mirror-1/../../outside', 400],
    ['fb-mirror-1/..', 400],
    [outside, 403],
    ['/etc', 403],
    ['/', 403],
    [scratch, 403],
    ['.', 403],
    ['escape', 403],
    [join(scratch, 'escape'), 403],
    ['missing', 400],
    ['file.txt', 400],
    ['', 400],
  ];
  for (const [mirror, status] of cases) {
    const res = await r.post({ ...job, mirror });
    expect({ mirror, status: res.status }).toEqual({ mirror, status });
  }
  expect(r.calls).toEqual([]);
  // Absolute inside the volume is fine too.
  expect((await r.post({ ...job, mirror: join(scratch, 'fb-mirror-1') })).status).toBe(200);
  expect(r.calls).toHaveLength(1);
});

test('resolveMirror answers the same for a path outside the volume whether or not it exists', async () => {
  const { scratch, outside } = fresh();
  await expect(resolveMirror(scratch, join(outside, 'canary.txt'))).rejects.toMatchObject({ status: 403 });
  await expect(resolveMirror(scratch, join(outside, 'nope'))).rejects.toMatchObject({ status: 403 });
});

test('a malformed job is refused before codex starts', async () => {
  const { scratch } = fresh();
  const r = await start({ scratch });
  for (const body of ['not json', '[]', { ...job, prompt: '' }, { ...job, schema: 'x' }, { ...job, model: '--dangerously-bypass-approvals-and-sandbox' }, { ...job, timeoutMs: -1 }]) {
    expect((await r.post(body as object)).status).toBe(400);
  }
  expect(r.calls).toEqual([]);
});

test('the runner caps the timeout and runs one job at a time', async () => {
  const { scratch } = fresh();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: number[] = [];
  const slow: Exec = async (_c, args, o) => {
    seen.push(o.timeoutMs);
    await gate;
    writeFileSync(args[args.indexOf('-o') + 1], '{}');
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = await start({ scratch, exec: slow, maxTimeoutMs: 5000, keepaliveMs: 10 });
  const first = r.post({ ...job, timeoutMs: 999_999 });
  while (!r.runner.busy()) await new Promise((x) => setTimeout(x, 5));
  const second = await r.post(job);
  expect(second.status).toBe(503);
  expect(second.headers.get('retry-after')).toBe('2');
  release();
  const res = await first;
  expect(res.status).toBe(200);
  // Keep-alive whitespace before the result still parses as JSON.
  expect(JSON.parse(await res.text())).toMatchObject({ code: 0, output: '{}' });
  expect(seen).toEqual([5000]);
  expect(r.runner.busy()).toBe(false);
});

test('a job past its timeout is killed with its whole process group and reported as exit 124', async () => {
  const { scratch } = fresh();
  // A stand-in codex that starts a grandchild and ignores SIGTERM, like a CLI stuck in a tool call.
  const bin = join(root, `fake-codex-${n}`);
  const pidFile = join(root, `grandchild-${n}.pid`);
  const parentPidFile = join(root, `parent-${n}.pid`);
  writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\necho $$ > ${parentPidFile}.tmp && mv ${parentPidFile}.tmp ${parentPidFile}\nsleep 30 &\necho $! > ${pidFile}.tmp && mv ${pidFile}.tmp ${pidFile}\nwait\n`);
  chmodSync(bin, 0o755);
  // The job's timeout and kill grace run on fake timers, so they fire only once both processes have started, however
  // slowly a loaded machine starts them. Waits on real processes use node:timers, which stays real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const r = await start({ scratch, bin, exec: undefined, killGraceMs: 100, maxTimeoutMs: 2_000 });
    const res = r.post({ ...job, timeoutMs: 60_000 });
    while (!existsSync(parentPidFile) || !existsSync(pidFile)) await sleep(10);
    const pids = [parentPidFile, pidFile].map(file => Number(readFileSync(file, 'utf8')));
    for (const pid of pids) expect(Number.isInteger(pid) && pid > 0).toBe(true);
    // The runner caps the 60 s asked for at its 2 s maximum: nothing is killed a moment before it.
    vi.advanceTimersByTime(1_999);
    for (const pid of pids) expect(alive(pid)).toBe(true);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(100);
    const body = (await (await res).json()) as { code: number; stderr: string };
    expect(body.code).toBe(124);
    expect(body.stderr).toMatch(/timed out after 2000ms/);
    // Killed processes leave once the OS reaps them; the test's own timeout bounds this wait.
    while (pids.some(alive)) await sleep(25);
  } finally {
    vi.useRealTimers();
  }
}, SCRIPT_TEST_TIMEOUT_MS);

test('the client sends the job with the token, waits while the runner is busy, and re-reads a rotated token once', async () => {
  const { scratch } = fresh();
  const token = await writeRunnerToken(scratch);
  const seen: { auth: string; body: { mirror: string; timeoutMs: number } }[] = [];
  const answers = [503, 401, 200];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    seen.push({ auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
    const status = answers.shift()!;
    if (status === 401) await writeRunnerToken(scratch); // the runner restarted in between
    return new Response(status === 200 ? '  {"code":0,"stdout":"","stderr":"","output":"{}"}' : '{"error":"x"}', { status });
  }) as typeof fetch;
  const r = await runOnRunner({ url: 'http://codex-runner:8790/', scratch, job: { ...job, timeoutMs: 10_000 }, fetchImpl, retryMs: 5 });
  expect(r).toEqual({ code: 0, stdout: '', stderr: '', output: '{}' });
  expect(seen.map((s) => s.auth.slice(7) === token)).toEqual([true, true, false]);
  expect(seen[2].auth).toBe(`Bearer ${readFileSync(join(scratch, RUNNER_TOKEN_FILE), 'utf8')}`);
  // Each attempt asks for what is left of the job's own timeout, never more.
  for (const s of seen) expect(s.body.timeoutMs).toBeLessThanOrEqual(10_000);
});

test('the client says the runner is unavailable when it is not running, has no token, or stays busy', async () => {
  const { scratch } = fresh();
  await expect(runOnRunner({ url: 'http://127.0.0.1:9', scratch, job })).rejects.toThrow(/has not written its token.*--profile codex/);
  await writeRunnerToken(scratch);
  await expect(runOnRunner({ url: 'http://127.0.0.1:9', scratch, job })).rejects.toBeInstanceOf(RunnerUnavailableError);
  const busy = (async () => new Response('{"error":"busy"}', { status: 503 })) as unknown as typeof fetch;
  await expect(runOnRunner({ url: 'http://x', scratch, job: { ...job, timeoutMs: 30 }, fetchImpl: busy, retryMs: 10 })).rejects.toThrow(/stayed busy/);
  const refused = (async () => new Response('{"error":"missing or wrong token"}', { status: 401 })) as unknown as typeof fetch;
  await expect(runOnRunner({ url: 'http://x', scratch, job, fetchImpl: refused })).rejects.toThrow(/refused the token/);
});

test('with CODEX_RUNNER_URL, codex-cli builds the mirror in the scratch volume and runs on the runner, with no acknowledgement needed', async () => {
  const { scratch } = fresh();
  const repo = join(root, `repo-${n}`);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1');
  writeFileSync(join(repo, '.env'), 'K=v');
  let mirrorSeen: Record<string, boolean> = {};
  const fake: Exec = async (_c, args) => {
    const dir = args[args.indexOf('-C') + 1];
    mirrorSeen = { inScratch: dir.startsWith(scratch + '/fb-mirror-'), code: existsSync(join(dir, 'src/a.ts')), env: existsSync(join(dir, '.env')) };
    writeFileSync(args[args.indexOf('-o') + 1], '{"answer":"from the runner"}');
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = await start({ scratch, exec: fake });
  const env = { CODEX_RUNNER_URL: r.url, CODEX_RUNNER_SCRATCH: scratch };
  const p = makeProvider('codex-cli:gpt-5', env);
  expect(p.agentic).toBe(true);
  expect(await p.json({ system: 'S', user: 'U', schema: job.schema, cwd: repo })).toEqual({ answer: 'from the runner' });
  expect(mirrorSeen).toEqual({ inScratch: true, code: true, env: false });
  // The mirror is removed afterwards; only the token stays in the volume.
  const { readdirSync } = await import('node:fs');
  expect(readdirSync(scratch).filter((f) => f.startsWith('fb-mirror-') && f !== 'fb-mirror-1')).toEqual([]);
  // A runner that is down is "unavailable" (the job waits), not a failed answer.
  const down = makeProvider('codex-cli', { CODEX_RUNNER_URL: 'http://127.0.0.1:9', CODEX_RUNNER_SCRATCH: scratch });
  const err = await down.json({ system: 'S', user: 'U', schema: job.schema, cwd: repo }).catch((e: unknown) => e);
  expect(providerUnavailableReason(err)).toMatch(/cannot reach the codex runner/);
});


test('stale mirror sweeping preserves the current job, fresh pending mirrors and non-mirror files', async () => {
  const { scratch } = fresh();
  const old = join(scratch, 'fb-mirror-old');
  const active = join(scratch, 'fb-mirror-active');
  mkdirSync(old); mkdirSync(active);
  const before = new Date(Date.now() - 48 * 60 * 60_000);
  utimesSync(old, before, before); utimesSync(active, before, before);
  writeFileSync(join(scratch, '.runner-token'), 'keep');
  await purgeStaleRunnerMirrors(scratch, active);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(active)).toBe(true);
  expect(existsSync(join(scratch, 'fb-mirror-1'))).toBe(true);
  expect(existsSync(join(scratch, '.runner-token'))).toBe(true);
});


test('isolated jobs expose only their mirror and login, hide scratch and use a fresh process namespace', () => {
  const args = isolatedRunnerArgs({ dir: '/scratch/fb-mirror-active', work: '/tmp/fb-codex-job', auth: '/codex/auth.json', bin: 'codex', args: ['exec', '-C', '/repo'] });
  expect(args).toContain('--unshare-pid');
  expect(args).toContain('--unshare-user');
  expect(args).toContain('--die-with-parent');
  expect(args).toContain('--new-session');
  expect(args.slice(args.indexOf('--ro-bind', args.indexOf('/codex/auth.json') + 1))).toContain('/repo');
  expect(args).not.toContain('/scratch');
  expect(args).not.toContain('/');
  expect(args.filter((v) => v === '/codex').length).toBe(2); // tmpfs and CODEX_HOME, never a bind of old home
  expect(args.slice(args.indexOf('--') + 1)).toEqual(['codex', 'exec', '-C', '/repo']);
});

test('production runner fails closed if the isolation launcher fails, never falls back to codex', async () => {
  const { scratch } = fresh();
  const commands: string[] = [];
  const r = await start({ scratch, isolate: true, exec: async (cmd) => { commands.push(cmd); throw new Error('bwrap unavailable'); } });
  const answer = await (await r.post(job)).json();
  expect(answer.error).toContain('bwrap unavailable');
  expect(commands).toEqual(['bwrap']);
});


test('readiness probes actual nested sandbox startup and fails closed before accepting jobs', async () => {
  const { scratch } = fresh();
  let probes = 0;
  const r = await start({ scratch, isolate: true, exec: async (_cmd, args, options) => {
    probes++;
    expect(args).toContain('--unshare-net');
    expect(options.timeoutMs).toBe(5_000);
    return { code: 1, stdout: '', stderr: 'bwrap: mount /proc: permission denied' };
  } });
  const health = await fetch(`${r.url}/health`);
  expect(health.status).toBe(503);
  const body = await health.json() as { ok: boolean; sandbox: boolean; error: string };
  expect(body).toMatchObject({ ok: false, sandbox: false, error: expect.stringContaining('setup.sh --runner-procfs-compat') });
  expect(body.error.indexOf('Select Claude Code')).toBeLessThan(body.error.indexOf('setup.sh --runner-procfs-compat'));
  expect(body.error).not.toContain('operations.md.;');
  const run = await r.post(job);
  expect(run.status).toBe(503);
  expect(await run.json()).toMatchObject({ code: 'sandbox_unavailable' });
  expect(probes).toBe(1);
});

test('worker sweeps recently abandoned mirrors but preserves live renewable leases', async () => {
  const { scratch } = fresh();
  const dead = join(scratch, 'fb-mirror-dead');
  const live = join(scratch, 'fb-mirror-live');
  for (const [dir, pid] of [[dead, 2147483647], [live, process.pid]] as const) {
    mkdirSync(dir);
    writeFileSync(mirrorLeasePath(dir), JSON.stringify({ pid, host: hostname() }));
  }
  await purgeStaleRunnerMirrors(scratch, undefined, Date.now(), true);
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(mirrorLeasePath(dead))).toBe(false);
  expect(existsSync(live)).toBe(true);
  await purgeStaleRunnerMirrors(scratch, undefined, Date.now() + 6 * 60_000);
  expect(existsSync(live)).toBe(false);
});


test('runner readiness rejects unavailable sandbox before any repository mirror is created', async () => {
  const { scratch } = fresh();
  let healthCalls = 0;
  const fetchImpl = (async (url: string) => {
    expect(String(url)).toMatch(/\/health$/);
    healthCalls++;
    return new Response(JSON.stringify({ ok: false, sandbox: false, error: 'Cannot mount private proc' }), { status: 503 });
  }) as typeof fetch;
  const provider = makeProvider('codex-cli', { CODEX_RUNNER_URL: 'http://runner', CODEX_RUNNER_SCRATCH: scratch }, { fetchImpl });
  await expect(provider.mirror!(join(scratch, 'nonexistent-repo'))).rejects.toThrow(/Cannot mount private proc/);
  await expect(provider.json({ system: 's', user: 'u', schema: job.schema, cwd: join(scratch, 'nonexistent-repo') })).rejects.toThrow(/Cannot mount private proc/);
  expect(healthCalls).toBe(2);
  const { readdir } = await import('node:fs/promises');
  expect((await readdir(scratch)).filter(name => name.startsWith('fb-mirror-'))).toEqual(['fb-mirror-1']);
});

test('a runner that answers but is not ready is not told to start; an unreachable one gets this install\'s start command', async () => {
  const down = await runnerReadiness('http://runner', (async () => new Response(JSON.stringify({ ok: false, error: 'sandbox unavailable' }), { status: 503 })) as typeof fetch);
  expect(down.reason).toMatch(/sandbox unavailable; the runner is running but not ready: run \.\/scripts\/doctor\.sh/);
  expect(down.reason).not.toMatch(/up -d/);
  const unreachable = await runnerReadiness('http://runner', (async () => { throw new Error('connection refused'); }) as typeof fetch);
  expect(unreachable.reason).toMatch(/connection refused.*docker compose -p .* --profile codex up -d codex-runner/);
  expect(runnerStartHint({ FG_INSTANCE: 'feedback-graph-two', COMPOSE_FILE: 'docker-compose.yml:docker-compose.small.yml' }))
    .toContain('docker compose -p feedback-graph-two -f docker-compose.yml -f docker-compose.small.yml --profile codex up -d codex-runner');
  expect(runnerStartHint({})).toContain('docker compose -p feedback-graph --profile codex up -d codex-runner');
});


test('a reused worker PID cannot keep an abandoned mirror alive with an old process nonce', async () => {
  const { scratch } = fresh();
  const old = join(scratch, 'fb-mirror-reused'), live = join(scratch, 'fb-mirror-live');
  mkdirSync(old); mkdirSync(live);
  const owner = await mirrorLeaseOwner();
  writeFileSync(mirrorLeasePath(old), JSON.stringify({ ...owner, nonce: 'previous-process-instance' }));
  writeFileSync(mirrorLeasePath(live), JSON.stringify(owner));
  await purgeStaleRunnerMirrors(scratch, undefined, Date.now(), true);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(live)).toBe(true);
});

test('the runner answers only GET /health and POST /run', async () => {
  const { scratch } = fresh();
  const r = await start({ scratch });
  expect((await fetch(`${r.url}/other`)).status).toBe(404);
  const get = await fetch(`${r.url}/run?x=1`);
  expect(get.status).toBe(405);
  expect(get.headers.get('allow')).toBe('POST');
  expect(await (await fetch(`${r.url}/health`)).json()).toEqual({ ok: true, sandbox: false, busy: false });
  expect(r.calls).toEqual([]);
});

test('a job that is not an object, or too large, is refused before codex starts', async () => {
  const { scratch } = fresh();
  const r = await start({ scratch });
  expect(await (await r.post('null')).json()).toEqual({ error: 'job is not an object' });
  const big = await r.post(JSON.stringify({ ...job, prompt: 'x'.repeat(17 * 1024 * 1024) })).catch((e: Error) => e);
  // the runner answers 413 and drops the connection; either way the job never runs
  if (big instanceof Response) expect(big.status).toBe(413);
  expect(r.calls).toEqual([]);
  expect(r.runner.busy()).toBe(false);
});

test('a scratch volume that went away is a server error, not a bad request', async () => {
  const { scratch } = fresh();
  const r = await start({ scratch });
  rmSync(scratch, { recursive: true, force: true });
  const res = await r.post(job);
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/ENOENT/);
});

test('codex failing after the job was accepted is reported in the result body, and the runner takes the next job', async () => {
  const { scratch } = fresh();
  let fail = true;
  const r = await start({ scratch, exec: async (_c, args) => {
    if (fail) throw new Error('spawn codex ENOENT');
    writeFileSync(args[args.indexOf('-o') + 1], '{}');
    return { code: 0, stdout: 'o'.repeat(70_000), stderr: '' };
  } });
  const res = await r.post(job);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ error: 'spawn codex ENOENT' });
  fail = false;
  const next = await (await r.post(job)).json() as { stdout: string; output: string };
  // only the tail of a long output comes back
  expect(next.stdout).toHaveLength(64_000);
  expect(next.output).toBe('{}');
});

test('an isolated runner probes its sandbox once, then runs codex inside it with only the login and the mirror', async () => {
  const { scratch } = fresh();
  const calls: { cmd: string; args: string[] }[] = [];
  const r = await start({ scratch, isolate: true, bin: '/opt/codex', env: { PATH: '/usr/bin', CODEX_HOME: '/home/codex', SECRET: 'no' }, exec: async (cmd, args, o) => {
    calls.push({ cmd, args });
    expect(o.env).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/home/codex' });
    if (args.includes('--output-schema')) writeFileSync(args[args.indexOf('-o') + 1], '{"answer":"ok"}');
    return { code: 0, stdout: '', stderr: '' };
  } });
  // two health checks at once share one probe, and a later one within 30 s reuses its answer
  const [a, b] = await Promise.all([r.runner.health(), r.runner.health()]);
  expect(a).toEqual({ ok: true, sandbox: true });
  expect(b).toEqual(a);
  expect(await (await fetch(`${r.url}/health`)).json()).toEqual({ ok: true, sandbox: true, busy: false });
  const res = await (await r.post(job)).json();
  expect(res).toMatchObject({ code: 0, output: '{"answer":"ok"}' });
  expect(calls.map((c) => c.cmd)).toEqual(['bwrap', 'bwrap']);
  const run = calls[1].args;
  expect(run.slice(run.indexOf('--bind-try'), run.indexOf('--bind-try') + 3)).toEqual(['--bind-try', '/home/codex/auth.json', '/codex/auth.json']);
  expect(run.slice(run.indexOf('--ro-bind', run.indexOf('--bind-try')), run.indexOf('--ro-bind', run.indexOf('--bind-try')) + 3)).toEqual(['--ro-bind', join(scratch, 'fb-mirror-1'), '/repo']);
  const codex = run.slice(run.indexOf('--') + 1);
  expect(codex[0]).toBe('/opt/codex');
  expect(codex.slice(codex.indexOf('-C'), codex.indexOf('-C') + 2)).toEqual(['-C', '/repo']);
});

test('a sandbox probe that fails without a message, or throws a non-error, still explains itself', async () => {
  for (const exec of [
    (async () => ({ code: 7, stdout: '', stderr: '' })) as Exec,
    (async () => { throw 'bwrap missing'; }) as Exec,
  ]) {
    const { scratch } = fresh();
    const r = await start({ scratch, isolate: true, exec });
    const h = await r.runner.health();
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/^Codex sandbox cannot start: (sandbox probe exit 7|bwrap missing)\. Select Claude Code/);
  }
});

test.skipIf(process.platform !== 'linux')('a live worker PID that started at another time is a reused PID: its mirror is swept', async () => {
  const { scratch } = fresh();
  const old = join(scratch, 'fb-mirror-restarted');
  mkdirSync(old);
  writeFileSync(mirrorLeasePath(old), JSON.stringify({ pid: process.pid, host: hostname(), started: '1' }));
  await purgeStaleRunnerMirrors(scratch, undefined, Date.now(), true);
  expect(existsSync(old)).toBe(false);
});

test('readiness explains a failure the runner gives no reason for, and a thrown non-error', async () => {
  const silent = await runnerReadiness('http://runner/', (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch);
  expect(silent).toEqual({ ok: false, reason: expect.stringMatching(/^codex runner readiness failed \(HTTP 500\); the runner is running but not ready/) });
  const weird = await runnerReadiness('http://runner', (async () => { throw 'boom'; }) as unknown as typeof fetch);
  expect(weird.reason).toMatch(/^cannot reach the codex runner at http:\/\/runner: boom;/);
  expect(await runnerReadiness('http://runner', (async () => new Response('{"ok":true}')) as unknown as typeof fetch)).toEqual({ ok: true, reason: null });
});

test('the client reports what a runner said when it did not return a result', async () => {
  const { scratch } = fresh();
  await writeRunnerToken(scratch);
  const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  await expect(runOnRunner({ url: 'http://x', scratch, job, fetchImpl: answer(502, '<html>bad gateway</html>') })).rejects.toThrow('codex runner 502: <html>bad gateway</html>');
  await expect(runOnRunner({ url: 'http://x', scratch, job, fetchImpl: answer(400, '{"error":"prompt is required"}') })).rejects.toThrow('codex runner 400: prompt is required');
  await expect(runOnRunner({ url: 'http://x', scratch, job, fetchImpl: answer(500, '{}') })).rejects.toThrow('codex runner 500: {}');
  await expect(runOnRunner({ url: 'http://x', scratch, job, fetchImpl: answer(200, '{"error":"spawn codex ENOENT"}') })).rejects.toThrow('codex runner 200: spawn codex ENOENT');
  // a sandbox that cannot start fails at once, without waiting out the job
  await expect(runOnRunner({ url: 'http://x', scratch, job, fetchImpl: answer(503, '{"code":"sandbox_unavailable"}') })).rejects.toThrow(/^sandbox unavailable$/);
  // fields a runner left out read as a failed run with no output
  expect(await runOnRunner({ url: 'http://x', scratch, job, fetchImpl: answer(200, '{}') })).toEqual({ code: 1, stdout: '', stderr: '', output: null });
});

test('the client names the network cause when the runner cannot be reached', async () => {
  const { scratch } = fresh();
  await writeRunnerToken(scratch);
  const refused = (async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.2:8790') }); }) as unknown as typeof fetch;
  await expect(runOnRunner({ url: 'http://x', scratch, job, fetchImpl: refused })).rejects.toThrow(/cannot reach the codex runner at http:\/\/x \(connect ECONNREFUSED 10\.0\.0\.2:8790\)/);
  const odd = (async () => { throw 'down'; }) as unknown as typeof fetch;
  await expect(runOnRunner({ url: 'http://x', scratch, job, fetchImpl: odd })).rejects.toThrow(/\(down\)/);
});

test('the client waits the default 2 s between busy answers', async () => {
  const { scratch } = fresh();
  await writeRunnerToken(scratch);
  let calls = 0;
  const busy = (async () => { calls++; return new Response('not json', { status: 503 }); }) as unknown as typeof fetch;
  // The wait and the job's deadline run on a fake clock: the second ask comes exactly 2 s after the first.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const asked = expect(runOnRunner({ url: 'http://x', scratch, job: { ...job, timeoutMs: 2500 }, fetchImpl: busy })).rejects.toThrow(/stayed busy/);
    // Reading the token is real I/O: wait for the first ask before moving the clock.
    while (calls === 0) await sleep(5);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await asked;
    expect(calls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

describe('createRunnerServer', () => {
  async function serve(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    const logs: { msg: string; extra?: object }[] = [];
    const server = createRunnerServer({ handle }, (msg, extra) => logs.push({ msg, extra }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs, server };
  }

  test('logs each request but health checks, by method, path and status, and gives requests a minute to arrive', async () => {
    const s = await serve(async (_req, res) => { res.writeHead(204).end(); });
    expect(s.server.requestTimeout).toBe(60_000);
    await fetch(`${s.url}/health`);
    await fetch(`${s.url}/run`, { method: 'POST', body: '{"prompt":"secret plan"}' });
    // Logged once the response has finished, which can be after the client has it.
    await vi.waitFor(() => expect(s.logs.length).toBeGreaterThan(0));
    expect(s.logs).toEqual([{ msg: 'request', extra: { method: 'POST', path: '/run', status: 204, ms: expect.any(Number) } }]);
  });

  test('a handler that throws before answering gets a 500; one that throws mid-answer has its response ended', async () => {
    const before = await serve(async () => { throw new Error('disk full'); });
    expect((await fetch(`${before.url}/run`)).status).toBe(500);
    expect(before.logs.map((l) => l.msg)).toContain('error');
    expect(before.logs.find((l) => l.msg === 'error')!.extra).toEqual({ error: 'Error: disk full' });
    const during = await serve(async (_req, res) => { res.writeHead(200); res.write('partial'); throw new Error('lost'); });
    const res = await fetch(`${during.url}/run`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('partial');
  });
});
