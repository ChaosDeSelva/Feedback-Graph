import { archiveRedactionInput, setRedactionArchive, type RedactionOriginal } from '@fb/core';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { encryptedRedactionArchive } from './redactionArchive.ts';

test('encrypted originals survive restart, preserve the first version and never store plaintext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fg-archive-'));
  try {
    const r = { kind: 'fact', id: 'private-original-id', version: 8, value: { statement: 'the exact lost original secret text', current: true } };
    const archive = await encryptedRedactionArchive(directory);
    await archive.save(r);
    await archive.save({ ...r, value: { statement: '[REDACTED]', current: false } });
    const reopened = await encryptedRedactionArchive(directory);
    expect(await reopened.read(r)).toEqual(r);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'key'))).mode & 0o777).toBe(0o600);
    const files = (await readdir(directory)).filter(file => file.endsWith('.enc'));
    expect(files).toHaveLength(1);
    const stored = await readFile(join(directory, files[0]), 'utf8');
    expect(stored).not.toContain('original');
    expect(stored).not.toContain(r.id);
    expect((await stat(join(directory, files[0]))).mode & 0o777).toBe(0o600);
    await archive.save({ ...r, version: 9 });
    expect((await readdir(directory)).filter(file => file.endsWith('.enc'))).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('tampered originals fail authentication and cannot be silently overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fg-archive-'));
  try {
    const archive = await encryptedRedactionArchive(directory);
    const r = { kind: 'lesson', id: 'id', version: 8, value: 'original wording' };
    await archive.save(r);
    const filename = (await readdir(directory)).find(file => file.endsWith('.enc'))!;
    const file = join(directory, filename);
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.tag = Buffer.alloc(16).toString('base64');
    await writeFile(file, JSON.stringify(envelope));
    await expect(archive.read(r)).rejects.toThrow();
    await expect(archive.save(r)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('incoming archive keeps only changed values and gives successive edits stable distinct identities', async () => {
  const saved: RedactionOriginal[] = [];
  setRedactionArchive(async record => { saved.push(record); });
  try {
    await archiveRedactionInput('fact', 'project', { statement: 'intact' }, { statement: 'intact' });
    expect(saved).toEqual([]);
    await archiveRedactionInput('fact', 'project', { statement: 'first original' }, { statement: '[REDACTED]' });
    await archiveRedactionInput('fact', 'project', { statement: 'first original' }, { statement: '[REDACTED]' });
    await archiveRedactionInput('fact', 'project', { statement: 'second original' }, { statement: '[REDACTED]' });
    expect(saved[0].id).toBe(saved[1].id);
    expect(saved[2].id).not.toBe(saved[0].id);
    expect(saved[0].value).toEqual({ statement: 'first original' });
  } finally { setRedactionArchive(undefined); }
});
