import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { nfcPaths } from './git.ts';

test('nfcPaths lists a file named in NFC and NFD once, as NFC; a name only on disk in NFD stays as it is there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-nfc-'));
  try {
    const both = ['src/café.ts', 'src/café.ts'.normalize('NFD'), 'src/a.ts'];
    expect(await nfcPaths(dir, both)).toEqual(['src/café.ts', 'src/a.ts']);
    // Neither spelling is on disk here: the listed one is kept, so a read still finds what git listed.
    expect(await nfcPaths(dir, ['menü.ts'.normalize('NFD')])).toEqual(['menü.ts'.normalize('NFD')]);
    // On disk under a file system that opens it by its NFC name too (APFS), it is NFC.
    writeFileSync(join(dir, 'menü.ts'.normalize('NFD')), '');
    if (process.platform === 'darwin') expect(await nfcPaths(dir, ['menü.ts'.normalize('NFD')])).toEqual(['menü.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
