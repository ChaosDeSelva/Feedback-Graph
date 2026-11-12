import { constants, createCipheriv, createHash, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { encryptedRedactionArchive, publicRedactionArchive } from './encryptedArchive.ts';
import type { RedactionOriginal } from './redactionArchive.ts';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fg-archive-life-')); roots.push(root);
  return { path: join(root, 'archive'), keyDirectory: join(root, 'keys') };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = 'a'.repeat(64);
const name = (r: Pick<RedactionOriginal, 'kind' | 'id' | 'version'>) => createHash('sha256').update(JSON.stringify([r.kind, r.id, r.version])).digest('hex');
const encFiles = async (path: string) => (await readdir(path)).filter((n) => n.endsWith('.enc'));

describe('an incoming original is removed with the record it belongs to', () => {
  const cases: [string, RedactionOriginal, { kind: string; id: string }[]][] = [
    ['a lesson edit, by its lesson', { kind: 'lesson-edit-incoming', id: `lesson:L1:${hash}`, version: 1, value: 'x' }, [{ kind: 'lesson', id: 'lesson:L1' }]],
    ['facts, by their project', { kind: 'facts-incoming', id: `shop:${hash}`, version: 1, value: [] }, [{ kind: 'project', id: 'shop' }]],
    ['a post-mortem, by its feedback, miss or lesson', { kind: 'postmortem-incoming', id: `fb1:${hash}`, version: 1, value: null }, [{ kind: 'feedback', id: 'fb1' }, { kind: 'miss', id: 'miss:fb1' }, { kind: 'lesson', id: 'lesson:fb1' }]],
    ['anything naming its project', { kind: 'upload-incoming', id: 'u1', version: 1, value: { project_key: 'shop' } }, [{ kind: 'project', id: 'shop' }]],
    ['anything a run wrote, by the run', { kind: 'upload-incoming', id: 'u2', version: 1, value: { run: 'r1' } }, [{ kind: 'run', id: 'r1' }]],
    ['a document, by its project or its doc id', { kind: 'document-incoming', id: 'd1', version: 1, value: { doc: { projectKey: 'shop', source: 'upload', ref: 'a.md' } } }, [{ kind: 'project', id: 'shop' }, { kind: 'doc', id: 'doc:shop:upload:a.md' }]],
  ];
  for (const [what, record, selectors] of cases) {
    test(what, async () => {
      for (const selector of selectors) {
        const f = await fixture(); let now = Date.now();
        const worker = await encryptedRedactionArchive(f.path, { ...f, now: () => now });
        await worker.save(record);
        now++;
        // an unrelated selector removes nothing
        expect(await worker.remove([{ kind: selector.kind, id: `${selector.id}-other` }])).toBe(0);
        expect(await worker.remove([selector])).toBe(1);
        await expect(worker.read(record)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  }

  test('a document whose scope already names its doc is not also tagged by the doc fields it holds', async () => {
    const f = await fixture(); let now = Date.now();
    const worker = await encryptedRedactionArchive(f.path, { ...f, now: () => now });
    const record = { kind: 'document-incoming', id: 'd2', version: 1, value: { doc: { projectKey: 'shop', source: 'upload', ref: 'b.md' } }, scope: [{ kind: 'doc', id: 'doc:renamed' }] };
    await worker.save(record);
    now++;
    expect(await worker.remove([{ kind: 'doc', id: 'doc:shop:upload:b.md' }])).toBe(0);
    expect(await worker.remove([{ kind: 'doc', id: 'doc:renamed' }])).toBe(1);
  });

  test('removing nothing writes no marker', async () => {
    const f = await fixture();
    const api = await publicRedactionArchive(f.path);
    expect(await api.remove([])).toBe(0);
    expect(await readdir(f.path)).toEqual([]);
  });
});

describe('archive setup refuses unsafe layouts', () => {
  test('a retention outside 1 to 365 days', async () => {
    for (const retentionDays of [0, 366, Number.NaN]) {
      const f = await fixture();
      await expect(publicRedactionArchive(f.path, { retentionDays })).rejects.toThrow('REDACTION_ARCHIVE_RETENTION_DAYS must be between 1 and 365');
    }
  });

  test('decryption keys inside the archive the API can read', async () => {
    const f = await fixture();
    await expect(encryptedRedactionArchive(f.path, { keyDirectory: f.path })).rejects.toThrow('separate directory');
    await expect(encryptedRedactionArchive(f.path, { keyDirectory: join(f.path, 'keys') })).rejects.toThrow('separate directory');
  });

  test('an archive directory that is a symlink, or a private key that is not a file', async () => {
    const f = await fixture();
    await mkdir(join(f.path, '..', 'real'), { recursive: true });
    await symlink(join(f.path, '..', 'real'), f.path);
    await expect(publicRedactionArchive(f.path)).rejects.toThrow('redaction archive must be a real directory');
    const g = await fixture();
    await mkdir(join(g.keyDirectory, 'private.pem'), { recursive: true });
    await expect(encryptedRedactionArchive(g.path, g)).rejects.toThrow('invalid redaction archive file');
  });

  test('a legacy key that is not a file stops the worker instead of being migrated', async () => {
    const f = await fixture();
    await mkdir(join(f.path, 'key'), { recursive: true });
    await expect(encryptedRedactionArchive(f.path, f)).rejects.toThrow('invalid redaction archive file');
  });
});

test('the same original saved twice at once is stored once', async () => {
  const f = await fixture();
  await encryptedRedactionArchive(f.path, f);
  const api = await publicRedactionArchive(f.path);
  const record = { kind: 'fact', id: 'twice', version: 1, value: 'v' };
  await Promise.all([api.save(record), api.save(record)]);
  await api.save(record);
  expect(await encFiles(f.path)).toHaveLength(1);
  expect((await readdir(f.path)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
});

test('a damaged original is never overwritten by a later save, and reading it fails', async () => {
  const f = await fixture();
  const worker = await encryptedRedactionArchive(f.path, f);
  const record = { kind: 'fact', id: 'damaged', version: 1, value: 'v' };
  await writeFile(join(f.path, `${name(record)}.enc`), '{broken');
  await expect(worker.save(record)).rejects.toThrow(SyntaxError);
  await expect(worker.read(record)).rejects.toThrow(SyntaxError);
  expect(await readFile(join(f.path, `${name(record)}.enc`), 'utf8')).toBe('{broken');
});

test('an original filed under another identity is refused', async () => {
  const f = await fixture();
  const worker = await encryptedRedactionArchive(f.path, f);
  const asked = { kind: 'fact', id: 'asked', version: 1 }, stored = { kind: 'fact', id: 'swapped', version: 1, value: 'other secret' };
  // encrypted exactly as the writer does, but with another record's content under the asked identity
  const key = randomBytes(32), iv = randomBytes(12), file = name(asked);
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(file));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(stored)), cipher.final()]);
  const publicKey = await readFile(join(f.path, 'public.pem'));
  await writeFile(join(f.path, `${file}.enc`), JSON.stringify({
    format: 2, savedAt: Date.now(), tags: [], iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
    wrappedKey: publicEncrypt({ key: publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, key).toString('base64'),
  }));
  await expect(worker.read(asked)).rejects.toThrow('archive identity mismatch');
});

test('purge markers: a malformed one stops the purge, an expired one is dropped', async () => {
  const f = await fixture(); let now = Date.now();
  const worker = await encryptedRedactionArchive(f.path, { ...f, now: () => now, retentionDays: 1 });
  const marker = join(f.path, `delete-${hash}.purge`);
  await writeFile(marker, JSON.stringify({ at: now, tags: ['not-a-hash'] }));
  await expect(worker.purge()).rejects.toThrow('invalid archive purge marker');
  await writeFile(marker, JSON.stringify({ at: now, tags: [hash] }));
  await worker.purge();
  expect(await readdir(f.path)).toContain(`delete-${hash}.purge`);
  now += 2 * 86400_000;
  await worker.purge();
  expect(await readdir(f.path)).not.toContain(`delete-${hash}.purge`);
});

test('leftover temporary files are purged once expired; other names are left alone', async () => {
  const f = await fixture(); let now = Date.now();
  const worker = await encryptedRedactionArchive(f.path, { ...f, now: () => now, retentionDays: 1 });
  const tmp = join(f.path, `${hash}.0123456789abcdef.tmp`);
  await writeFile(tmp, 'partial');
  await writeFile(join(f.path, 'notes.txt'), 'keep');
  expect(await worker.purge()).toBe(0);
  now += 2 * 86400_000;
  await utimes(tmp, new Date(now - 2 * 86400_000), new Date(now - 2 * 86400_000));
  expect(await worker.purge()).toBe(1);
  expect((await readdir(f.path)).sort()).toEqual(['notes.txt', 'public.pem']);
});

test('the API purge never follows or deletes a symlink planted under an archive name', async () => {
  const f = await fixture(); let now = Date.now();
  const api = await publicRedactionArchive(f.path, { now: () => now, retentionDays: 1 });
  const outside = join(f.path, '..', 'outside.txt');
  await writeFile(outside, 'not archive data');
  const planted = join(f.path, `${'b'.repeat(64)}.enc`);
  await symlink(outside, planted);
  now += 2 * 86400_000;
  expect(await api.purge()).toBe(0);
  expect(await readdir(f.path)).toContain(`${'b'.repeat(64)}.enc`);
  expect(await readFile(outside, 'utf8')).toBe('not archive data');
});

test('the worker restores the lifecycle tags of current-format originals written without them', async () => {
  const f = await fixture(); let now = Date.now();
  await encryptedRedactionArchive(f.path, { ...f, now: () => now });
  const api = await publicRedactionArchive(f.path, { now: () => now });
  const record = { kind: 'upload-incoming', id: 'u9', version: 1, value: { projectKey: 'shop' } };
  await api.save(record);
  const file = join(f.path, `${name(record)}.enc`);
  const { tags: _drop, ...untagged } = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify(untagged));
  const worker = await encryptedRedactionArchive(f.path, { ...f, now: () => now });
  expect(JSON.parse(await readFile(file, 'utf8')).tags).toHaveLength(2);
  now++;
  expect(await worker.remove([{ kind: 'project', id: 'shop' }])).toBe(1);
});

test('an old-format original whose legacy key is gone does not stop the worker; it just cannot be read', async () => {
  const f = await fixture();
  await mkdir(f.path, { recursive: true });
  const record = { kind: 'fact', id: 'orphan', version: 1 };
  await writeFile(join(f.path, `${name(record)}.enc`), JSON.stringify({ iv: randomBytes(12).toString('base64'), tag: randomBytes(16).toString('base64'), ciphertext: '' }));
  const worker = await encryptedRedactionArchive(f.path, f);
  await expect(worker.read(record)).rejects.toMatchObject({ code: 'ENOENT' });
});
