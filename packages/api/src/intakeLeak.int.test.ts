import type { ProjectLink, Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { getTaskContext, searchGraph, type ContextDeps } from './context.ts';

/**
 * The leak the design names (§1, §7): an intake source is stored as a Doc, and every doc search that feeds an agent
 * (get_task_context, its brief, search_graph and linked projects) would otherwise serve its excerpts. A source added
 * through POST /api/intake must reach none of them, on either store, while ordinary documents still do.
 */
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
/** A little farther from the query than vec(1): every intake chunk is closer than these documents. */
const near = Array.from({ length: 768 }, (_, i) => (i === 1 ? 0.9 : i === 2 ? 0.1 : 0));
const OWNER = 'owner-test-token-01234567890123456789';
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const link: ProjectLink = { id: 'link:lib|shop', a: 'lib', b: 'shop', relation: 'depends_on', note: '', status: 'confirmed', source: 'you', score: 0, evidence: [], createdAt: 't', updatedAt: 't', decidedBy: 'you' };

/** Many paragraphs, so a source's chunks alone could fill every doc search's k. */
const transcript = (marker: string) => Array.from({ length: 30 }, (_, i) => `Ana: ${marker} the retry timeout is ${30 + i} seconds. ${'We discussed the retry timeout at length. '.repeat(30)}`).join('\n\n');

describeStores('intake text never reaches an agent', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  const add = async (projectKey: string, marker: string) => {
    const app = createApp(repo, {
      auth: { ownerToken: OWNER },
      embed: async (t) => t.map(() => vec(1)),
      projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }, { key: 'lib', name: 'lib', repoPath: '/vibe/lib' }],
      docs: store.docs,
      intake: { store: store.intake, archive: false, decide: { store, exec: { apply: async () => { throw new Error('no decision expected here'); } } } },
    });
    const res = await app.request('/api/intake', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' },
      body: JSON.stringify({ projectKey, title: `${marker} sync`, name: `${marker}.txt`, text: transcript(marker) }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; chunks: number };
  };

  const deps = (): ContextDeps => ({
    roots: [{ host: '/Users/j/Vibe', container: '/vibe' }],
    embed: async (t) => t.map(() => vec(1)),
    k: { searchLessons: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:1' } as never,
    judge: async () => [],
    activity: { record: async () => {} },
    docs: store.docs,
    links: { listLinks: async () => [link] } as never,
  });

  test('get_task_context, its brief, search_graph and linked projects serve documents, never a source', async () => {
    const shop = await add('shop', 'INTAKEMARK');
    await add('lib', 'LIBINTAKEMARK');
    expect(shop.chunks).toBeGreaterThan(10);
    await store.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'retry.md', title: 'Retry notes', url: null }, [{ text: 'UPLOADMARK the retry timeout doubles each attempt', embedding: near }]);
    await store.docs.upsertDoc({ projectKey: 'shop', source: 'github', ref: 'acme/shop#5', title: 'Retry timeout PR', url: null }, [{ text: 'PRMARK review of the retry timeout change', embedding: near }]);
    await store.docs.upsertDoc({ projectKey: 'lib', source: 'upload', ref: 'lib.md', title: 'Lib retry timeout', url: null }, [{ text: 'LIBUPLOADMARK the retry timeout lives in lib', embedding: near }]);
    // Without the guard the source's chunks are what the searches find first.
    expect((await store.docs.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 10 })).every((x) => x.source === 'intake')).toBe(true);

    const task = 'change the retry timeout';
    const full = await getTaskContext({ project: 'shop', task }, deps());
    expect(full.markdown).toContain('UPLOADMARK');
    expect(full.markdown).toContain('LIBUPLOADMARK');
    const brief = await getTaskContext({ project: 'shop', task, brief: true }, deps());
    expect(brief.markdown).toContain('acme/shop#5');
    const search = await searchGraph({ project: 'shop', query: task }, deps());
    expect(search.markdown).toContain('UPLOADMARK');
    for (const md of [full.markdown, brief.markdown, search.markdown]) {
      expect(md).not.toContain('INTAKEMARK');
      expect(md).not.toContain('We discussed');
    }
    expect([...full.docs, ...full.linked.flatMap((x) => x.docs)].every((x) => x.source !== 'intake')).toBe(true);
  });
});
