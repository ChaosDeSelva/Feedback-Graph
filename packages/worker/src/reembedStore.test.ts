import type { Store } from '@fb/core';
import { expect, test } from 'vitest';
import { reembedStore } from './reembedStore.ts';

test('re-embeds every vector with the new model, logging where it came from, progress and the count', async () => {
  const calls: string[] = [];
  const lines: object[] = [];
  const embedded: string[][] = [];
  const store = {
    kind: 'postgres',
    ensureSchema: async () => { calls.push('schema'); },
    embeddings: {
      stored: async () => { calls.push('stored'); return 'nomic-embed-text'; },
      check: async () => ({ ok: true, stored: '' }),
      reembed: async (model: string, embed: (t: string[]) => Promise<number[][]>, progress?: (label: string, done: number) => void) => {
        calls.push(`reembed ${model}`);
        await embed(['a fact']);
        progress?.('Fact', 1);
        return 12;
      },
    },
  } as Pick<Store, 'ensureSchema' | 'embeddings' | 'kind'>;
  const n = await reembedStore(store, 'mxbai-embed-large', async (t) => { embedded.push(t); return [[0.1]]; }, (l) => lines.push(l));
  expect(n).toBe(12);
  expect(calls).toEqual(['schema', 'stored', 'reembed mxbai-embed-large']);
  expect(embedded).toEqual([['a fact']]);
  expect(lines).toEqual([
    { msg: 're-embedding', store: 'postgres', from: 'nomic-embed-text', to: 'mxbai-embed-large' },
    { msg: 'progress', label: 'Fact', done: 1 },
    { msg: 're-embedded', nodes: 12, model: 'mxbai-embed-large' },
  ]);
});
