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
    const key = 'c2ad856fb97403e18a2e7dc9015b6f438670dcaeb3219a845f0d7c8b6e109234';
    expect(runKey(key, first)).toBe(runKey(key, first));
    expect(runKey(key, first)).not.toBe(runKey(key, await loadRunKeySalt(join(dir, 'other'))));
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('run capabilities reject obvious low-diversity and repeated keys', () => {
  for (const key of ['x'.repeat(64), 'abcd'.repeat(32), '01234567'.repeat(8), '0123456789abcdef'.repeat(4), 'a'.repeat(60) + 'bcdefghi']) expect(runKey(key)).toBeNull();
  expect(runKey('c2ad856fb97403e18a2e7dc9015b6f438670dcaeb3219a845f0d7c8b6e109234')).not.toBeNull();
});
