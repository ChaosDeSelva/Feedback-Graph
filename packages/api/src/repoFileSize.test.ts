import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { repoFileSize } from './context.ts';

test('repoFileSize reads the size of a repo file only, under the rules hashRepoFile reads it by', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbsize-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/big.ts'), 'x'.repeat(1234));
  expect(await repoFileSize(dir, 'src/big.ts')).toBe(1234);
  // Not a relative path inside the repo, or a secret by name: never stat'ed.
  for (const rel of ['', '/etc/hosts', '../etc/hosts', 'src//big.ts', '.env']) expect(await repoFileSize(dir, rel)).toBeNull();
  writeFileSync(join(dir, '.env'), 'A=b\n');
  expect(await repoFileSize(dir, '.env')).toBeNull();
  // Missing, a folder, a link out of the repo, or a harmless name linked to a secret inside it.
  expect(await repoFileSize(dir, 'src/missing.ts')).toBeNull();
  expect(await repoFileSize(dir, 'src')).toBeNull();
  const outside = mkdtempSync(join(tmpdir(), 'fbsize-out-'));
  writeFileSync(join(outside, 'x.ts'), 'outside');
  symlinkSync(outside, join(dir, 'linked'));
  expect(await repoFileSize(dir, 'linked/x.ts')).toBeNull();
  symlinkSync(join(dir, '.env'), join(dir, 'src/config.ts'));
  expect(await repoFileSize(dir, 'src/config.ts')).toBeNull();
  // A repo that does not exist.
  expect(await repoFileSize(join(dir, 'gone'), 'src/big.ts')).toBeNull();
});
