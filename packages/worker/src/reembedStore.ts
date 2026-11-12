import type { Store } from '@fb/core';

/**
 * Re-embed every stored vector with `model` (OLLAMA_EMBED_MODEL after it changed), logging the model it came from,
 * progress per label and the nodes done. The schema is made sure of first.
 */
export async function reembedStore(store: Pick<Store, 'ensureSchema' | 'embeddings' | 'kind'>, model: string, embed: (texts: string[]) => Promise<number[][]>, log: (line: object) => void): Promise<number> {
  await store.ensureSchema();
  const from = await store.embeddings.stored();
  log({ msg: 're-embedding', store: store.kind, from, to: model });
  const n = await store.embeddings.reembed(model, embed, (label, done) => log({ msg: 'progress', label, done }));
  log({ msg: 're-embedded', nodes: n, model });
  return n;
}
