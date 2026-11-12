#!/usr/bin/env node
/**
 * Retrieval on real embeddings: the labelled acme corpus (packages/core/src/testing/lessonCorpus.ts, ACME_TASKS)
 * through the local Ollama embedding model and the real serving path (get_task_context's lessons, search_graph's), with
 * precision and recall@k per task and overall, and where a floor separates the lessons that apply from the rest. It
 * calibrates the similarity thresholds (packages/core/src/thresholds.ts). Not a test: it prints a report.
 *
 *   node scripts/retrieval-eval.ts [--model nomic-embed-text] [--url http://localhost:11434] [--floor 0.78] [--json out.json]
 *
 * Only a local Ollama is asked: the corpus is fictional, and nothing leaves the machine.
 */
import { writeFileSync } from 'node:fs';
import { ollamaEmbed, SERVE_BY_MEANING } from '../packages/core/src/index.ts';
import { formatRetrievalReport, runRetrievalEval } from '../packages/api/src/retrievalEval.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, '');
  if (!['model', 'url', 'floor', 'json'].includes(k) || process.argv[i + 1] === undefined) {
    console.error(`usage: node scripts/retrieval-eval.ts [--model m] [--url u] [--floor x] [--json out.json] (unknown or empty ${process.argv[i]})`);
    process.exit(2);
  }
  args.set(k, process.argv[i + 1]);
}
const model = args.get('model') ?? process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
const url = args.get('url') ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(:\d+)?\/?$/.test(url)) {
  console.error(`refusing ${url}: the eval asks only a local Ollama`);
  process.exit(2);
}
const floor = Number(args.get('floor') ?? SERVE_BY_MEANING);
const report = await runRetrievalEval((input) => ollamaEmbed({ url, model, input }), { model: `ollama:${model}`, floor });
console.log(formatRetrievalReport(report));
const out = args.get('json');
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
