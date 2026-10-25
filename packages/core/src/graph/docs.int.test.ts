import { beforeAll, expect, test } from 'vitest';
import type { DocsStore } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import { MAX_SCAN_ATTEMPTS, SCAN_UNAVAILABLE_WAIT_MS } from './facts.ts';
import type { CodeFact } from '../types.ts';

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
    expect(listed).toMatchObject({ id, title: 'title spec.md', source: 'upload', chunks: 1, addedBy: null });
  });

  test('an upload records who added it', async () => {
    await d.upsertDoc(doc('notes.md'), [{ text: 'tenants must be isolated', embedding: vec(1) }], { read: true, addedBy: 'operator:codex' });
    expect((await d.listDocs('shop'))[0]).toMatchObject({ ref: 'notes.md', addedBy: 'operator:codex' });
    await d.upsertDoc(doc('notes.md'), [{ text: 'tenants must be isolated', embedding: vec(1) }], { read: true, addedBy: 'you' });
    expect((await d.listDocs('shop'))[0].addedBy).toBe('you');
  });

  test('searchDocs returns nearest chunks of the project with their doc', async () => {
    await d.upsertDoc(doc('spec.md'), [{ text: 'tenants must be isolated', embedding: vec(1) }, { text: 'pagination', embedding: vec(2) }]);
    await d.upsertDoc(doc('PR 12', 'shop', 'github'), [{ text: 'reviewer: scope by org', embedding: vec(1) }]);
    await d.upsertDoc(doc('other.md', 'blog'), [{ text: 'blog chunk', embedding: vec(1) }]);
    const hits = await d.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 2 });
    expect(hits.map((h) => h.text).sort()).toEqual(['reviewer: scope by org', 'tenants must be isolated']);
    expect(hits.find((h) => h.source === 'github')).toMatchObject({ ref: 'PR 12', title: 'title PR 12' });
  });

  test('a pull request links the Linear tickets it names, both ways, within its project; a lookalike or a missing ticket links nothing', async () => {
    const pr = await d.upsertDoc({ ...doc('github:acme/shop#12', 'shop', 'github'), title: 'acme/shop#12: Keep cents', url: 'https://github.com/acme/shop/pull/12' }, [{ text: 'pr', embedding: vec(1) }], { tickets: ['ENG-7', 'UTF-8', 'ENG-99'] });
    const other = await d.upsertDoc({ ...doc('github:acme/shop#13', 'shop', 'github'), title: 'acme/shop#13: Totals' }, [{ text: 'pr', embedding: vec(1) }], { tickets: ['ENG-7'] });
    const ticket = await d.upsertDoc({ ...doc('linear:ENG-7', 'shop', 'linear'), title: 'ENG-7: Keep cents', url: 'https://linear.app/acme/issue/ENG-7' }, [{ text: 'ticket', embedding: vec(2) }]);
    // The same identifier in another project is another team's ticket.
    await d.upsertDoc({ ...doc('linear:ENG-99', 'blog', 'linear') }, [{ text: 'elsewhere', embedding: vec(2) }]);

    expect(await d.linkedDocs({ projectKey: 'shop', docIds: [pr] })).toEqual([
      { docId: pr, linked: { docId: ticket, source: 'linear', ref: 'linear:ENG-7', title: 'ENG-7: Keep cents', url: 'https://linear.app/acme/issue/ENG-7' } },
    ]);
    const back = await d.linkedDocs({ projectKey: 'shop', docIds: [ticket] });
    expect(back.map((l) => [l.docId, l.linked.docId])).toEqual([[ticket, pr], [ticket, other]]);
    expect(await d.linkedDocs({ projectKey: 'blog', docIds: [pr] })).toEqual([]);
    expect(await d.linkedDocs({ projectKey: 'shop', docIds: [] })).toEqual([]);
    // Synced again without naming it: the link goes.
    await d.upsertDoc({ ...doc('github:acme/shop#13', 'shop', 'github'), title: 'acme/shop#13: Totals' }, [{ text: 'pr', embedding: vec(1) }]);
    expect((await d.linkedDocs({ projectKey: 'shop', docIds: [ticket] })).map((l) => l.linked.docId)).toEqual([pr]);
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

describeStores('DocsStore: reading uploads into facts', (h) => {
  let d: DocsStore;
  beforeAll(() => {
    d = h.store.docs;
  });
  const png = { mediaType: 'image/png' as const, data: Buffer.from('png-bytes').toString('base64') };
  const fact = (statement: string, relevance = 0.8): CodeFact & { embedding: number[] } => ({ kind: 'architecture', statement, path: 'flow.png', lines: null, confidence: 0.9, why: 'w', relevance, embedding: vec(4) });

  test('an upload to read is pending with its text; synced docs are never read', async () => {
    await d.upsertDoc(doc('PR 1', 'shop', 'github'), [{ text: 'review', embedding: vec(1) }]);
    const id = await d.upsertDoc(doc('spec.md'), [{ text: 'part one', embedding: vec(1) }, { text: 'part two', embedding: vec(2) }], { read: true });
    const listed = await d.listDocs('shop');
    expect(listed.find((x) => x.id === id)).toMatchObject({ kind: 'text', read: { status: 'pending', attempts: 0, facts: 0, error: null } });
    expect(listed.find((x) => x.source === 'github')).toMatchObject({ kind: 'text', read: null });
    const next = await d.nextDocToRead();
    expect(next).toMatchObject({ id, projectKey: 'shop', ref: 'spec.md', kind: 'text', text: 'part one\n\npart two', image: null, attempts: 0 });
  });

  test('an image upload keeps its bytes for the reader and the thumbnail; deleting the doc removes them', async () => {
    const id = await d.upsertDoc(doc('flow.png'), [{ text: 'image, not read yet', embedding: vec(1) }], { read: true, image: png });
    expect((await d.listDocs('shop'))[0]).toMatchObject({ kind: 'image', mediaType: 'image/png' });
    expect(await d.nextDocToRead()).toMatchObject({ id, kind: 'image', image: png, text: '' });
    expect(await d.docImage(id)).toEqual(png);
    await d.deleteDoc(id);
    expect(await d.docImage(id)).toBeNull();
  });

  test('saveDocReading replaces the excerpts (an image description), stores facts from the doc, and marks it read', async () => {
    const id = await d.upsertDoc(doc('flow.png'), [{ text: 'image, not read yet', embedding: vec(1) }], { read: true, image: png });
    await d.markDocReading(id);
    expect(await d.nextDocToRead()).toBeNull();
    await d.saveDocReading(id, { chunks: [{ text: 'A checkout flow: cart, then address, then payment.', embedding: vec(5) }], facts: [fact('Checkout asks for the address before payment')], source: 'ollama:gemma4' });
    const [listed] = await d.listDocs('shop');
    expect(listed).toMatchObject({ chunks: 1, read: { status: 'done', facts: 1, error: null } });
    expect(listed.read?.readAt).toBeTruthy();
    const [hit] = await d.searchDocs({ embedding: vec(5), projectKey: 'shop', k: 1 });
    expect(hit.text).toContain('checkout flow');
    const facts = await h.store.facts.listFacts({ projectKey: 'shop' });
    expect(facts).toEqual([expect.objectContaining({ statement: 'Checkout asks for the address before payment', docId: id, path: 'flow.png', source: 'ollama:gemma4', relevance: 0.8, relevanceBy: 'model' })]);
    const [found] = await h.store.facts.searchFacts({ embedding: vec(4), projectKey: 'shop', k: 3 });
    expect(found.fact.docId).toBe(id);
  });

  test('doc facts survive code scans, and leave with their doc; uploading the doc again starts its reading over', async () => {
    const id = await d.upsertDoc(doc('spec.md'), [{ text: 'x', embedding: vec(1) }], { read: true });
    await d.saveDocReading(id, { facts: [fact('From the spec')], source: 'p' });
    await h.store.facts.replaceProjectFacts('shop', [{ ...fact('From the code'), path: 'src/a.ts' }], 'claude-cli', [{ path: 'src/a.ts', hash: 'h' }]);
    expect((await h.store.facts.listFacts({ projectKey: 'shop' })).map((f) => f.statement).sort()).toEqual(['From the code', 'From the spec']);
    expect(await h.store.facts.currentSources('shop')).toEqual(['claude-cli']);
    await d.upsertDoc(doc('spec.md'), [{ text: 'new text', embedding: vec(1) }], { read: true });
    expect((await h.store.facts.listFacts({ projectKey: 'shop' })).map((f) => f.statement)).toEqual(['From the code']);
    expect((await d.listDocs('shop'))[0].read).toMatchObject({ status: 'pending', facts: 0 });
    await d.saveDocReading(id, { facts: [fact('Again')], source: 'p' });
    await d.deleteDoc(id);
    expect((await h.store.facts.listFacts({ projectKey: 'shop' })).map((f) => f.statement)).toEqual(['From the code']);
  });

  test('a document uploaded again while it is being read keeps the new version: the old reading is dropped, and so is its failure', async () => {
    const id = await d.upsertDoc(doc('flow.png'), [{ text: 'image, not read yet', embedding: vec(1) }], { read: true, image: png });
    const old = (await d.nextDocToRead())!;
    expect(await d.markDocReading(id, old.version)).toBe(true);
    // The right screenshot, uploaded under the same name while the wrong one is being read.
    await new Promise((r) => setTimeout(r, 5));
    await d.upsertDoc(doc('flow.png'), [{ text: 'image, not read yet', embedding: vec(1) }], { read: true, image: { ...png, data: Buffer.from('right-bytes').toString('base64') } });
    expect(await d.saveDocReading(id, { version: old.version, chunks: [{ text: 'the wrong screenshot', embedding: vec(5) }], facts: [fact('About the wrong image')], source: 'p' })).toBe(false);
    expect(await d.recordDocFailure(id, 'boom', { counted: true, version: old.version })).toBeNull();
    const [listed] = await d.listDocs('shop');
    expect(listed.read).toMatchObject({ status: 'pending', attempts: 0, facts: 0, error: null });
    expect((await d.searchDocs({ embedding: vec(5), projectKey: 'shop', k: 1 }))[0].text).toBe('image, not read yet');
    const fresh = (await d.nextDocToRead())!;
    expect(fresh.version).not.toBe(old.version);
    expect(fresh.image?.data).toBe(Buffer.from('right-bytes').toString('base64'));
    expect(await d.markDocReading(id, old.version)).toBe(false);
    expect(await d.saveDocReading(id, { version: fresh.version, facts: [fact('About the right image')], source: 'p' })).toBe(true);
  });

  test('a failed reading backs off and gives up after MAX_SCAN_ATTEMPTS; an unreachable model waits without counting; stale readings are queued again', async () => {
    const id = await d.upsertDoc(doc('spec.md'), [{ text: 'x', embedding: vec(1) }], { read: true });
    const t0 = new Date('2026-10-24T10:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(await d.recordDocFailure(id, 'model unavailable', { counted: false }, t0)).toEqual({ attempts: 0, retryAt: new Date(t0.getTime() + SCAN_UNAVAILABLE_WAIT_MS).toISOString() });
    expect(await d.nextDocToRead(at(1))).toBeNull();
    expect(await d.recordDocFailure(id, `boom ghp_${'F'.repeat(36)}`, { counted: true }, t0)).toEqual({ attempts: 1, retryAt: at(5).toISOString() });
    expect((await d.listDocs('shop'))[0].read).toMatchObject({ status: 'pending', attempts: 1, error: expect.stringContaining('[REDACTED]') });
    expect((await d.nextDocToRead(at(5)))?.id).toBe(id);
    for (let i = 1; i < MAX_SCAN_ATTEMPTS; i++) await d.recordDocFailure(id, 'boom', { counted: true }, t0);
    expect((await d.listDocs('shop'))[0].read).toMatchObject({ status: 'failed', attempts: MAX_SCAN_ATTEMPTS });
    expect(await d.nextDocToRead(at(600))).toBeNull();
    // Giving up at once, when retrying cannot help.
    const blindOne = await d.upsertDoc(doc('c.png'), [{ text: 'z', embedding: vec(1) }], { read: true, image: png });
    expect(await d.recordDocFailure(blindOne, 'jev cannot read images', { counted: true, final: true }, t0)).toEqual({ attempts: 1, retryAt: null });
    expect((await d.listDocs('shop')).find((x) => x.id === blindOne)?.read).toMatchObject({ status: 'failed', error: 'jev cannot read images' });

    const other = await d.upsertDoc(doc('b.md'), [{ text: 'y', embedding: vec(1) }], { read: true });
    await d.markDocReading(other);
    await d.requeueStaleDocs();
    expect((await d.nextDocToRead())?.id).toBe(other);
  });

  test('requeueDocRead: a failed reading goes back to pending, attempts and error cleared; a done or missing one is left alone', async () => {
    const t0 = new Date('2026-10-24T10:00:00Z');
    const failed = await d.upsertDoc(doc('blind.png'), [{ text: 'z', embedding: vec(1) }], { read: true, image: png });
    await d.recordDocFailure(failed, 'cannot read images', { counted: true, final: true }, t0);
    expect(await d.requeueDocRead(failed)).toBe(true);
    expect((await d.listDocs('shop')).find((x) => x.id === failed)?.read).toMatchObject({ status: 'pending', attempts: 0, error: null, retryAt: null });

    const done = await d.upsertDoc(doc('done.md'), [{ text: 'y', embedding: vec(1) }], { read: true });
    await d.saveDocReading(done, { facts: [], source: 'p' });
    expect(await d.requeueDocRead(done)).toBe(false);
    expect((await d.listDocs('shop')).find((x) => x.id === done)?.read).toMatchObject({ status: 'done' });
    expect(await d.requeueDocRead('doc:shop:upload:missing.md')).toBe(false);
  });
});
