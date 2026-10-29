import { beforeAll, expect, test } from 'vitest';
import { guardStore, withStoreWriteAuthorizer } from '../storeWrites.ts';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';

/** A conditional domain write and its run claim must commit together, or neither commits. */
describeStores('conditional run ownership writes', h => {
  let store: Store;
  beforeAll(() => { store = guardStore(h.store); });

  test('missing targets across all seven conditional mutations never claim a run', async () => {
    const attempts: [string, () => Promise<unknown>, unknown][] = [
      ['chat-retry', () => store.chats.retryTurn('missing-chat', 'missing-turn'), null],
      ['doc-reread', () => store.docs.requeueDocRead('doc:missing:upload:x'), false],
      ['doc-delete', () => store.docs.deleteDoc('doc:missing:upload:x'), false],
      ['map-rebuild', () => store.codegraph.requestCodeMapRebuild!('missing-project'), false],
      ['feedback-retry', () => store.knowledge.retryPostmortem!('missing-feedback'), false],
      ['fact-relevance', () => store.facts.setFactRelevance([{ id: 'missing-fact', projectKey: 'missing-project', relevance: .1, by: 'you', run: null }]), 0],
      ['link-delete', () => store.links.deleteLink('link:missing|other'), false],
    ];
    for (const [id, write, expected] of attempts) {
      let claims = 0;
      const result = await withStoreWriteAuthorizer(async () => { claims++; await store.runs.claim(id, 'operator', 'private-test-capability'); }, write);
      expect(result).toEqual(expected);
      expect(claims).toBe(1);
      expect(await store.runs.owner(id)).toBeNull();
    }
  });

  test('a document removed after preflight produces no ownership reservation', async () => {
    const id = await store.docs.upsertDoc({ projectKey: 'race-doc', source: 'upload', ref: 'fixture.md', title: 'fixture', url: null }, []);
    expect((await store.docs.listDocs('race-doc')).some(doc => doc.id === id)).toBe(true);
    // Controlled interleaving: the route's read succeeded, then another caller removed the target.
    expect(await store.docs.deleteDoc(id)).toBe(true);
    let claims = 0;
    expect(await withStoreWriteAuthorizer(async () => { claims++; await store.runs.claim('race-noop', 'operator', 'private-test-capability'); }, () => store.docs.deleteDoc(id))).toBe(false);
    expect(claims).toBe(1);
    expect(await store.runs.owner('race-noop')).toBeNull();
  });

  test('a refused caller leaves its target unchanged; successful authorization commits ownership and mutation together', async () => {
    const id = await store.docs.upsertDoc({ projectKey: 'atomic-doc', source: 'upload', ref: 'fixture.md', title: 'fixture', url: null }, []);
    await expect(withStoreWriteAuthorizer(async () => { throw new Error('caller conflict'); }, () => store.docs.deleteDoc(id))).rejects.toThrow('caller conflict');
    expect((await store.docs.listDocs('atomic-doc')).some(doc => doc.id === id)).toBe(true);
    await expect(withStoreWriteAuthorizer(async () => { await store.runs.claim('atomic-success', 'operator', 'private-test-capability'); }, () => store.docs.deleteDoc(id))).resolves.toBe(true);
    expect((await store.docs.listDocs('atomic-doc')).some(doc => doc.id === id)).toBe(false);
    expect(await store.runs.owner('atomic-success')).toMatchObject({ principal: 'operator', actor: 'private-test-capability' });
  });
});
