import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RedactionOriginal } from '@fb/core';

/** Authenticated encrypted originals, exclusively on the local settings volume. Never exposed through API/export. */
export async function encryptedRedactionArchive(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('redaction archive must be a real directory');
  await chmod(directory, 0o700);
  const keyPath = join(directory, 'key');
  try {
    const file = await open(keyPath, 'wx', 0o600);
    try { await file.writeFile(randomBytes(32)); await file.sync(); } finally { await file.close(); }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  if (!(await lstat(keyPath)).isFile() || (await lstat(keyPath)).isSymbolicLink()) throw new Error('invalid redaction archive key');
  await chmod(keyPath, 0o600);
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new Error('invalid redaction archive key length');
  const identity = (r: Pick<RedactionOriginal, 'kind' | 'id' | 'version'>) => createHash('sha256').update(JSON.stringify([r.kind, r.id, r.version])).digest('hex');
  const read = async (r: Pick<RedactionOriginal, 'kind' | 'id' | 'version'>): Promise<RedactionOriginal> => {
    const name = identity(r);
    const file = join(directory, name + '.enc');
    if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error('invalid archive entry');
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { iv: string; tag: string; ciphertext: string };
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(name)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as RedactionOriginal;
    if (identity(value) !== name) throw new Error('archive identity mismatch');
    return value;
  };
  const save = async (r: RedactionOriginal) => {
    const name = identity(r);
    const target = join(directory, name + '.enc');
    try { await read(r); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(name));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(r), 'utf8'), cipher.final()]);
    const temp = join(directory, name + '.' + randomBytes(8).toString('hex') + '.tmp');
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
      await file.sync();
    } finally { await file.close(); }
    try { await link(temp, target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await read(r); }
    finally { await unlink(temp); }
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  };
  return { save, read };
}
