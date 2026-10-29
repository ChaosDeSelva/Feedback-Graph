import { randomBytes } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { encryptedRedactionArchive, publicRedactionArchive } from './encryptedArchive.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fg-public-archive-')); roots.push(root);
  return { path: join(root, 'archive'), keyDirectory: join(root, 'keys') };
}
afterEach(async () => { vi.mocked(open).mockRestore(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const record = { kind: 'fact', id: 'private-id', version: 9, value: { statement: 'original words' } };

test('the API writer exposes no decryption method and produces originals readable only with the worker key', async () => {
  const f = await fixture();
  const worker = await encryptedRedactionArchive(f.path, f);
  const api = await publicRedactionArchive(f.path);
  expect(Object.keys(api).sort()).toEqual(['purge', 'save']);
  await api.save(record);
  expect(await worker.read(record)).toEqual(record);
  expect(await readdir(f.path)).not.toContain('private.pem');
  const name = (await readdir(f.path)).find(n => n.endsWith('.enc'))!;
  expect(await readFile(join(f.path, name), 'utf8')).not.toContain('original words');
});

test('API startup refuses a legacy shared symmetric key until the worker migrates it', async () => {
  const f = await fixture();
  const api = await publicRedactionArchive(f.path);
  await writeFile(join(f.path, 'key'), randomBytes(32));
  await expect(publicRedactionArchive(f.path)).rejects.toThrow('legacy archive key');
  const worker = await encryptedRedactionArchive(f.path, f);
  expect(await readdir(f.path)).not.toContain('key');
  expect(await readFile(join(f.keyDirectory, 'legacy.key'))).toHaveLength(32);
  await api.save(record);
  expect(await worker.read(record)).toEqual(record);
});

test('a failed atomic write removes its temporary file', async () => {
  const f = await fixture();
  await encryptedRedactionArchive(f.path, f);
  const api = await publicRedactionArchive(f.path);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    return { writeFile: async () => { throw Error('disk full'); }, sync: () => handle.sync(), close: () => handle.close() } as unknown as Awaited<ReturnType<typeof open>>;
  });
  await expect(api.save(record)).rejects.toThrow('disk full');
  expect((await readdir(f.path)).filter(n => n.endsWith('.tmp') || n.endsWith('.enc'))).toEqual([]);
});

test('expired originals do not block redaction or renew retention and are purged', async () => {
  const f = await fixture();
  let now = Date.now();
  const archive = await encryptedRedactionArchive(f.path, { ...f, now: () => now, retentionDays: 1 });
  await archive.save(record);
  const filename = (await readdir(f.path)).find(n => n.endsWith('.enc'))!;
  const file = join(f.path, filename), before = await readFile(file, 'utf8');
  now += 2 * 86400_000;
  await expect(archive.read(record)).rejects.toThrow('expired');
  await expect(archive.save({ ...record, value: { statement: 'redacted replacement' } })).resolves.toBeUndefined();
  expect(await readFile(file, 'utf8')).toBe(before);
  await utimes(file, new Date(now - 2 * 86400_000), new Date(now - 2 * 86400_000));
  expect(await archive.purge()).toBe(1);
  await expect(archive.read(record)).rejects.toMatchObject({ code: 'ENOENT' });
});
