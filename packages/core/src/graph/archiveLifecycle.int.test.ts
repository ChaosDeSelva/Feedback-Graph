import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptedRedactionArchive, publicRedactionArchive } from '../encryptedArchive.ts';
import { setRedactionArchive, setRedactionArchivePurger } from '../redactionArchive.ts';
import { describeStores } from '../testing/index.ts';

const token = `ghp_${'A'.repeat(36)}`;
const vector = Array.from({ length: 768 }, (_, i) => Number(i === 0));
const input = (projectKey: string, ref: string) => ({ projectKey, source: 'upload' as const, ref, title: 'Notes', url: null });

describeStores('encrypted archive deletion lifecycle', h => {
  let root: string | undefined;
  afterEach(async () => { setRedactionArchive(undefined); setRedactionArchivePurger(undefined); if (root) await rm(root, { recursive: true, force: true }); });
  async function open() {
    root = await mkdtemp(join(tmpdir(), 'fg-archive-contract-'));
    const path = join(root, 'archive');
    await encryptedRedactionArchive(path, { keyDirectory: join(root, 'keys') });
    const api = await publicRedactionArchive(path);
    setRedactionArchive(api.save); setRedactionArchivePurger(api.remove);
    const count = async () => (await readdir(path)).filter(name => name.endsWith('.enc')).length;
    return { count };
  }
  test('document refusal preserves originals; actual doc and project deletes purge only matching originals', async () => {
    const { count } = await open();
    const own = await h.store.docs.upsertDoc(input('shop', 'own'), [{ text: `Secret ${token}`, embedding: vector }]);
    await h.store.docs.upsertDoc(input('bystander', 'keep'), [{ text: `Keep ${token}`, embedding: vector }]);
    expect(await count()).toBe(2);
    expect(await h.store.docs.deleteDoc(own, { run: 'not-the-owner' })).toBe(false);
    expect(await count()).toBe(2);
    expect(await h.store.docs.deleteDoc(own)).toBe(true);
    expect(await count()).toBe(1);
    await h.store.portability.deleteProject('shop');
    expect(await count()).toBe(1);
    await h.store.portability.deleteProject('bystander');
    expect(await count()).toBe(0);
  });
  test('run cleanup removes its scoped fact originals and preserves another run and kept records', async () => {
    const { count } = await open();
    const fact = { path: 'src/a.ts', kind: 'convention' as const, statement: `Secret ${token}`, lines: null, confidence: 1, why: 'test', embedding: vector };
    for (const id of ['run-a', 'run-b']) await h.store.facts.saveFileFacts('shop', { path: 'src/a.ts', hash: id, summary: 'Fixture' }, [fact], 'fixture', null, { id, sandbox: true });
    expect(await count()).toBe(2);
    const items = await h.store.runs.items('run-a');
    await h.store.runs.remove('run-a', items.map(item => item.id));
    expect(await count()).toBe(2);
    await h.store.runs.remove('run-a', []);
    expect(await count()).toBe(1);
    expect((await h.store.runs.items('run-b')).filter(item => item.kind === 'fact')).toHaveLength(1);
  });
});
