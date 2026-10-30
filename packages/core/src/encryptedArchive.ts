import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import type { RedactionOriginal, ArchiveSelector } from './redactionArchive.ts';

type Identity = Pick<RedactionOriginal, 'kind' | 'id' | 'version'>;
type Envelope = { format?: number; iv: string; tag: string; ciphertext: string; wrappedKey?: string; savedAt?: number; tags?: string[] };
type Options = { keyDirectory?: string; retentionDays?: number; now?: () => number };
const identity = (r: Identity) => createHash('sha256').update(JSON.stringify([r.kind, r.id, r.version])).digest('hex');
const tag = (kind: string, id: string) => createHash('sha256').update(JSON.stringify([kind, id])).digest('hex');
function archiveTags(record: RedactionOriginal): string[] {
  const selectors: ArchiveSelector[] = [{ kind: record.kind, id: record.id }, ...(record.scope ?? [])];
  const base = record.id.replace(/:[a-f0-9]{64}$/, '');
  const kind = ({ 'facts-incoming': 'project', 'fact-incoming': 'project', 'lesson-incoming': 'lesson', 'lesson-edit-incoming': 'lesson', 'lesson-draft-incoming': 'lesson', 'document-reading-incoming': 'doc', 'postmortem-incoming': 'feedback' } as Record<string, string>)[record.kind];
  if (kind) selectors.push({ kind, id: base });
  if (record.kind === 'postmortem-incoming') selectors.push({ kind: 'miss', id: `miss:${base}` }, { kind: 'lesson', id: `lesson:${base}` });
  const value = record.value as { projectKey?: unknown; project_key?: unknown; run?: unknown; doc?: { projectKey?: unknown; source?: unknown; ref?: unknown } } | null;
  if (value && typeof value === 'object') {
    const project = value.projectKey ?? value.project_key ?? value.doc?.projectKey;
    if (typeof project === 'string') selectors.push({ kind: 'project', id: project });
    if (typeof value.run === 'string') selectors.push({ kind: 'run', id: value.run });
    if (record.kind === 'document-incoming' && value.doc && ['projectKey', 'source', 'ref'].every(key => typeof value.doc![key as keyof typeof value.doc] === 'string') && !record.scope?.some(s => s.kind === 'doc')) {
      selectors.push({ kind: 'doc', id: `doc:${value.doc.projectKey}:${value.doc.source}:${value.doc.ref}` });
    }
  }
  return [...new Set(selectors.map(s => tag(s.kind, s.id)))];
}
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('redaction archive must be a real directory');
  await chmod(path, 0o700);
}
async function safeRead(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid redaction archive file');
  return readFile(path);
}
async function atomic(path: string, bytes: string | Buffer, replace = false) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      if (replace) await rename(temporary, path);
      else await link(temporary, path);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const parent = await open(dirname(path), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await unlink(temporary).catch(e => { if (!isMissing(e)) throw e; }); }
}
function retention(o: Options) {
  const days = o.retentionDays ?? 30;
  if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error('REDACTION_ARCHIVE_RETENTION_DAYS must be between 1 and 365');
  return days * 86400_000;
}
class ArchiveExpiredError extends Error { constructor() { super('redaction archive entry expired'); } }

