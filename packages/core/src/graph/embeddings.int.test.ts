import { beforeAll, expect, test } from 'vitest';
import type { EmbeddingsStore } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import { LEGACY_EMBED_MODEL } from './embeddings.ts';

describeStores('EmbeddingsStore', (h) => {
  let e: EmbeddingsStore;
  let probe: StoreProbe;
  beforeAll(() => {
    e = h.store.embeddings;
    probe = h.probe;
  });

  test('a fresh graph records the configured model', async () => {
    expect(await e.check('mxbai-embed-large')).toEqual({ ok: true, stored: 'mxbai-embed-large' });
    expect(await e.check('mxbai-embed-large')).toEqual({ ok: true, stored: 'mxbai-embed-large' });
  });

  test('a graph with vectors from before this check is taken to use the old default', async () => {
    await probe.seedEmbedded({ kind: 'Lesson', id: 'l', title: 't', rule: 'r', embedding: [1.0, 0.0] });
    expect(await e.check(LEGACY_EMBED_MODEL)).toEqual({ ok: true, stored: LEGACY_EMBED_MODEL });
    await probe.wipe();
    await probe.seedEmbedded({ kind: 'Lesson', id: 'l', title: 't', rule: 'r', embedding: [1.0, 0.0] });
    expect(await e.check('mxbai-embed-large')).toEqual({ ok: false, stored: LEGACY_EMBED_MODEL });
  });

  test('reembed rebuilds every vector from its text with the new model and records it', async () => {
    await e.check('old-model');
    await probe.seedEmbedded({ kind: 'Lesson', id: 'l', title: 'T', rule: 'R', appliesWhen: 'A', embedding: [1.0] });
    await probe.seedEmbedded({ kind: 'Miss', id: 'm', missed: 'M', causeExplanation: 'C', embedding: [1.0] });
    await probe.seedEmbedded({ kind: 'Fact', id: 'f1', path: 'a.ts', statement: 'S', current: true, embedding: [1.0] });
    await probe.seedEmbedded({ kind: 'Fact', id: 'f0', path: 'a.ts', statement: 'old', current: false, embedding: [1.0] });
    await probe.seedEmbedded({ kind: 'Chunk', id: 'c', text: 'chunk', embedding: [1.0] });
    const seen: string[] = [];
    const n = await e.reembed('new-model', async (texts) => { seen.push(...texts); return texts.map(() => [0.5, 0.5]); });
    expect(n).toBe(4);
    expect(seen.sort()).toEqual(['M\nC', 'T\nR\nApplies when: A', 'a.ts: S', 'chunk'].sort());
    expect(await probe.embeddings()).toEqual({
      c: [0.5, 0.5], f0: null, f1: [0.5, 0.5], l: [0.5, 0.5], m: [0.5, 0.5],
    });
    expect(await e.check('new-model')).toEqual({ ok: true, stored: 'new-model' });
  });

  async function seedAll() {
    await e.check('old-model');
    await probe.seedEmbedded({ kind: 'Lesson', id: 'l', title: 'T', rule: 'R', appliesWhen: 'A', embedding: [1.0] });
    await probe.seedEmbedded({ kind: 'Miss', id: 'm', missed: 'M', causeExplanation: 'C', embedding: [1.0] });
    await probe.seedEmbedded({ kind: 'Fact', id: 'f1', path: 'a.ts', statement: 'S', current: true, embedding: [1.0] });
    await probe.seedEmbedded({ kind: 'Chunk', id: 'c', text: 'chunk', embedding: [1.0] });
  }
  /** An embedder that fails on the text of the miss, as a crash or an Ollama outage part way would. */
  const failingOnMiss = (seen: string[]) => async (texts: string[]) => {
    if (texts.includes('M\nC')) throw new Error('ollama went away');
    seen.push(...texts);
    return texts.map(() => [0.5, 0.5]);
  };

  test('a re-embed that stopped part way resumes on the next run instead of starting over', async () => {
    await seedAll();
    const first: string[] = [];
    await expect(e.reembed('new-model', failingOnMiss(first))).rejects.toThrow('ollama went away');
    expect(first).toEqual(['T\nR\nApplies when: A']);
    expect(await e.check('new-model')).toEqual({ ok: false, stored: 'old-model' });

    const second: string[] = [];
    const n = await e.reembed('new-model', async (texts) => { second.push(...texts); return texts.map(() => [0.25, 0.25]); });
    // The lesson was re-embedded before the stop: it is not embedded again.
    expect(second.sort()).toEqual(['M\nC', 'a.ts: S', 'chunk'].sort());
    expect(n).toBe(3);
    expect(await probe.embeddings()).toEqual({ c: [0.25, 0.25], f1: [0.25, 0.25], l: [0.5, 0.5], m: [0.25, 0.25] });
    expect(await e.check('new-model')).toEqual({ ok: true, stored: 'new-model' });

    // A later re-embed (with any model) starts from the beginning again.
    const third: string[] = [];
    await e.reembed('newer-model', async (texts) => { third.push(...texts); return texts.map(() => [0.1, 0.1]); });
    expect(third).toHaveLength(4);
  });

  test('a stopped re-embed followed by a run with another model re-embeds everything with that model', async () => {
    await seedAll();
    await expect(e.reembed('new-model', failingOnMiss([]))).rejects.toThrow();
    const seen: string[] = [];
    expect(await e.reembed('other-model', async (texts) => { seen.push(...texts); return texts.map(() => [0.3, 0.3]); })).toBe(4);
    expect(seen).toHaveLength(4);
    expect(await e.check('other-model')).toEqual({ ok: true, stored: 'other-model' });
  });
});
