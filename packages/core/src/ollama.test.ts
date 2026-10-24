import { expect, test } from 'vitest';
import { ollamaChatJson, ollamaEmbed, ollamaPing } from './ollama.ts';
import { ProviderUnavailableError, providerUnavailableReason } from './llm/unavailable.ts';

test('ollamaEmbed posts inputs and returns one vector per input', async () => {
  let body: any;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    expect(url).toBe('http://o/api/embed');
    body = JSON.parse(init.body as string);
    return Response.json({ embeddings: [[0.1, 0.2], [0.3, 0.4]] });
  }) as unknown as typeof fetch;
  const out = await ollamaEmbed({ url: 'http://o/', model: 'nomic-embed-text', input: ['a', 'b'], fetchImpl });
  expect(body).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
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
