import { ProviderUnavailableError, providerUnavailableReason } from './llm/unavailable.ts';
import type { OllamaHealth } from './types.ts';

const base = (url: string) => url.replace(/\/+$/, '');
const START = 'start it (ollama serve), or point OLLAMA_URL at a running one';

/** A fetch to Ollama that names Ollama, its URL and the model when nothing answers, instead of a bare "fetch failed". */
async function ollamaFetch(url: string, model: string, what: string, fix: string, init: RequestInit, fetchImpl?: typeof fetch): Promise<Response> {
  try {
    return await (fetchImpl ?? fetch)(`${base(url)}${what}`, init);
  } catch (err) {
    const why = providerUnavailableReason(err);
    if (why?.startsWith('cannot reach')) {
      const code = why.match(/\((\w+)\)$/)?.[1];
      throw new ProviderUnavailableError(`Ollama is not reachable at ${base(url)} (${model}${code ? `, ${code}` : ''}): ${fix}`);
    }
    throw err;
  }
}

export type ChatJsonOpts = {
  url: string;
  model: string;
  system: string;
  user: string;
  schema: object;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** One non-streaming Ollama chat call constrained to a JSON schema. */
export async function ollamaChatJson<T>(o: ChatJsonOpts): Promise<T> {
  const fix = `${START}, or choose another provider for this job (CLASSIFY_LLM, POSTMORTEM_LLM, SCAN_LLM, CHECK_LLM)`;
  const res = await ollamaFetch(o.url, o.model, '/api/chat', fix, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: o.model,
      stream: false,
      format: o.schema,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user },
      ],
    }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
  }, o.fetchImpl);
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return JSON.parse(body.message?.content ?? '') as T;
}

export type EmbedOpts = { url: string; model: string; input: string[]; fetchImpl?: typeof fetch };

/** Batch embeddings via Ollama's /api/embed. */
export async function ollamaEmbed(o: EmbedOpts): Promise<number[][]> {
  // Embeddings always come from Ollama: search, get_task_context and check_before_done need it running.
  const res = await ollamaFetch(o.url, o.model, '/api/embed', START, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: o.model, input: o.input }),
    signal: AbortSignal.timeout(120_000),
  }, o.fetchImpl);
  if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
  const { embeddings } = (await res.json()) as { embeddings?: number[][] };
  if (!embeddings || embeddings.length !== o.input.length) throw new Error('ollama embed: wrong embedding count');
  return embeddings;
}

/** Whether Ollama answers at `url` and has `models` pulled (GET /api/tags, a few seconds at most). Never throws. */
export async function ollamaPing(o: { url: string; models: string[]; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<OllamaHealth> {
  const url = base(o.url);
  try {
    const res = await (o.fetchImpl ?? fetch)(`${url}/api/tags`, { signal: AbortSignal.timeout(o.timeoutMs ?? 3000) });
    if (!res.ok) return { url, ok: false, reason: `Ollama at ${url} answered HTTP ${res.status}` };
    const { models = [] } = (await res.json()) as { models?: { name?: string }[] };
    const have = new Set(models.flatMap((m) => (m.name ? [m.name, m.name.replace(/:latest$/, '')] : [])));
    const missing = o.models.find((m) => !have.has(m));
    return missing ? { url, ok: false, reason: `${missing} is not pulled (ollama pull ${missing})` } : { url, ok: true, reason: null };
  } catch (err) {
    const why = providerUnavailableReason(err);
    return { url, ok: false, reason: why?.startsWith('timed out') ? `Ollama at ${url} did not answer in time` : `Ollama is not reachable at ${url}: ${START}` };
  }
}
