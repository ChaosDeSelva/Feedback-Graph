import { beforeAll, expect, test } from 'vitest';
import type { DocsStore } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));

const doc = (ref: string, projectKey = 'shop', source: 'upload' | 'github' | 'linear' = 'upload') => ({
  projectKey, source, ref, title: `title ${ref}`, url: null,
});

describeStores('DocsStore', (h) => {
  let d: DocsStore;
  let probe: StoreProbe;
  beforeAll(() => {
    d = h.store.docs;
    probe = h.probe;
  });

  test('upsertDoc stores chunks; re-upserting the same ref replaces them', async () => {
    const id = await d.upsertDoc(doc('spec.md'), [{ text: 'tenants must be isolated', embedding: vec(1) }, { text: 'lists are paginated', embedding: vec(2) }]);
    expect(id).toBe('doc:shop:upload:spec.md');
    await d.upsertDoc(doc('spec.md'), [{ text: 'only one chunk now', embedding: vec(3) }]);
    const [listed] = await d.listDocs('shop');
    expect(listed).toMatchObject({ id, title: 'title spec.md', source: 'upload', chunks: 1 });
  });

  test('searchDocs returns nearest chunks of the project with their doc', async () => {
    await d.upsertDoc(doc('spec.md'), [{ text: 'tenants must be isolated', embedding: vec(1) }, { text: 'pagination', embedding: vec(2) }]);
    await d.upsertDoc(doc('PR 12', 'shop', 'github'), [{ text: 'reviewer: scope by org', embedding: vec(1) }]);
    await d.upsertDoc(doc('other.md', 'blog'), [{ text: 'blog chunk', embedding: vec(1) }]);
    const hits = await d.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 2 });
    expect(hits.map((h) => h.text).sort()).toEqual(['reviewer: scope by org', 'tenants must be isolated']);
    expect(hits.find((h) => h.source === 'github')).toMatchObject({ ref: 'PR 12', title: 'title PR 12' });
  });

  test('deleteDoc removes the doc and its chunks', async () => {
    const id = await d.upsertDoc(doc('spec.md'), [{ text: 'x', embedding: vec(1) }]);
    expect(await d.deleteDoc(id)).toBe(true);
    expect(await d.listDocs('shop')).toEqual([]);
    expect(await probe.count('Chunk')).toBe(0);
    expect(await d.deleteDoc(id)).toBe(false);
  });

  test('sync cursors persist per key', async () => {
    expect(await d.getCursor('github:shop')).toBeNull();
    await d.setCursor('github:shop', '2026-10-22T00:00:00Z');
    expect(await d.getCursor('github:shop')).toBe('2026-10-22T00:00:00Z');
  });

  test('upsertDoc redacts secrets in the title and every chunk, whoever the caller is', async () => {
    await d.upsertDoc({ ...doc('PR 9', 'shop', 'github'), title: 'leaks ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, [{ text: 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA here', embedding: vec(1) }]);
    const [listed] = await d.listDocs('shop');
    expect(listed.title).not.toContain('ghp_');
    const [hit] = await d.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 1 });
    expect(hit.text).not.toContain('ghp_');
    expect(hit.title).not.toContain('ghp_');
  });

  test('project doc chunks are found even when many closer chunks belong to other projects', async () => {
    await d.upsertDoc(doc('noise.md', 'blog'), Array.from({ length: 150 }, () => ({ text: 'noise', embedding: vec(1) })));
    await d.upsertDoc(doc('mine.md'), [{ text: 'mine', embedding: vec(2) }]);
    expect((await d.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 5 })).map((h) => h.text)).toEqual(['mine']);
  });

  test('scores are cosine similarity scaled to 0..1: same direction 1, orthogonal 0.5', async () => {
    await d.upsertDoc(doc('a.md'), [{ text: 'same', embedding: vec(1) }, { text: 'orthogonal', embedding: vec(2) }]);
    const hits = await d.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 2 });
    expect(hits.map((x) => [x.text, x.score])).toEqual([['same', 1], ['orthogonal', 0.5]]);
  });
});
