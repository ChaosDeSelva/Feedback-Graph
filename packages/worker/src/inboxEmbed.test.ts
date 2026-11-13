import { expect, test } from 'vitest';
import { embedInboxBacklog, INBOX_EMBED_BATCH } from './inboxEmbed.ts';

const backlog = (n: number) => {
  const left = new Map(Array.from({ length: n }, (_, i) => [`k${i}`, `text ${i}`]));
  const saved: string[] = [];
  return {
    saved,
    verdicts: {
      inboxToEmbed: async (limit: number) => [...left].slice(0, limit).map(([id, text]) => ({ id, text })),
      setInboxEmbeddings: async (rows: { id: string; embedding: number[] }[]) => { for (const r of rows) { left.delete(r.id); saved.push(r.id); } },
    },
  };
};

test('embeds the backlog a batch at a time, each item with its own vector, until none is left', async () => {
  const b = backlog(INBOX_EMBED_BATCH + 3);
  const texts: string[] = [];
  const done = await embedInboxBacklog({ verdicts: b.verdicts, embed: async (t) => { texts.push(...t); return t.map((x) => [x.length]); }, log: () => {} });
  expect(done).toBe(INBOX_EMBED_BATCH + 3);
  expect(texts).toHaveLength(INBOX_EMBED_BATCH + 3);
  expect(await embedInboxBacklog({ verdicts: b.verdicts, embed: async () => { throw new Error('not called'); }, log: () => {} })).toBe(0);
});

test('an embedder that fails stops it for this wake, logged, with nothing written', async () => {
  const b = backlog(5);
  const logged: string[] = [];
  expect(await embedInboxBacklog({ verdicts: b.verdicts, embed: async () => { throw new Error('ollama down'); }, log: (m) => logged.push(m) })).toBe(0);
  expect(b.saved).toEqual([]);
  expect(logged).toEqual(['inbox items not embedded']);
});
