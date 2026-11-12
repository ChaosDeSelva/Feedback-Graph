import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { sandbox } from './testing/restoreSandbox.ts';

// restore.sh refuses a backup too big to unpack or load before it writes anything or stops the stack.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });

test('a state.tgz that unpacks past FG_RESTORE_MAX_STATE_MB (a gzip bomb, a sparse file) is refused before anything is written', async () => {
  const s = sandbox();
  for (const [what, fill] of [
    ['zeros', (state: string) => writeFileSync(join(state, 'bomb'), Buffer.alloc(3 * 1048576))],
    ['sparse', (state: string) => execFileSync('dd', ['if=/dev/zero', `of=${join(state, 'sparse')}`, 'bs=1', 'count=0', 'seek=64m'], { stdio: 'ignore' })],
  ] as const) {
    await s.make(fill);
    const r = await s.restore({ FG_RESTORE_MAX_STATE_MB: '1' });
    expect(r.code, what).toBe(1);
    expect(r.err, what).toMatch(/state\.tgz in backups\/b1 unpacks to more than 1 MB \(FG_RESTORE_MAX_STATE_MB\); not restoring/);
    expect(r.err, what).toContain('nothing was replaced');
    expect(s.which(), what).toBe('live');
    expect(existsSync(join(s.repo, '.restore')), what).toBe(false);
  }
  // Within the default it restores.
  expect((await s.restore()).code).toBe(0);
});

test('a state.tgz with more files than FG_RESTORE_MAX_STATE_FILES is refused before it is unpacked', async () => {
  const s = sandbox();
  await s.make((state) => { for (let i = 0; i < 30; i++) writeFileSync(join(state, `f${i}`), 'x'); });
  const r = await s.restore({ FG_RESTORE_MAX_STATE_FILES: '10' });
  expect(r.code).toBe(1);
  expect(r.err).toContain('state.tgz in backups/b1 holds more than 10 files and folders (FG_RESTORE_MAX_STATE_FILES); not restoring');
  expect(s.which()).toBe('live');
});

test('a dump larger than the space free in the volume is refused before the stack is stopped', async () => {
  const s = sandbox();
  await s.make(() => {}, 3 * 1048576);
  const r = await s.restore({ FREE_KB: '1024' });
  expect(r.code).toBe(1);
  expect(r.err).toContain('the t_neo4j-data volume has 1 MB free, less than the 3 MB dump in backups/b1');
  expect(s.ran()).not.toContain('compose -p t stop');
  expect(s.which()).toBe('live');
});

test('a state.tgz larger than the space free beside state/ is refused before it is unpacked', async () => {
  const s = sandbox();
  await s.make((state) => writeFileSync(join(state, 'big'), Buffer.alloc(2 * 1048576)));
  writeFileSync(join(s.bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 9 0 1024 0%% /\\n"\n');
  chmodSync(join(s.bin, 'df'), 0o755);
  const r = await s.restore();
  expect(r.code).toBe(1);
  expect(r.err).toContain('has 1 MB free, less than the 2 MB state.tgz in backups/b1 unpacks to');
  expect(s.which()).toBe('live');
});
