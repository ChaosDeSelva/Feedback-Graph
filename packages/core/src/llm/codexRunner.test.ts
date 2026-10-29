import { utimesSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, test } from 'vitest';
import { isolatedRunnerArgs, mirrorLeaseOwner, mirrorLeasePath, purgeStaleRunnerMirrors, createCodexRunner, resolveMirror, runOnRunner, RUNNER_TOKEN_FILE, RunnerUnavailableError, writeRunnerToken, type RunnerOpts } from './codexRunner.ts';
import type { Exec } from './exec.ts';
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
  writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
  chmodSync(bin, 0o755);
  const r = await start({ scratch, bin, exec: undefined, killGraceMs: 100, maxTimeoutMs: 300 });
  const t0 = Date.now();
  const res = await r.post({ ...job, timeoutMs: 60_000 });
  const body = (await res.json()) as { code: number; stderr: string };
  expect(body.code).toBe(124);
  expect(body.stderr).toMatch(/timed out after 300ms/);
  expect(Date.now() - t0).toBeLessThan(10_000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((x) => setTimeout(x, 200));
  expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);

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
  expect(await health.json()).toMatchObject({ ok: false, sandbox: false });
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