/** API uses only this public-key writer. It cannot decrypt current or historical entries. */
export async function publicRedactionArchive(path: string, o: Options = {}) {
  await directory(path);
  // A v8 symmetric key in the shared mount would let API callers decrypt old entries.
  // Refuse startup until the worker has moved it to its private volume.
  try {
    await lstat(join(path, 'key'));
    throw new Error('legacy archive key must be moved by the worker before API archive startup');
  } catch (e) { if (!isMissing(e)) throw e; }
  const lifetime = retention(o), now = o.now ?? Date.now;
  const save = async (record: RedactionOriginal) => {
    const name = identity(record), target = join(path, `${name}.enc`);
    try { await safeRead(target); return; } catch (e) { if (!isMissing(e)) throw e; }
    const publicKey = await safeRead(join(path, 'public.pem'));
    const contentKey = randomBytes(32), iv = randomBytes(12);
    const savedAt = now();
    const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
    cipher.setAAD(Buffer.from(name));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ ...record, savedAt }), 'utf8'), cipher.final()]);
    const envelope: Envelope = { format: 2, savedAt, tags: archiveTags(record), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
      wrappedKey: publicEncrypt({ key: publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, contentKey).toString('base64') };
    contentKey.fill(0);
    await atomic(target, JSON.stringify(envelope));
  };
  const pending = async () => {
    const entries: { tags: Set<string>; at: number }[] = [];
    for (const name of await readdir(path)) if (/^delete-[a-f0-9]{64}\.purge$/.test(name)) {
      const value = JSON.parse((await safeRead(join(path, name))).toString());
      if (!Number.isFinite(value.at) || !Array.isArray(value.tags) || !value.tags.every((t: unknown) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t))) throw Error('invalid archive purge marker');
      if (now() - value.at >= lifetime) await unlink(join(path, name)); else entries.push({ at: value.at, tags: new Set(value.tags) });
    }
    return entries;
  };
  const purge = async () => {
    let removed = 0;
    const requests = await pending();
    for (const name of await readdir(path)) {
      if (!/^[a-f0-9]{64}(?:\.enc|\.[a-f0-9]{16}\.tmp)$/.test(name)) continue;
      const file = join(path, name), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const envelope: Envelope | null = name.endsWith('.enc') ? JSON.parse((await safeRead(file)).toString()) : null;
      const deleted = envelope && requests.some(request => (envelope.savedAt ?? info.mtimeMs) <= request.at && envelope.tags?.some(t => request.tags.has(t)));
      if (deleted || now() - (envelope?.savedAt ?? info.mtimeMs) >= lifetime) { await unlink(file); removed++; }
    }
    return removed;
  };
  const remove = async (selectors: ArchiveSelector[]) => {
    if (!selectors.length) return 0;
    const tags = [...new Set(selectors.map(s => tag(s.kind, s.id)))].sort();
    const name = createHash('sha256').update(JSON.stringify(tags)).digest('hex');
    await atomic(join(path, `delete-${name}.purge`), JSON.stringify({ tags, at: now() }), true);
    return purge();
  };
  return { save, purge, remove };
}
/** Worker-only private key lives on a separate volume, never in API mounts or ordinary state backups. */
export async function encryptedRedactionArchive(path: string, o: Options = {}) {
  await directory(path);
  const keys = o.keyDirectory ?? `${path}-keys`;
  if (keys === path || (!relative(path, keys).startsWith('..') && !isAbsolute(relative(path, keys)))) throw new Error('archive decryption keys require a separate directory');
  if (o.keyDirectory && keys.endsWith('/private')) await directory(dirname(keys));
  await directory(keys);
  const privatePath = join(keys, 'private.pem'), publicPath = join(path, 'public.pem');
  let privateKey: Buffer;
  try { privateKey = await safeRead(privatePath); }
  catch (e) {
    if (!isMissing(e)) throw e;
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    await atomic(privatePath, pair.privateKey);
    privateKey = await safeRead(privatePath);
  }
  await chmod(privatePath, 0o600);
  // Derive from the key that won a concurrent startup, then atomically publish only the public half.
  const { createPublicKey } = await import('node:crypto');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  await atomic(publicPath, publicKey, true);
  // Remove the v8 symmetric key from the API-visible mount before accepting writes. Keep it only in the worker volume.
  const legacyPath = join(keys, 'legacy.key');
  try {
    const legacy = await safeRead(join(path, 'key'));
    await atomic(legacyPath, legacy);
    if (!(await safeRead(legacyPath)).equals(legacy)) throw new Error('legacy archive key mismatch');
    await unlink(join(path, 'key'));
  } catch (e) { if (!isMissing(e)) throw e; }
  const writer = await publicRedactionArchive(path, o);
  const lifetime = retention(o), now = o.now ?? Date.now;
  const read = async (r: Identity): Promise<RedactionOriginal> => {
    const name = identity(r), file = join(path, `${name}.enc`);
    const envelope = JSON.parse((await safeRead(file)).toString()) as Envelope;
    if (now() - (envelope.savedAt ?? (await lstat(file)).mtimeMs) >= lifetime) throw new ArchiveExpiredError();
    const contentKey = envelope.format === 2
      ? privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrappedKey!, 'base64'))
      : await safeRead(legacyPath);
    const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(name)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString()) as RedactionOriginal;
    contentKey.fill(0);
    if (identity(value) !== name) throw new Error('archive identity mismatch');
    return { kind: value.kind, id: value.id, version: value.version, value: value.value, ...(value.scope && { scope: value.scope }) };
  };
  const save = async (r: RedactionOriginal) => {
    try { await read(r); return; } catch (e) {
      // An expired original stays expired; the hourly purge will remove it. Do not
      // let its presence block the redaction write or silently renew its retention.
      if (e instanceof ArchiveExpiredError) return;
      if (!isMissing(e)) throw e;
    }
    await writer.save(r);
  };
  // The worker alone can recover lifecycle tags on envelopes written before this index existed.
  for (const name of await readdir(path)) if (/^[a-f0-9]{64}\.enc$/.test(name)) {
    const file = join(path, name), envelope = JSON.parse((await safeRead(file)).toString()) as Envelope;
    if (envelope.tags) continue;
    try {
      const contentKey = envelope.format === 2 ? privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrappedKey!, 'base64')) : await safeRead(legacyPath);
      const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(name.slice(0, -4))); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString()) as RedactionOriginal;
      contentKey.fill(0);
      if (identity(record) !== name.slice(0, -4)) throw Error('archive identity mismatch');
      await atomic(file, JSON.stringify({ ...envelope, savedAt: envelope.savedAt ?? (await lstat(file)).mtimeMs, tags: archiveTags(record) }), true);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  const purge = async () => {
    const count = await writer.purge();
    // Retire the legacy symmetric key as soon as no surviving v8 ciphertext requires it.
    let legacy = false;
    for (const name of await readdir(path)) if (/^[a-f0-9]{64}\.enc$/.test(name)) {
      if ((JSON.parse((await safeRead(join(path, name))).toString()) as Envelope).format !== 2) { legacy = true; break; }
    }
    if (!legacy) await unlink(legacyPath).catch(error => { if (!isMissing(error)) throw error; });
    return count;
  };
  await purge();
  return { save, read, purge, remove: async (selectors: ArchiveSelector[]) => { const count = await writer.remove(selectors); await purge(); return count; } };
}
