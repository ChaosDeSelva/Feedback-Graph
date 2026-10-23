/** Re-embed the whole graph with OLLAMA_EMBED_MODEL after changing it. Run with the worker stopped:
 *  docker compose stop worker api && docker compose run --rm worker node src/reembed.ts && docker compose up -d */
import { loadConfig, ollamaEmbed } from '@fb/core';
import { openStore } from '@fb/store-postgres';

const config = loadConfig(process.env);
const store = await openStore(config);
await store.ensureSchema();
const e = store.embeddings;
const from = await e.stored();
console.log(JSON.stringify({ msg: 're-embedding', store: store.kind, from, to: config.ollama.embedModel }));
const n = await e.reembed(
  config.ollama.embedModel,
  (input) => ollamaEmbed({ url: config.ollama.url, model: config.ollama.embedModel, input }),
  (label, done) => console.log(JSON.stringify({ msg: 'progress', label, done })),
);
console.log(JSON.stringify({ msg: 're-embedded', nodes: n, model: config.ollama.embedModel }));
await store.close();
