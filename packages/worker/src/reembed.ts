/** Re-embed the whole graph with OLLAMA_EMBED_MODEL after changing it. Run with the worker stopped:
 *  docker compose stop worker api && docker compose run --rm worker node src/reembed.ts && docker compose up -d */
import { loadConfig, ollamaEmbed } from '@fb/core';
import { openStore } from '@fb/store-postgres';
import { reembedStore } from './reembedStore.ts';

const config = loadConfig(process.env);
const store = await openStore(config);
const model = config.ollama.embedModel;
await reembedStore(store, model, (input) => ollamaEmbed({ url: config.ollama.url, model, input }), (line) => console.log(JSON.stringify(line)));
await store.close();
