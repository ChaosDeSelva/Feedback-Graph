import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createRunnerServer, RUNNER_TOKEN_FILE, startCodexRunner } from './codexRunner.ts';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const listen = async (server: Server) => {
  servers.push(server);
  if (!server.listening) await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

test('the runner service sweeps stale mirrors, writes an owner-only token and answers health and jobs', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fb-runner-main-'));
  dirs.push(scratch);
  mkdirSync(join(scratch, 'fb-mirror-stale'));
  const old = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(join(scratch, 'fb-mirror-stale'), old, old);
  const logs: { msg: string; extra?: object }[] = [];
  const server = await startCodexRunner({ scratch, port: 0, host: '127.0.0.1', log: (msg, extra) => logs.push({ msg, extra }), runner: { isolate: false } });
  const url = await listen(server);

  expect(existsSync(join(scratch, 'fb-mirror-stale'))).toBe(false);
  const token = readFileSync(join(scratch, RUNNER_TOKEN_FILE), 'utf8');
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(statSync(join(scratch, RUNNER_TOKEN_FILE)).mode & 0o777).toBe(0o600);
  expect(logs).toEqual([{ msg: 'codex runner listening', extra: { port: 0, scratch } }]);

  expect((await fetch(`${url}/health`)).status).toBe(200);
  const refused = await fetch(`${url}/run`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: JSON.stringify({ prompt: 'SECRET PROMPT' }) });
  expect(refused.status).toBe(401);
  const accepted = await fetch(`${url}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ prompt: 'SECRET PROMPT', schema: {}, mirror: 'missing' }) });
  expect(accepted.status).toBe(400);
  await new Promise((ok) => setTimeout(ok, 20));
  // Health probes are not logged; job requests are, without their content or the token.
  expect(logs.slice(1).map((l) => l.extra)).toEqual([
    { method: 'POST', path: '/run', status: 401, ms: expect.any(Number) },
    { method: 'POST', path: '/run', status: 400, ms: expect.any(Number) },
  ]);
  expect(JSON.stringify(logs)).not.toMatch(/SECRET PROMPT|wrong|[0-9a-f]{64}/);
});

test('a handler that fails answers 500, or ends a response already under way, and logs the error', async () => {
  const logs: { msg: string; extra?: object }[] = [];
  const log = (msg: string, extra?: object) => logs.push({ msg, extra });
  const before = await listen(createRunnerServer({ handle: async () => { throw new Error('mirror vanished'); } }, log));
  expect((await fetch(`${before}/run`, { method: 'POST' })).status).toBe(500);
  const during = await listen(createRunnerServer({ handle: async (_req, res) => { res.writeHead(200); res.write(' '); throw new Error('codex crashed'); } }, log));
  const res = await fetch(`${during}/run`, { method: 'POST' });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(' ');
  expect(logs.filter((l) => l.msg === 'error')).toEqual([{ msg: 'error', extra: { error: 'Error: mirror vanished' } }, { msg: 'error', extra: { error: 'Error: codex crashed' } }]);
});
