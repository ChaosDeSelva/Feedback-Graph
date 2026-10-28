import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadRunKeySalt } from './runKeySalt.ts';
import { runKey } from './operator.ts';

test('installation salts are private and stable, and separate identical caller keys between installations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fg-run-salt-'));
  try {
    const path = join(dir, 'salt');
    const first = await loadRunKeySalt(path);
    expect(await loadRunKeySalt(path)).toBe(first);
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(first);
    const key = 'client-capability-'.padEnd(40, 'a');
    expect(runKey(key, first)).toBe(runKey(key, first));
    expect(runKey(key, first)).not.toBe(runKey(key, await loadRunKeySalt(join(dir, 'other'))));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
