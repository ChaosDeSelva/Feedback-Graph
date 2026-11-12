import { extractJsonAnswer, ModelOutputError } from './llm/json.ts';
import { ModelTimeoutError, modelTimeoutReason, ProviderUnavailableError, providerUnavailableReason } from './llm/unavailable.ts';
import type { OllamaHealth } from './types.ts';

const base = (url: string) => url.replace(/\/+$/, '');
const START = 'start it (ollama serve), or point OLLAMA_URL at a running one';

/**
 * Tokens one answer may run to (num_predict) when the job names no budget of its own (post-mortems, summaries, scans,
 * documents). Short jobs pass a smaller one (JsonTask.maxTokens), so a runaway answer costs seconds, not a 2048-token
 * decode. OLLAMA_NUM_PREDICT, when set, is the limit for every job.
 */
export const DEFAULT_NUM_PREDICT = 2048;
/**
 * Context window (num_ctx) sent with every chat call. Without it Ollama loads a model at its trained context (131k for
 * gemma4: a 10 GB runner). 16k holds the longest usual prompt (about 8k tokens) plus a 2048-token answer. Every call
 * sends the same value, because a different one reloads the model.
 */
export const DEFAULT_NUM_CTX = 16384;
/** Mild repeat penalty: enough to break the repetition loops some local models fall into under constrained decoding. */
export const DEFAULT_REPEAT_PENALTY = 1.1;
/** A chat call's time limit when neither the job nor OLLAMA_TIMEOUT_SECONDS sets one. */
export const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;
/** Context for embedding models whose trained context is smaller than Ollama's default, by model name. */
const EMBED_NUM_CTX: Record<string, number> = { 'nomic-embed-text': 2048 };

/** numPredict null: each job's own budget, else DEFAULT_NUM_PREDICT. */
export type OllamaTuning = { numPredict: number | null; numCtx: number; repeatPenalty: number; timeoutMs: number | null };

