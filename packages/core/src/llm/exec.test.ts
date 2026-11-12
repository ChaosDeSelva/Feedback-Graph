import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { SCRIPT_TEST_TIMEOUT_MS } from '../testing/exec.ts';
import { execCommand, killRunningCommands } from './exec.ts';

const opts = { cwd: '/', stdin: '', env: { PATH: process.env.PATH }, timeoutMs: 10_000 };

test('a command gets its stdin and returns its exit code and both streams', async () => {
  const r = await execCommand('sh', ['-c', 'cat; echo oops >&2; exit 3'], { ...opts, stdin: 'hello' });
  expect(r).toEqual({ code: 3, stdout: 'hello', stderr: 'oops\n' });
});

test('a command that exits without reading its input is reported by its exit code, never an EPIPE error', async () => {
  // Far more than a pipe buffer holds, so writing it fails once the command has gone.
  const r = await execCommand('sh', ['-c', 'exit 3'], { ...opts, stdin: 'x'.repeat(8 << 20) });
  expect(r.code).toBe(3);
});

test('a command that cannot be started rejects', async () => {
  await expect(execCommand('/nonexistent/fg-cli', [], opts)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a command killed by a signal is a failure, not a success', async () => {
  const r = await execCommand('sh', ['-c', 'kill -KILL $$'], opts);
  expect(r.code).toBe(1);
});

/** A file the command creates once it has started, and a wait for it on real timers. */
const started = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fb-exec-')), 'started');
  return { touch: `: > '${file}'`, wait: async () => { while (!existsSync(file)) await sleep(10); } };
};

test('a timeout stops a command that honours SIGTERM, reported as 124', async () => {
  const ready = started();
  // The timeout runs on a fake timer, fired once the command runs, however slowly a loaded machine starts it; were it
  // not stopped, the 300 s sleep would outlast the test.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = execCommand('sh', ['-c', `echo partial; sleep 300 & ${ready.touch}; wait`], { ...opts, timeoutMs: 100 });
    await ready.wait();
    vi.advanceTimersByTime(100);
    const r = await pending;
    expect(r.code).toBe(124);
    expect(r.stdout).toBe('partial\n');
    expect(r.stderr).toMatch(/sh timed out after 100ms$/);
  } finally {
    vi.useRealTimers();
  }
}, SCRIPT_TEST_TIMEOUT_MS);

test('killRunningCommands stops running commands and the tools they started (shutdown)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-exec-'));
  const pidFile = join(dir, 'tool.pid');
  // the grandchild holds the pipes open: only killing the whole group lets the command finish before the test's timeout
  const pending = execCommand('sh', ['-c', `sleep 300 & echo $! > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'; wait`], opts);
  while (!existsSync(pidFile)) await sleep(10);
  const tool = Number(readFileSync(pidFile, 'utf8'));
  killRunningCommands();
  await pending;
  // Not its exit status: on macOS the shell has been seen to outlive the group SIGKILL by a moment, reap the killed tool
  // and exit 0. What shutdown needs is that nothing is left running.
  const alive = () => { try { process.kill(tool, 0); return true; } catch { return false; } };
  while (alive()) await sleep(10);
  // a second call has nothing left to stop
  expect(() => killRunningCommands()).not.toThrow();
}, SCRIPT_TEST_TIMEOUT_MS);
