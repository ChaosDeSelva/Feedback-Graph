import { expect, test } from 'vitest';
import { DEFAULT_NUM_PREDICT, DEFAULT_REPEAT_PENALTY, ollamaChatJson, ollamaEmbed, ollamaPing, ollamaTuning } from './ollama.ts';
import { ModelTimeoutError, ProviderUnavailableError, providerUnavailableReason } from './llm/unavailable.ts';
import { ModelOutputError } from './llm/json.ts';
import { makeProvider } from './llm/providers.ts';

const capture = (content = '{"ok":true}') => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return Response.json({ message: { content } });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
};

test('every chat call carries generation limits, so a runaway answer stops instead of looping until the timeout', async () => {
  const { bodies, fetchImpl } = capture();
  await ollamaChatJson({ url: 'http://o', model: 'm', system: 'S', user: 'U', schema: {}, fetchImpl });
  expect(bodies[0].options).toEqual({ temperature: 0, num_predict: DEFAULT_NUM_PREDICT, repeat_penalty: DEFAULT_REPEAT_PENALTY });
  expect(DEFAULT_NUM_PREDICT).toBe(2048);
  expect(DEFAULT_REPEAT_PENALTY).toBe(1.1);
  await ollamaChatJson({ url: 'http://o', model: 'm', system: 'S', user: 'U', schema: {}, fetchImpl, numPredict: 512, repeatPenalty: 1.3 });
  expect(bodies[1].options).toEqual({ temperature: 0, num_predict: 512, repeat_penalty: 1.3 });
});

test('ollamaTuning reads OLLAMA_NUM_PREDICT, OLLAMA_REPEAT_PENALTY and OLLAMA_TIMEOUT_SECONDS, falling back on bad values', () => {
  expect(ollamaTuning({})).toEqual({ numPredict: 2048, repeatPenalty: 1.1, timeoutMs: null });
  expect(ollamaTuning({ OLLAMA_NUM_PREDICT: '4096', OLLAMA_REPEAT_PENALTY: '1.2', OLLAMA_TIMEOUT_SECONDS: '300' })).toEqual({ numPredict: 4096, repeatPenalty: 1.2, timeoutMs: 300_000 });
  expect(ollamaTuning({ OLLAMA_NUM_PREDICT: 'lots', OLLAMA_REPEAT_PENALTY: '-1', OLLAMA_TIMEOUT_SECONDS: '0' })).toEqual({ numPredict: 2048, repeatPenalty: 1.1, timeoutMs: null });
});

test('the ollama provider sends the env limits and lets OLLAMA_TIMEOUT_SECONDS override the job timeout', async () => {
  const { bodies, fetchImpl } = capture();
  await makeProvider('ollama:m', { OLLAMA_NUM_PREDICT: '1000', OLLAMA_REPEAT_PENALTY: '1.05' }, { fetchImpl }).json({ system: 'S', user: 'U', schema: {} });
  expect(bodies[0].options).toEqual({ temperature: 0, num_predict: 1000, repeat_penalty: 1.05 });
  const slow = (async (_u: string, init: RequestInit) => {
    await new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
  }) as unknown as typeof fetch;
  const started = Date.now();
  const err = await makeProvider('ollama:m', { OLLAMA_TIMEOUT_SECONDS: '0.05' }, { fetchImpl: slow }).json({ system: 'S', user: 'U', schema: {}, timeoutMs: 60_000 }).catch((e: unknown) => e);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(err).toBeInstanceOf(ModelTimeoutError);
  expect((err as Error).message).toMatch(/Ollama \(m\) did not answer within 0\.05 s/);
});

test('a chat answer wrapped in reasoning prose or a fence still parses; no JSON is a ModelOutputError with the tail', async () => {
  const fenced = capture('6. Construct the JSON:\n```json\n{"label":"neutral"}\n```');
  expect(await ollamaChatJson({ url: 'http://o', model: 'm', system: '', user: '', schema: {}, fetchImpl: fenced.fetchImpl })).toEqual({ label: 'neutral' });
  const prose = capture('I think the answer is neutral because');
  const err = await ollamaChatJson({ url: 'http://o', model: 'm', system: '', user: '', schema: {}, fetchImpl: prose.fetchImpl }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ModelOutputError);
  expect((err as Error).message).toMatch(/answer is neutral because/);
});

