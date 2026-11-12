import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runCodexRunner } from './codexRunner.ts';
import { execCommand } from './exec.ts';

const opts = { cwd: '/', stdin: '', env: { PATH: process.env.PATH }, timeoutMs: 30_000 };

async function runner() {
  const signals = new EventEmitter();
  const exits: number[] = [];
  const server = await runCodexRunner({ scratch: mkdtempSync(join(tmpdir(), 'fb-runner-proc-')), port: 0, host: '127.0.0.1', log: () => {}, signals, exit: (code) => exits.push(code) });
  return { signals, exits, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test.each(['SIGTERM', 'SIGINT'])('%s stops the running job, closes the server and exits 0', async (signal) => {
  const r = await runner();
  expect((await fetch(`${r.url}/health`)).status).toBeLessThan(600);
  const job = execCommand('sleep', ['30'], opts);
  await new Promise((ok) => setTimeout(ok, 100));
  r.signals.emit(signal);
  expect((await job).code).toBe(1);
  await expect.poll(() => r.exits).toEqual([0]);
  expect(r.server.listening).toBe(false);
});

test('a process exit without a signal still stops the running job', async () => {
  const r = await runner();
  const job = execCommand('sleep', ['30'], opts);
  await new Promise((ok) => setTimeout(ok, 100));
  r.signals.emit('exit');
  expect((await job).code).toBe(1);
  r.server.close();
});