const positive = (raw: string | undefined): number | null => {
  const n = Number(raw?.trim() || NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * OLLAMA_NUM_PREDICT (null: each job's own budget), OLLAMA_NUM_CTX, OLLAMA_REPEAT_PENALTY and OLLAMA_TIMEOUT_SECONDS
 * (null: each job's own limit). A value that is not a positive number falls back to the default here; loadConfig
 * reports it.
 */
export function ollamaTuning(env: Record<string, string | undefined>): OllamaTuning {
  const timeout = positive(env.OLLAMA_TIMEOUT_SECONDS);
  const predict = positive(env.OLLAMA_NUM_PREDICT);
  return {
    numPredict: predict === null ? null : Math.floor(predict),
    numCtx: Math.floor(positive(env.OLLAMA_NUM_CTX) ?? DEFAULT_NUM_CTX),
    repeatPenalty: positive(env.OLLAMA_REPEAT_PENALTY) ?? DEFAULT_REPEAT_PENALTY,
    timeoutMs: timeout === null ? null : Math.round(timeout * 1000),
  };
}

type FetchInit = RequestInit & { timeoutMs: number; /** Cuts the request short (a runaway answer); not the caller giving up. */ cut?: AbortSignal };

/** A failed call to Ollama as the error that says what happened: the caller gave up, no answer in time, or no Ollama. */
function ollamaFailure(err: unknown, url: string, model: string, fix: string, init: FetchInit): unknown {
  // The caller gave up (JsonTask.signal): its reason, not a timeout or an outage.
  if (init.signal?.aborted) return init.signal.reason;
  if (modelTimeoutReason(err)) {
    // Asked, but no answer in time: this item's failure (it counts), not an outage.
    return new ModelTimeoutError(`Ollama (${model}) did not answer within ${init.timeoutMs / 1000} s; raise OLLAMA_TIMEOUT_SECONDS, or lower OLLAMA_NUM_PREDICT if it loops`);
  }
  const why = providerUnavailableReason(err);
  if (why?.startsWith('cannot reach')) {
    const code = why.match(/\((\w+)\)$/)?.[1];
    return new ProviderUnavailableError(`Ollama is not reachable at ${base(url)} (${model}${code ? `, ${code}` : ''}): ${fix}`);
  }
  return err;
}

/** A fetch to Ollama that names Ollama, its URL and the model when nothing answers, instead of a bare "fetch failed". */
async function ollamaFetch(url: string, model: string, what: string, fix: string, init: FetchInit, fetchImpl?: typeof fetch): Promise<Response> {
  const { timeoutMs, signal, cut, ...rest } = init;
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : []), ...(cut ? [cut] : [])];
  try {
    return await (fetchImpl ?? fetch)(`${base(url)}${what}`, { ...rest, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
  } catch (err) {
    throw ollamaFailure(err, url, model, fix, init);
  }
}

/**
 * Whitespace in a row, outside a JSON string, past which a JSON answer has stopped saying anything: under a schema,
 * gemma4 can fill the rest of its budget with blank lines inside an array. The longest indentation of a real answer is
 * a few dozen characters.
 */
export const MAX_WHITESPACE_RUN = 200;
/** The same inside a JSON string, where a verbatim quote of a wide table holds runs of a few hundred spaces. */
export const MAX_STRING_WHITESPACE_RUN = 4000;

type ChatChunk = { message?: { content?: string; thinking?: string }; error?: string };

/**
 * A streamed chat reply, read as it comes: its content and thinking. A reply that turns into MAX_WHITESPACE_RUN
 * whitespace characters in a row (MAX_STRING_WHITESPACE_RUN within a JSON string) is cut there (`stop` ends the request, so Ollama stops decoding) and is a
 * ModelOutputError, which askJson retries at once, rather than a decode to the end of num_predict. A non-streamed body
 * (one object) reads the same.
 */
async function readChat(res: Response, model: string, stop: () => void, fail: (err: unknown) => unknown): Promise<{ content: string; thinking: string }> {
  let content = '';
  let thinking = '';
  let run = 0;
  let inString = false;
  let escaped = false;
  let rest = '';
  const take = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as ChatChunk;
    // After the 200 that started the stream, Ollama reports a crashed runner in the body; unstreamed it answered 500,
    // so the error reads as that outage did (a repetition abort still reads as this item's failure).
    if (chunk.error) throw new Error(`ollama 500: ${chunk.error}`);
    const piece = chunk.message?.content ?? '';
    content += piece;
    thinking += chunk.message?.thinking ?? '';
    for (const ch of piece) {
      if (/\s/.test(ch)) run++;
      else run = 0;
      if (escaped) escaped = false;
      else if (ch === '\\' && inString) escaped = true;
      else if (ch === '"') inString = !inString;
      const limit = inString ? MAX_STRING_WHITESPACE_RUN : MAX_WHITESPACE_RUN;
      if (run >= limit) {
        stop();
        throw new ModelOutputError(`${model} wrote ${limit} or more whitespace characters in a row, so the answer was cut there`, content);
      }
    }
  };
  if (!res.body) return { content, thinking };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        throw fail(err);
      }
      if (next.done) break;
      const lines = (rest + decoder.decode(next.value, { stream: true })).split('\n');
      rest = lines.pop()!;
      for (const line of lines) take(line);
    }
    take(rest + decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return { content, thinking };
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
  /** num_ctx; default DEFAULT_NUM_CTX. */
  numCtx?: number;
  /** Base64 images for a vision model, sent with the user message. */
  images?: string[];
  /** Cancels the request when the caller gives up (JsonTask.signal). */
  signal?: AbortSignal;
};

/**
 * Servers that refused the `think` field (an Ollama from before thinking existed, or a proxy in front of one), by URL
 * and model: asked once with it, then never again.
 */
const noThinkField = new Set<string>();
const refusesThink = (status: number, text: string) => status === 400 && /\bthink/i.test(text);

/**
 * One Ollama chat call constrained to a JSON schema, streamed so a runaway answer is cut early (readChat).
 * `think: false` keeps a thinking model (gemma4, qwen3) from spending the answer budget on reasoning before the JSON;
 * Ollama checks the field only when it is true, so models without thinking accept it too.
 */
export async function ollamaChatJson<T>(o: ChatJsonOpts): Promise<T> {
  const fix = `${START}, or choose another provider for this job (CLASSIFY_LLM, POSTMORTEM_LLM, SCAN_LLM, CHECK_LLM, SUMMARY_LLM)`;
  const server = `${base(o.url)} ${o.model}`;
  const cut = new AbortController();
  const init = (think: boolean): FetchInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: o.model,
      stream: true,
      ...(think ? { think: false } : {}),
      format: o.schema,
      options: {
        temperature: 0,
        num_predict: o.numPredict ?? DEFAULT_NUM_PREDICT,
        repeat_penalty: o.repeatPenalty ?? DEFAULT_REPEAT_PENALTY,
        num_ctx: o.numCtx ?? DEFAULT_NUM_CTX,
      },
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: o.user, ...(o.images?.length ? { images: o.images } : {}) },
      ],
    }),
    timeoutMs: o.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
    ...(o.signal && { signal: o.signal }),
    cut: cut.signal,
  });
  const ask = (think: boolean) => ollamaFetch(o.url, o.model, '/api/chat', fix, init(think), o.fetchImpl);
  let res = await ask(!noThinkField.has(server));
  if (!res.ok) {
    const text = await res.text();
    if (noThinkField.has(server) || !refusesThink(res.status, text)) throw new Error(`ollama ${res.status}: ${text}`);
    noThinkField.add(server);
    res = await ask(false);
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  }
  const { content, thinking } = await readChat(res, o.model, () => cut.abort(), (err) => ollamaFailure(err, o.url, o.model, fix, init(false)));
  if (!content.trim() && thinking.trim()) {
    throw new ModelOutputError(`${o.model} answered only in its thinking, with no content: use a model or tag that honours think:false, or raise OLLAMA_NUM_PREDICT`, thinking);
  }
  // The schema is applied at the end of decoding, so some models still write reasoning or a fence around the JSON.
  return extractJsonAnswer(content) as T;
}

export type EmbedOpts = {
  /** Stop queued/running embeddings when the requesting check has expired. */
  signal?: AbortSignal;
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
  const name = o.model.replace(/:latest$/, '');
  const numCtx = o.numCtx ?? (Object.hasOwn(EMBED_NUM_CTX, name) ? EMBED_NUM_CTX[name] : undefined);
  // Embeddings always come from Ollama: search, get_task_context and check_before_done need it running.
  const res = await ollamaFetch(o.url, o.model, '/api/embed', START, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: o.model, input: o.input, ...(numCtx ? { options: { num_ctx: numCtx } } : {}) }),
    timeoutMs: o.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
    ...(o.signal && { signal: o.signal }),
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
