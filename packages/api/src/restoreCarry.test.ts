import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { sandbox } from './testing/restoreSandbox.ts';

// What restore.sh carries from the live state/ into the restored one, and what it drops from the backup's.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });

test('the runner flag is carried over only as a plain file, a few KiB of its printable text, never a file a link names', async () => {
  const s = sandbox();
  await s.make();
  const flag = join(s.repo, 'state', 'runner-control', 'codex-runner-disabled');
  mkdirSync(dirname(flag), { recursive: true });
  const secret = join(s.repo, 'host-secret');
  writeFileSync(secret, 'SECRET-CANARY-7f3a\n');
  symlinkSync(secret, flag);
  expect((await s.restore()).code).toBe(0);
  expect(existsSync(flag)).toBe(false);
  // A plain flag comes over, cut to size, control characters dropped.
  rmSync(join(s.repo, 'state', 'runner-control'), { recursive: true, force: true });
  mkdirSync(dirname(flag), { recursive: true });
  writeFileSync(flag, `network: reached the api\x1b[31m\n${'x'.repeat(20_000)}\n`);
  expect((await s.restore()).code).toBe(0);
  const carried = readFileSync(flag, 'utf8');
  expect(carried.startsWith('network: reached the api[31m\n')).toBe(true);
  expect(carried.length).toBeLessThanOrEqual(4096);
});

test('a restore-incomplete marker inside a backup is not restored, so it cannot keep the worker from starting', async () => {
  const s = sandbox();
  await s.make((state) => writeFileSync(join(state, '.restore-incomplete'), 'a restore from elsewhere did not finish\n'));
  expect((await s.restore()).code).toBe(0);
  expect(s.which()).toBe('backup');
  expect(existsSync(join(s.repo, 'state', '.restore-incomplete'))).toBe(false);
});