test('ollamaEmbed sets num_ctx to the embedding model\'s trained context (nomic-embed-text: 2048)', async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(init.body as string);
    bodies.push(b);
    return Response.json({ embeddings: b.input.map(() => [0]) });
  }) as unknown as typeof fetch;
  await ollamaEmbed({ url: 'http://o', model: 'nomic-embed-text', input: ['a'], fetchImpl });
  await ollamaEmbed({ url: 'http://o', model: 'nomic-embed-text:latest', input: ['a'], fetchImpl });
  await ollamaEmbed({ url: 'http://o', model: 'mxbai-embed-large', input: ['a'], fetchImpl });
  await ollamaEmbed({ url: 'http://o', model: 'mxbai-embed-large', input: ['a'], fetchImpl, numCtx: 512 });
  expect(bodies.map((b) => b.options)).toEqual([{ num_ctx: 2048 }, { num_ctx: 2048 }, undefined, { num_ctx: 512 }]);
});

test('ollamaPing says when Ollama did not answer in time', async () => {
  const slow = (async () => { throw new DOMException('timeout', 'TimeoutError'); }) as unknown as typeof fetch;
  expect((await ollamaPing({ url: 'http://o', models: [], fetchImpl: slow })).reason).toBe('Ollama at http://o did not answer in time');
});

test('ollamaEmbed posts inputs and returns one vector per input', async () => {
  let body: any;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    expect(url).toBe('http://o/api/embed');
    body = JSON.parse(init.body as string);
    return Response.json({ embeddings: [[0.1, 0.2], [0.3, 0.4]] });
  }) as unknown as typeof fetch;
  const out = await ollamaEmbed({ url: 'http://o/', model: 'nomic-embed-text', input: ['a', 'b'], fetchImpl });
  expect(body).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'], options: { num_ctx: 2048 } });
  expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
});

test('ollamaEmbed throws when the count does not match', async () => {
  const fetchImpl = (async () => Response.json({ embeddings: [] })) as unknown as typeof fetch;
  await expect(ollamaEmbed({ url: 'http://o', model: 'm', input: ['a'], fetchImpl })).rejects.toThrow();
});

// What fetch throws when nothing listens on the port.
const refused = (async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}) as unknown as typeof fetch;

test('an Ollama that is not running is named, with its URL, the model and the fix, and counts as unavailable', async () => {
  const embed = ollamaEmbed({ url: 'http://host.docker.internal:11434/', model: 'nomic-embed-text', input: ['a'], fetchImpl: refused });
  await expect(embed).rejects.toThrow(/Ollama is not reachable at http:\/\/host\.docker\.internal:11434 \(nomic-embed-text, ECONNREFUSED\): start it/);
  await expect(embed).rejects.toBeInstanceOf(ProviderUnavailableError);
  const chat = ollamaChatJson({ url: 'http://o', model: 'gemma4', system: 's', user: 'u', schema: {}, fetchImpl: refused });
  await expect(chat).rejects.toThrow(/Ollama is not reachable at http:\/\/o \(gemma4, ECONNREFUSED\): start it .*_LLM/);
  expect(providerUnavailableReason(await chat.catch((e) => e))).toMatch(/^Ollama is not reachable/);
  // Summaries are a job with their own model too: the hint names every job's setting.
  await expect(chat).rejects.toThrow(/CLASSIFY_LLM, POSTMORTEM_LLM, SCAN_LLM, CHECK_LLM, SUMMARY_LLM/);
});

test('ollamaPing: ok when Ollama answers and has the models; otherwise the reason', async () => {
  const tags = (names: string[]) => (async (url: string) => {
    expect(url).toBe('http://o/api/tags');
    return Response.json({ models: names.map((name) => ({ name })) });
  }) as unknown as typeof fetch;
  expect(await ollamaPing({ url: 'http://o/', models: ['nomic-embed-text', 'gemma4'], fetchImpl: tags(['nomic-embed-text:latest', 'gemma4:latest']) })).toEqual({ url: 'http://o', ok: true, reason: null });
  expect(await ollamaPing({ url: 'http://o', models: ['nomic-embed-text'], fetchImpl: tags(['gemma4:latest']) }))
    .toEqual({ url: 'http://o', ok: false, reason: 'nomic-embed-text is not pulled (ollama pull nomic-embed-text)' });
  const down = await ollamaPing({ url: 'http://o', models: ['nomic-embed-text'], fetchImpl: refused });
  expect(down).toMatchObject({ url: 'http://o', ok: false });
  expect(down.reason).toMatch(/^Ollama is not reachable at http:\/\/o: start it/);
});
