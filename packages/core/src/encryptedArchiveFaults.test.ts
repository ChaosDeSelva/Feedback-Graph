import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { link, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { encryptedRedactionArchive, publicRedactionArchive } from './encryptedArchive.ts';
import type { RedactionOriginal } from './redactionArchive.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), unlink: vi.fn(actual.unlink) };
});
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fg-archive-faults-')); roots.push(root);
  return { path: join(root, 'archive'), keyDirectory: join(root, 'keys') };
}
afterEach(async () => {
  vi.mocked(link).mockReset();
  vi.mocked(unlink).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(link).mockImplementation(actual.link);
  vi.mocked(unlink).mockImplementation(actual.unlink);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const record = { kind: 'fact', id: 'f1', version: 1, value: 'original words' };
const name = (r: Pick<RedactionOriginal, 'kind' | 'id' | 'version'>) => createHash('sha256').update(JSON.stringify([r.kind, r.id, r.version])).digest('hex');
const fault = (code: string) => Object.assign(new Error(code), { code });
/** An old-format (v8) original: AES-GCM under the legacy symmetric key, filed under `file`'s identity. */
function legacyEnvelope(key: Buffer, file: string, content: object) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(file));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content)), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}

test('a file system that refuses the hard link a save publishes with fails the save, leaving no partial file', async () => {
  const f = await fixture();
  await encryptedRedactionArchive(f.path, f);
  const api = await publicRedactionArchive(f.path);
  vi.mocked(link).mockRejectedValueOnce(fault('EPERM'));
  await expect(api.save(record)).rejects.toMatchObject({ code: 'EPERM' });
  expect((await readdir(f.path)).filter((n) => n.endsWith('.tmp') || n.endsWith('.enc'))).toEqual([]);
});

test('a temporary file that cannot be removed after the save fails it loudly instead of leaving it unnoticed', async () => {
  const f = await fixture();
  await encryptedRedactionArchive(f.path, f);
  const api = await publicRedactionArchive(f.path);
  vi.mocked(unlink).mockRejectedValueOnce(fault('EACCES'));
  await expect(api.save(record)).rejects.toMatchObject({ code: 'EACCES' });
});

test('a save over something at the original\'s name that is not a file (a planted symlink) is refused', async () => {
  const f = await fixture();
  await encryptedRedactionArchive(f.path, f);
  const api = await publicRedactionArchive(f.path);
  await writeFile(join(f.path, '..', 'elsewhere'), 'x');
  await symlink(join(f.path, '..', 'elsewhere'), join(f.path, `${name(record)}.enc`));
  await expect(api.save(record)).rejects.toThrow('invalid redaction archive file');
});

test('a legacy key that differs from the one the worker already holds stops start-up and stays where the API refuses it', async () => {
  const f = await fixture();
  await mkdir(f.path, { recursive: true }); await mkdir(f.keyDirectory, { recursive: true });
  await writeFile(join(f.keyDirectory, 'legacy.key'), randomBytes(32));
  await writeFile(join(f.path, 'key'), randomBytes(32));
  await expect(encryptedRedactionArchive(f.path, f)).rejects.toThrow('legacy archive key mismatch');
  await expect(publicRedactionArchive(f.path)).rejects.toThrow('legacy archive key');
});

test('an old-format original filed under another identity stops start-up', async () => {
  const f = await fixture();
  const key = randomBytes(32);
  await mkdir(f.path, { recursive: true }); await writeFile(join(f.path, 'key'), key);
  const file = name(record);
  await writeFile(join(f.path, `${file}.enc`), legacyEnvelope(key, file, { ...record, id: 'swapped' }));
  await expect(encryptedRedactionArchive(f.path, f)).rejects.toThrow('archive identity mismatch');
});

test('a legacy key the worker cannot remove once nothing needs it stops start-up', async () => {
  const f = await fixture();
  await mkdir(join(f.keyDirectory, 'legacy.key'), { recursive: true });
  await expect(encryptedRedactionArchive(f.path, f)).rejects.toMatchObject({ code: expect.stringMatching(/^(EPERM|EISDIR)$/) });
});

test('an old-format original the worker could not index is matched by no removal and kept until it expires by its file time', async () => {
  const f = await fixture(); let now = Date.now();
  await mkdir(f.path, { recursive: true });
  const file = name(record);
  // Its legacy key is gone, so the worker leaves it untagged.
  await writeFile(join(f.path, `${file}.enc`), legacyEnvelope(randomBytes(32), file, record));
  await encryptedRedactionArchive(f.path, { ...f, now: () => now, retentionDays: 1 });
  const api = await publicRedactionArchive(f.path, { now: () => now, retentionDays: 1 });
  now += 1000;
  expect(await api.remove([{ kind: record.kind, id: record.id }])).toBe(0);
  expect(await readdir(f.path)).toContain(`${file}.enc`);
  now += 2 * 86400_000;
  expect(await api.purge()).toBe(1);
});
