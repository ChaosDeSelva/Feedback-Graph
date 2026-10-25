import { extractJsonAnswer } from './llm/json.ts';
import { ModelTimeoutError, modelTimeoutReason, ProviderUnavailableError, providerUnavailableReason } from './llm/unavailable.ts';
import type { OllamaHealth } from './types.ts';

const base = (url: string) => url.replace(/\/+$/, '');
const START = 'start it (ollama serve), or point OLLAMA_URL at a running one';

/** Tokens one answer may run to (num_predict). Every structured answer here fits easily; a runaway loop is cut off. */
export const DEFAULT_NUM_PREDICT = 2048;
/** Mild repeat penalty: enough to break the repetition loops some local models fall into under constrained decoding. */
export const DEFAULT_REPEAT_PENALTY = 1.1;
/** A chat call's time limit when neither the job nor OLLAMA_TIMEOUT_SECONDS sets one. */
export const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;
/** Context for embedding models whose trained context is smaller than Ollama's default, by model name. */
const EMBED_NUM_CTX: Record<string, number> = { 'nomic-embed-text': 2048 };

export type OllamaTuning = { numPredict: number; repeatPenalty: number; timeoutMs: number | null };

const positive = (raw: string | undefined): number | null => {
  const n = Number(raw?.trim() || NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * OLLAMA_NUM_PREDICT, OLLAMA_REPEAT_PENALTY and OLLAMA_TIMEOUT_SECONDS (null: each job's own limit). A value that is
 * not a positive number falls back to the default here; loadConfig reports it.
 */
export function ollamaTuning(env: Record<string, string | undefined>): OllamaTuning {
  const timeout = positive(env.OLLAMA_TIMEOUT_SECONDS);
  return {
    numPredict: Math.floor(positive(env.OLLAMA_NUM_PREDICT) ?? DEFAULT_NUM_PREDICT),
    repeatPenalty: positive(env.OLLAMA_REPEAT_PENALTY) ?? DEFAULT_REPEAT_PENALTY,
    timeoutMs: timeout === null ? null : Math.round(timeout * 1000),
  };
}

/** A fetch to Ollama that names Ollama, its URL and the model when nothing answers, instead of a bare "fetch failed". */
async function ollamaFetch(url: string, model: string, what: string, fix: string, init: RequestInit & { timeoutMs: number }, fetchImpl?: typeof fetch): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  try {
    return await (fetchImpl ?? fetch)(`${base(url)}${what}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (modelTimeoutReason(err)) {
      // Asked, but no answer in time: this item's failure (it counts), not an outage.
      throw new ModelTimeoutError(`Ollama (${model}) did not answer within ${timeoutMs / 1000} s; raise OLLAMA_TIMEOUT_SECONDS, or lower OLLAMA_NUM_PREDICT if it loops`);
    }
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
  /** num_predict; default DEFAULT_NUM_PREDICT. */
  numPredict?: number;
  /** repeat_penalty; default DEFAULT_REPEAT_PENALTY. */
  repeatPenalty?: number;
  /** Base64 images for a vision model, sent with the user message. */
  images?: string[];
};

/** One non-streaming Ollama chat call constrained to a JSON schema. */
export async function ollamaChatJson<T>(o: ChatJsonOpts): Promise<T> {
  const fix = `${START}, or choose another provider for this job (CLASSIFY_LLM, POSTMORTEM_LLM, SCAN_LLM, CHECK_LLM, SUMMARY_LLM)`;
  const res = await ollamaFetch(o.url, o.model, '/api/chat', fix, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: o.model,
      stream: false,
      format: o.schema,
      options: { temperature: 0, num_predict: o.numPredict ?? DEFAULT_NUM_PREDICT, repeat_penalty: o.repeatPenalty ?? DEFAULT_REPEAT_PENALTY },
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user, ...(o.images?.length ? { images: o.images } : {}) },
      ],
    }),
    timeoutMs: o.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
  }, o.fetchImpl);
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { message?: { content?: string } };
  // The schema is applied at the end of decoding, so some models still write reasoning or a fence around the JSON.
  return extractJsonAnswer(body.message?.content ?? '') as T;
}

export type EmbedOpts = {
  url: string;
  model: string;
  input: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** num_ctx for the embedding model; default its trained context when known (nomic-embed-text: 2048), else Ollama's. */
  numCtx?: number;
};

/** Batch embeddings via Ollama's /api/embed. */
export async function ollamaEmbed(o: EmbedOpts): Promise<number[][]> {
  const numCtx = o.numCtx ?? EMBED_NUM_CTX[o.model.replace(/:latest$/, '')];
  // Embeddings always come from Ollama: search, get_task_context and check_before_done need it running.
  const res = await ollamaFetch(o.url, o.model, '/api/embed', START, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: o.model, input: o.input, ...(numCtx ? { options: { num_ctx: numCtx } } : {}) }),
    timeoutMs: o.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
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
    return { url, ok: false, reason: modelTimeoutReason(err) ? `Ollama at ${url} did not answer in time` : `Ollama is not reachable at ${url}: ${START}` };
  }
}
