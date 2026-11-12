import { beforeAll, expect, test } from 'vitest';
import { syncBundle } from '../cloud.ts';
import { chunkSourceText } from '../intake/chunk.ts';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import { AGENT_HIDDEN_DOC_SOURCES } from './docs.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const TRANSCRIPT = 'Ana: the retry timeout is 30 seconds\n\nBo: agreed, starting Monday\n\n\nAna: and no more MySQL';

/** An intake source and an ordinary upload in one project, closest to the same query. */
describeStores('intake sources as documents', (h) => {
  let s: Store;
  beforeAll(() => {
    s = h.store;
  });
  const both = async () => {
    const source = await s.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref: 'sync.vtt', title: 'Weekly sync', url: null },
      chunkSourceText(TRANSCRIPT, 40).map((text) => ({ text, embedding: vec(1) })), { read: true });
    const upload = await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'spec.md', title: 'Spec', url: null }, [{ text: 'retries back off', embedding: vec(1) }]);
    return { source, upload };
  };

  test('searchDocs leaves out the excluded sources before taking the k nearest', async () => {
    await both();
    expect((await s.docs.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 10 })).map((x) => x.source).sort()).toEqual(['intake', 'intake', 'intake', 'upload']);
    // k = 1 still finds the upload: the excluded chunks never take the place.
    expect((await s.docs.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 1, excludeSources: AGENT_HIDDEN_DOC_SOURCES })).map((x) => x.text)).toEqual(['retries back off']);
    expect(await s.docs.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 5, excludeSources: ['intake', 'upload'] })).toEqual([]);
  });

  test('a source\'s text reads back as the reader gets it: its chunks rejoined exactly', async () => {
    const { source } = await both();
    expect(await s.docs.docText(source)).toBe(TRANSCRIPT);
    expect(await s.docs.docText('doc:shop:intake:gone.vtt')).toBeNull();
  });

  test('intake sources are never exported, so never synced', async () => {
    await both();
    const x = await s.portability.exportData({ projectKey: 'shop' });
    expect(x.docs.map((d) => d.title)).toEqual(['Spec']);
    expect(JSON.stringify(x)).not.toContain('Weekly sync');
    const sent = await syncBundle(s.portability, 'shop');
    expect(sent!.docs.map((d) => d.title)).toEqual(['Spec']);
  });
});
