import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { createCodexRunner, mirrorLeaseOwner, mirrorLeasePath, purgeStaleRunnerMirrors, writeRunnerToken } from './codexRunner.ts';
import type { Exec } from './exec.ts';

/** A stand-in for /proc where `pid` started at `start` (field 22 of its stat line; the command name may hold spaces). */
function procWith(pid: number, start: string) {
  const proc = mkdtempSync(join(tmpdir(), 'fb-proc-'));
  mkdirSync(join(proc, String(pid)));
  const fields = Array.from({ length: 20 }, (_, i) => (i === 19 ? start : '0'));
  writeFileSync(join(proc, String(pid), 'stat'), `${pid} (node worker) ${fields.join(' ')}\n`);
  return proc;
}

function mirrorWithLease(lease: object) {
  const scratch = mkdtempSync(join(tmpdir(), 'fb-lease-'));
  const dir = join(scratch, 'fb-mirror-held');
  mkdirSync(dir);
  writeFileSync(mirrorLeasePath(dir), JSON.stringify(lease));
  return { scratch, dir };
}

test('a lease records when its process started, so a PID reused after a restart is not taken for it', async () => {
  expect((await mirrorLeaseOwner(procWith(process.pid, '4242'))).started).toBe('4242');
  // A stat line it cannot read a start time from, or no /proc at all: no start time.
  const proc = mkdtempSync(join(tmpdir(), 'fb-proc-'));
  mkdirSync(join(proc, String(process.pid)));
  writeFileSync(join(proc, String(process.pid), 'stat'), `${process.pid} (node) S 1`);
  expect((await mirrorLeaseOwner(proc)).started).toBeNull();
  expect((await mirrorLeaseOwner(join(proc, 'missing'))).started).toBeNull();
});

test('a mirror leased by a live PID that started at another time is swept; one whose PID started then is kept', async () => {
  // The parent process: alive, on this host, and not this process.
  const pid = process.ppid;
  const reused = mirrorWithLease({ pid, host: hostname(), started: '100' });
  await purgeStaleRunnerMirrors(reused.scratch, undefined, Date.now(), true, procWith(pid, '200'));
  expect(existsSync(reused.dir)).toBe(false);
  const live = mirrorWithLease({ pid, host: hostname(), started: '100' });
  await purgeStaleRunnerMirrors(live.scratch, undefined, Date.now(), true, procWith(pid, '100'));
  expect(existsSync(live.dir)).toBe(true);
});

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); vi.unstubAllEnvs(); });

test('by default an isolated runner runs codex from PATH with the login from /codex', async () => {
  vi.stubEnv('CODEX_HOME', undefined);
  const scratch = mkdtempSync(join(tmpdir(), 'fb-runner-'));
  mkdirSync(join(scratch, 'fb-mirror-1'));
  const token = await writeRunnerToken(scratch);
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    if (args.includes('--output-schema')) writeFileSync(args[args.indexOf('-o') + 1], '{"answer":"ok"}');
    return { code: 0, stdout: '', stderr: '' };
  };
  const runner = createCodexRunner({ exec, token, scratch, isolate: true });
  const server = createServer((req, res) => void runner.handle(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/run`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ prompt: 'p', mirror: 'fb-mirror-1', schema: { type: 'object' } }),
  });
  expect(await res.json()).toMatchObject({ code: 0, output: '{"answer":"ok"}' });
  const run = calls.at(-1)!;
  expect(run.slice(run.indexOf('--bind-try'), run.indexOf('--bind-try') + 3)).toEqual(['--bind-try', '/codex/auth.json', '/codex/auth.json']);
  expect(run[run.indexOf('--') + 1]).toBe('codex');
});
