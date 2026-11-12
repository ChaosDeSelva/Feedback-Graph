import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { SCRIPT_TEST_TIMEOUT_MS } from '../testing/exec.ts';
import { commandRunner, execCommand, killRunningCommands } from './exec.ts';

const opts = { cwd: '/', stdin: '', env: { PATH: process.env.PATH }, timeoutMs: 10_000 };
// Each command sleeps far past the test's own timeout: one that is not stopped fails the test instead of passing late.

/** A file the command creates once it is where the test needs it, and a wait for it on real timers. */
const marker = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fb-signals-')), 'ready');
  return { touch: `: > '${file}'`, reached: async () => { while (!existsSync(file)) await sleep(10); } };
};

test('a timeout stops the tools a command left running after it exited itself (they hold its pipes)', async () => {
  const ready = marker();
  // The timeout runs on a fake timer, fired once the tool is running, however slowly a loaded machine starts it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = execCommand('sh', ['-c', `echo started; sleep 300 & ${ready.touch}`], { ...opts, timeoutMs: 200 });
    await ready.reached();
    vi.advanceTimersByTime(200);
    expect(await pending).toMatchObject({ code: 124, stdout: 'started\n' });
  } finally {
    vi.useRealTimers();
  }
}, SCRIPT_TEST_TIMEOUT_MS);

test('shutdown stops the tools a command left running after it exited itself', async () => {
  const ready = marker();
  const pending = execCommand('sh', ['-c', `echo started; sleep 300 & ${ready.touch}`], opts);
  await ready.reached();
  killRunningCommands();
  expect((await pending).stdout).toBe('started\n');
}, SCRIPT_TEST_TIMEOUT_MS);

test('a command stopped at shutdown is a failure even when it exits 0 (it saw its tool die first)', async () => {
  // Stands in for a CLI that sees its tool die and exits 0 before its own SIGKILL lands (seen on macOS).
  const exec = commandRunner((pid) => process.kill(pid, 'SIGTERM'));
  const ready = marker();
  const pending = exec('sh', ['-c', `trap "exit 0" TERM; sleep 300 & ${ready.touch}; wait`], opts);
  await ready.reached();
  killRunningCommands();
  expect((await pending).code).toBe(1);
}, SCRIPT_TEST_TIMEOUT_MS);

test('a SIGTERM that finds no process group does not stop the timeout: the SIGKILL follows', async () => {
  const exec = commandRunner((pid, signal) => {
    if (signal === 'SIGTERM') throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    process.kill(pid, signal);
  });
  // The timeout and the grace period run on fake timers: both pass at once, and only the SIGKILL can end the sleep.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = exec('sleep', ['300'], { ...opts, timeoutMs: 100, killGraceMs: 100 });
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect((await pending).code).toBe(124);
  } finally {
    vi.useRealTimers();
  }
}, SCRIPT_TEST_TIMEOUT_MS);
