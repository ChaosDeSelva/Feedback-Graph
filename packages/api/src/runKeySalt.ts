import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Per-installation secret: stable across restarts, private on the API's writable settings volume. */
export async function loadRunKeySalt(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const value = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('invalid private run-key salt file');
  return value;
}
