import type { JsonTask, LlmProvider, Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { readOneDoc } from '../docs/read.ts';
import { extractIntakeOne, type ExtractDeps } from './extract.ts';

const vec = Array.from({ length: 768 }, (_, i) => (i === 3 ? 1 : 0));
/** Three utterances of ~5k chars each: three windows, so a restart has somewhere to resume from. */
const said = (who: string, n: number) => `${who}: The batch cap for importer run ${n} is ${n}00 rows. ${'Filler words about the importer. '.repeat(150)}`;
const TEXT = [said('Ana', 1), said('Bo', 2), said('Ana', 3)].join('\n');

/** A model that quotes every batch-cap line a window owns, and asks no cross-window question. */
function model(): LlmProvider & { calls: number } {
  const m = {
    id: 'fake:intake', agentic: false, vision: false, calls: 0,
    json: async (t: JsonTask) => {
      m.calls++;
      if (t.system.includes('claims drawn from one source')) return { questions: [] };
      const part = t.user.slice(t.user.lastIndexOf('This part:'));
      const lines = [...part.matchAll(/(S\d): (The batch cap for importer run \d+ is \d+ rows)/g)];
      return {
        claims: lines.map((l) => ({ type: 'fact', speaker: l[1], quote: l[2], statement: `${l[2]}.`, about: 'batch cap', area: 'none', files: [], due: 'none', confidence: 0.9 })),
        questions: [],
      };
    },
  };
  return m;
}

describeStores('intake extraction on the store', (h) => {
  let s: Store;
  beforeAll(() => {
    s = h.store;
  });
  const deps = (llm: LlmProvider): ExtractDeps => ({
    docs: s.docs, intake: s.intake, llm, budgetSpent: async () => false, perDay: 200,
    embed: async (texts) => texts.map(() => vec), inScope: async () => true, knownFiles: async () => null,
  });
  const addSource = async (ref: string) => {
    const docId = await s.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref, title: ref, url: null }, [{ text: TEXT, embedding: vec }], { read: true });
    expect(await s.intake.upsertMeta({ docId, kind: 'transcript', format: 'txt', occurredAt: '2026-11-10', origin: null, private: true, participants: [] })).toBe(true);
    return docId;
  };

  test('an intake source is never read by the document reader, only by the extractor', async () => {
    const docId = await addSource('never-facts.txt');
    expect(await s.docs.nextDocToRead()).toBeNull();
    const reader = { id: 'fake:docs', agentic: false, vision: false, json: async () => { throw new Error('the document reader must not be asked'); } };
    expect(await readOneDoc({ docs: s.docs, llm: reader, embed: async (t) => t.map(() => vec), inScope: async () => true })).toBeNull();
    expect((await s.docs.nextDocToRead(undefined, { intake: true }))?.id).toBe(docId);
    // An upload stays the reader's, never the extractor's.
    const up = await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'spec.md', title: 'spec', url: null }, [{ text: 'x', embedding: vec }], { read: true });
    expect((await s.docs.nextDocToRead())?.id).toBe(up);
    expect((await s.docs.nextDocToRead(undefined, { intake: true }))?.id).toBe(docId);
    await s.docs.deleteDoc(up);
    await s.docs.deleteDoc(docId);
  });

  test('windows are saved one pass a round, resume after a restart, and the source is done after the questions pass', async () => {
    const docId = await addSource('sync.txt');
    const first = model();
    expect(await extractIntakeOne(deps(first))).toEqual({ read: true });
    expect(await s.intake.nextWindow(docId)).toMatchObject({ window: 1 });
    const total = (await s.intake.metas([docId]))[0].windowsTotal!;
    expect((await s.intake.metas([docId]))[0].windowsDone).toBe(1);
    expect(total).toBeGreaterThanOrEqual(4);
    // Still queued between passes.
    expect((await s.docs.nextDocToRead(undefined, { intake: true }))?.id).toBe(docId);

    // A restart: new deps, same store; it goes on at window 1, never reading window 0 again.
    const again = model();
    for (let i = 1; i < total; i++) expect(await extractIntakeOne(deps(again))).toEqual({ read: true });
    expect(again.calls).toBe(total - 1);
    expect(await extractIntakeOne(deps(again))).toBeNull();
    const claims = (await s.intake.listClaims({ docId })).sort((a, b) => (a.window ?? 0) - (b.window ?? 0));
    expect(claims.map((c) => [c.quote, c.status])).toEqual([
      ['The batch cap for importer run 1 is 100 rows', 'proposed'],
      ['The batch cap for importer run 2 is 200 rows', 'proposed'],
      ['The batch cap for importer run 3 is 300 rows', 'proposed'],
    ]);
    const people = await s.intake.people();
    expect(claims.map((c) => people.find((p) => p.id === c.speakerId)?.displayName)).toEqual(['Ana', 'Bo', 'Ana']);
    expect(TEXT.slice(claims[1].span!.start, claims[1].span!.end)).toBe(claims[1].quote);
    // The progress cleared the read state as it went, and done is done.
    const listed = (await s.docs.listDocs('shop', { source: 'intake' })).find((d) => d.id === docId)!;
    expect(listed.read).toMatchObject({ status: 'done', attempts: 0, error: null });
    expect(await s.docs.recordDocProgress(docId, '2001-01-01T00:00:00.000Z', { done: false })).toBe(false);
  });
});
