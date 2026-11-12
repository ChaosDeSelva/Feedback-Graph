import { afterEach, expect, test } from 'vitest';
import { archiveRedactionInput, archiveRunFileSelector, purgeRedactionOriginals, setRedactionArchive, setRedactionArchivePurger, type ArchiveSelector, type RedactionOriginal } from './redactionArchive.ts';
import { REDACTION_VERSION } from './redact.ts';
import { withStoreWriteAuthorizer } from './storeWrites.ts';

afterEach(() => {
  setRedactionArchive(undefined);
  setRedactionArchivePurger(undefined);
});

test('a run file selector keeps the exact run, project and path, so near-identical paths never collide', () => {
  expect(archiveRunFileSelector('r1', 'shop', 'a/b.md')).toEqual({ kind: 'run-file', id: '["r1","shop","a/b.md"]' });
  expect(archiveRunFileSelector('r1', 'shop', 'A/b.md').id).not.toBe(archiveRunFileSelector('r1', 'shop', 'a/b.md').id);
  expect(archiveRunFileSelector('r1', 'sh","op', 'x').id).not.toBe(archiveRunFileSelector('r1', 'sh', 'op","x').id);
});

test('purging originals authorizes first, then forgets the selectors; nothing to purge or no purger is a no-op', async () => {
  const forgotten: ArchiveSelector[][] = [];
  const sel = [archiveRunFileSelector('r1', 'shop', 'a.md')];
  await purgeRedactionOriginals(sel); // no purger set: nothing happens
  setRedactionArchivePurger(async (s) => { forgotten.push(s); });
  let claims = 0;
  await withStoreWriteAuthorizer(async () => { claims++; }, async () => {
    await purgeRedactionOriginals([]);
    expect(claims).toBe(0);
    await purgeRedactionOriginals(sel);
  });
  expect(claims).toBe(1);
  expect(forgotten).toEqual([sel]);
  await expect(withStoreWriteAuthorizer(async () => { throw new Error('denied'); }, () => purgeRedactionOriginals(sel))).rejects.toThrow('denied');
  expect(forgotten).toHaveLength(1);
});

test('only an input redaction changed is archived, keyed by its content (and scope), at the current redaction version', async () => {
  const saved: RedactionOriginal[] = [];
  await archiveRedactionInput('upload', 'k', 'secret', '[REDACTED]'); // no archive set: nothing to do
  setRedactionArchive(async (r) => { saved.push(r); });
  await archiveRedactionInput('upload', 'k', { a: 'same' }, { a: 'same' });
  expect(saved).toEqual([]);
  const scope = [archiveRunFileSelector('r1', 'shop', 'a.md')];
  await archiveRedactionInput('upload', 'k', 'one', '[REDACTED]');
  await archiveRedactionInput('upload', 'k', 'two', '[REDACTED]');
  await archiveRedactionInput('upload', 'k', 'one', '[REDACTED]', scope);
  expect(saved.map((r) => [r.kind, r.value, r.version, r.scope])).toEqual([
    ['upload-incoming', 'one', REDACTION_VERSION, undefined],
    ['upload-incoming', 'two', REDACTION_VERSION, undefined],
    ['upload-incoming', 'one', REDACTION_VERSION, scope],
  ]);
  // successive edits and a scoped copy each get their own identity
  expect(new Set(saved.map((r) => r.id)).size).toBe(3);
  expect(saved.every((r) => /^k:[0-9a-f]{64}$/.test(r.id))).toBe(true);
});
