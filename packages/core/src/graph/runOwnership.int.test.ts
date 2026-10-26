import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import { NotTheRunsError, type RunTag } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const tester: RunTag = { id: 'run-1', sandbox: false };
const sandbox: RunTag = { id: 'sbx-1', sandbox: true };
const notes = { projectKey: 'shop', source: 'upload' as const, ref: 'notes.md', title: 'Notes', url: null };
const text = (s: Store, run?: string | null) => s.docs.searchDocs({ embedding: vec(1), projectKey: 'shop', k: 10, run }).then((r) => r.map((x) => x.text).sort());

/** A run writes only what it owns: it never replaces, decides on or removes the owner's record, nor another run's. */
describeStores('a run never takes over a record it does not own', (h) => {
  let s: Store;
  beforeAll(() => {
    s = h.store;
  });

  test("a sandbox upload with the owner's file name is its own document: the owner's text, facts and visibility stay, and cleanup removes only the copy", async () => {
    const owner = await s.docs.upsertDoc(notes, [{ text: 'owner notes', embedding: vec(1) }], { read: true });
    const next = (await s.docs.nextDocToRead())!;
    await s.docs.saveDocReading(next.id, { version: next.version, facts: [{ kind: 'convention', statement: 'from the owner notes', path: 'notes.md', lines: null, confidence: 1, why: 'w', embedding: vec(2) }], source: 'm' });

    const copy = await s.docs.upsertDoc(notes, [{ text: 'sandbox notes', embedding: vec(1) }], { read: true, run: sandbox });
    expect(copy).not.toBe(owner);
    expect(await text(s)).toEqual(['owner notes']);
    expect(await text(s, 'sbx-1')).toEqual(['owner notes', 'sandbox notes']);
    expect((await s.docs.listDocs('shop')).map((d) => [d.id, d.read?.facts])).toEqual([[owner, 1]]);
    expect((await s.docs.listDocs('shop', { run: 'sbx-1' })).map((d) => d.id).sort()).toEqual([owner, copy].sort());
    // The run uploads it again: its own copy is replaced, the owner's still stands.
    await s.docs.upsertDoc(notes, [{ text: 'sandbox notes v2', embedding: vec(1) }], { run: sandbox });
    expect(await text(s, 'sbx-1')).toEqual(['owner notes', 'sandbox notes v2']);

    expect((await s.runs.items('sbx-1')).map((i) => i.id)).toEqual([copy]);
    await s.runs.remove('sbx-1', []);
    expect((await s.docs.listDocs('shop')).map((d) => [d.id, d.read?.facts])).toEqual([[owner, 1]]);
    expect(await text(s)).toEqual(['owner notes']);
  });

  test("a run's upload over the owner's document (or another run's) is refused, unless the owner opened the run; the owner's re-upload of a run's document makes it the owner's", async () => {
    await s.docs.upsertDoc(notes, [{ text: 'owner notes', embedding: vec(1) }]);
    await expect(s.docs.upsertDoc(notes, [{ text: 'run notes', embedding: vec(1) }], { run: tester })).rejects.toBeInstanceOf(NotTheRunsError);
    expect(await text(s)).toEqual(['owner notes']);
    expect(await s.runs.items('run-1')).toEqual([]);

    // The owner, in a run of their own: the document is replaced and stays theirs (cleanup of the run never removes it).
    await s.docs.upsertDoc(notes, [{ text: 'owner notes v2', embedding: vec(1) }], { run: tester, byOwner: true });
    expect(await text(s)).toEqual(['owner notes v2']);
    expect(await s.runs.items('run-1')).toEqual([]);

    // A run's own document: the run replaces it; another run may not.
    const spec = { ...notes, ref: 'spec.md' };
    const id = await s.docs.upsertDoc(spec, [{ text: 'run spec', embedding: vec(3) }], { run: tester });
    await s.docs.upsertDoc(spec, [{ text: 'run spec v2', embedding: vec(3) }], { run: tester });
    await expect(s.docs.upsertDoc(spec, [{ text: 'other', embedding: vec(3) }], { run: { id: 'run-2', sandbox: false } })).rejects.toBeInstanceOf(NotTheRunsError);
    expect((await s.runs.items('run-1')).map((i) => i.id)).toEqual([id]);
    // The owner uploads it again: it is the owner's now, so cleanup leaves it.
    await s.docs.upsertDoc(spec, [{ text: 'owner spec', embedding: vec(3) }]);
    expect(await s.runs.items('run-1')).toEqual([]);
  });

  test("a run removes only a document it uploaded; the owner removes any", async () => {
    const owner = await s.docs.upsertDoc(notes, [{ text: 'owner notes', embedding: vec(1) }]);
    const copy = await s.docs.upsertDoc(notes, [{ text: 'sandbox notes', embedding: vec(1) }], { run: sandbox });
    expect(await s.docs.deleteDoc(owner, { run: 'sbx-1' })).toBe(false);
    expect(await s.docs.deleteDoc(copy, { run: 'run-2' })).toBe(false);
    expect(await text(s, 'sbx-1')).toEqual(['owner notes', 'sandbox notes']);
    expect(await s.docs.deleteDoc(copy, { run: 'sbx-1' })).toBe(true);
    expect(await s.docs.deleteDoc(owner)).toBe(true);
  });

  test("a sandbox run's link decision is its own row: the owner's confirmed link is unchanged and served to everyone else, the run sees its decision instead", async () => {
    const real = await s.links.setLink('shop', 'web', { status: 'confirmed', note: 'shared api', decidedBy: 'you' });
    const mine = await s.links.setLink('shop', 'web', { status: 'dismissed', decidedBy: 'operator:tester', run: sandbox });
    expect(mine.id).not.toBe(real.id);
    // Made from the owner's link: only what the run changed differs.
    expect(mine).toMatchObject({ a: 'shop', b: 'web', status: 'dismissed', note: 'shared api', run: 'sbx-1', sandbox: true });
    expect(await s.links.listLinks({ projectKey: 'shop' })).toEqual([real]);
    expect(await s.links.listLinks({ projectKey: 'shop', run: 'other' })).toEqual([real]);
    expect((await s.links.listLinks({ projectKey: 'shop', run: 'sbx-1' })).map((l) => [l.id, l.status])).toEqual([[mine.id, 'dismissed']]);
    // Deciding again changes its own row only.
    expect((await s.links.setLink('web', 'shop', { status: 'confirmed', run: sandbox })).id).toBe(mine.id);
    expect((await s.links.listLinks({ projectKey: 'shop' }))[0]).toMatchObject({ status: 'confirmed', decidedBy: 'you' });

    // A run never removes a row it did not make.
    await expect(s.links.deleteLink(real.id, { run: 'sbx-1' })).resolves.toBe(false);
    expect(await s.links.listLinks({ projectKey: 'shop' })).toHaveLength(1);
    expect(await s.links.deleteLink(mine.id, { run: 'sbx-1' })).toBe(true);
    expect((await s.links.listLinks({ projectKey: 'shop', run: 'sbx-1' })).map((l) => l.id)).toEqual([real.id]);

    // Cleanup removes the run's row, never the owner's.
    await s.links.setLink('shop', 'web', { status: 'dismissed', run: sandbox });
    expect(await s.runs.remove('sbx-1', [])).toMatchObject({ link: 1 });
    expect(await s.links.listLinks({ projectKey: 'shop' })).toEqual([real]);
  });

  test("a run's decision on the owner's link (or another run's) is refused unless the owner opened the run; the owner's decision on a run's link makes it the owner's", async () => {
    await s.links.setLink('shop', 'blog', { status: 'confirmed' });
    await expect(s.links.setLink('shop', 'blog', { status: 'dismissed', run: tester })).rejects.toBeInstanceOf(NotTheRunsError);
    expect((await s.links.listLinks({ projectKey: 'shop' }))[0]).toMatchObject({ status: 'confirmed' });
    const byOwner = await s.links.setLink('shop', 'blog', { status: 'dismissed', run: tester, byOwner: true });
    expect(byOwner.status).toBe('dismissed');
    expect(byOwner.run).toBeUndefined();

    const made = await s.links.setLink('shop', 'web', { status: 'confirmed', run: tester });
    expect(made.run).toBe('run-1');
    await expect(s.links.setLink('shop', 'web', { status: 'dismissed', run: { id: 'run-2', sandbox: false } })).rejects.toBeInstanceOf(NotTheRunsError);
    expect(await s.links.deleteLink(made.id, { run: 'run-2' })).toBe(false);
    expect((await s.links.setLink('shop', 'web', { note: 'edited in the run', run: tester })).run).toBe('run-1');
    // The owner confirms it: the decision is the owner's, so cleanup leaves the link.
    const adopted = await s.links.setLink('shop', 'web', { status: 'confirmed', decidedBy: 'you' });
    expect(adopted.run).toBeUndefined();
    expect(adopted.sandbox).toBeUndefined();
    expect(await s.runs.items('run-1')).toEqual([]);
  });

  test("the owner's decision on a pair a sandbox run decided first is the owner's own link, visible to everyone; cleanup leaves it", async () => {
    const mine = await s.links.setLink('shop', 'web', { status: 'confirmed', run: sandbox });
    const real = await s.links.setLink('shop', 'web', { status: 'confirmed', decidedBy: 'you' });
    expect(real.id).not.toBe(mine.id);
    expect(real.run).toBeUndefined();
    expect(await s.links.listLinks({ projectKey: 'shop' })).toEqual([real]);
    expect((await s.links.listLinks({ projectKey: 'shop', run: 'sbx-1' })).map((l) => l.id)).toEqual([mine.id]);
    await s.runs.remove('sbx-1', []);
    expect(await s.links.listLinks({ projectKey: 'shop' })).toEqual([real]);
  });

  test("relevance: a run sets it only on a fact it wrote; the owner's setting makes a run's fact the owner's; the scorer's never does", async () => {
    const fact = (statement: string, run?: RunTag) =>
      s.facts.addOwnerFact('shop', { kind: 'convention', statement, path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(4) }, 'operator:tester', run);
    const owner = await fact('owner fact');
    const runs = await fact('run fact', tester);
    expect(await s.facts.setFactRelevance([{ id: owner.id, relevance: 0.1, by: 'operator:tester', projectKey: 'shop', run: 'run-1' }])).toBe(0);
    expect(await s.facts.setFactRelevance([{ id: runs.id, relevance: 0.2, by: 'operator:tester', projectKey: 'shop', run: 'run-1' }])).toBe(1);
    expect(await s.facts.setFactRelevance([{ id: runs.id, relevance: 0.3, by: 'model', projectKey: 'shop' }])).toBe(0);
    expect((await s.runs.items('run-1')).map((i) => i.id)).toEqual([runs.id]);
    expect(await s.facts.setFactRelevance([{ id: runs.id, relevance: 0.9, by: 'you', projectKey: 'shop', run: null }])).toBe(1);
    expect(await s.runs.items('run-1')).toEqual([]);
    const listed = await s.facts.listFacts({ projectKey: 'shop' });
    expect(listed.find((f) => f.id === owner.id)?.relevance).not.toBe(0.1);
    expect(listed.find((f) => f.id === runs.id)?.relevance).toBe(0.9);
  });

  test("a report and a conversation say which run made them, so a run's decision on someone else's can be refused", async () => {
    const id = await s.knowledge.createManualFeedback({ project: { key: 'shop', name: 'shop', repoPath: '/vibe/shop' }, cwd: '/vibe/shop', text: 't', whatWasDone: 'w', run: sandbox });
    expect((await s.graph.candidateDetail(id))?.candidate).toMatchObject({ run: 'sbx-1', sandbox: true });
    const mine = await s.knowledge.createManualFeedback({ project: { key: 'shop', name: 'shop', repoPath: '/vibe/shop' }, cwd: '/vibe/shop', text: 'u', whatWasDone: 'w' });
    expect((await s.graph.candidateDetail(mine))?.candidate.run).toBeUndefined();
    const chat = await s.chats.createConversation({ projectKey: 'shop', title: 'q', provider: null, run: 'run-1' });
    expect(chat.run).toBe('run-1');
    expect((await s.chats.conversation(chat.id))?.run).toBe('run-1');
    expect((await s.chats.createConversation({ projectKey: 'shop', title: 'q', provider: null })).run).toBeUndefined();
  });
});
