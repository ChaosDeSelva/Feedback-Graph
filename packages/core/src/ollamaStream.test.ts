import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { askJson, ModelOutputError } from './llm/json.ts';
import { ModelTimeoutError, providerUnavailableReason } from './llm/unavailable.ts';
import { makeProvider } from './llm/providers.ts';
import { MAX_STRING_WHITESPACE_RUN, MAX_WHITESPACE_RUN, ollamaChatJson } from './ollama.ts';

// A stand-in Ollama that streams /api/chat as the real one does: one JSON object per line, then a done line.

type Reply = (send: (chunk: object) => boolean, res: ServerResponse, req: IncomingMessage) => void | Promise<void>;
const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function ollama(...replies: Reply[]): Promise<{ url: string; asked: () => number; closedEarly: () => number; sent: () => number }> {
  let asked = 0;
  let closedEarly = 0;
  let sent = 0;
  const server = createServer((req, res) => {
    const reply = replies[Math.min(asked++, replies.length - 1)];
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.on('close', () => { if (!res.writableEnded) closedEarly++; });
    void reply((chunk) => { sent++; return res.write(`${JSON.stringify(chunk)}\n`); }, res, req);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push({ close: () => { server.closeAllConnections(); server.close(); } });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked: () => asked, closedEarly: () => closedEarly, sent: () => sent };
}

const piece = (content: string) => ({ model: 'm', message: { role: 'assistant', content }, done: false });
const done = { model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 9 };
/** Streams `text` in pieces of `size` characters, then the done line. */
const answer = (text: string, size = 4): Reply => (send, res) => {
  for (let i = 0; i < text.length; i += size) send(piece(text.slice(i, i + size)));
  send(done);
  res.end();
};
/** A JSON start, then blank lines until the client hangs up (as gemma4 does under a schema until num_predict). */
const runaway: Reply = (send, res) => {
  send(piece('{"taskTitle": "x", "contextItems": [{"excerpt": "y"'));
  const tick = setInterval(() => { if (res.destroyed) clearInterval(tick); else send(piece('\n  ')); }, 1);
  res.on('close', () => clearInterval(tick));
};
const ask = (url: string, o: { timeoutMs?: number } = {}) => ollamaChatJson<unknown>({ url, model: 'gemma4', system: 'S', user: 'U', schema: { type: 'object' }, ...o });

test('a streamed answer reads as the non-streamed one did', async () => {
  const s = await ollama(answer('{"label":"neutral"}'));
  expect(await ask(s.url)).toEqual({ label: 'neutral' });
  expect(s.closedEarly()).toBe(0);
});

test('a long answer with deep indentation and many lines is never cut: only whitespace in a row counts', async () => {
  const value = { items: Array.from({ length: 60 }, (_, i) => ({ ref: `src/f${i}.ts`, excerpt: `line ${i}`, nested: { deeper: { deepest: [i, i + 1] } } })) };
  const text = JSON.stringify(value, null, 12);
  expect(text.length).toBeGreaterThan(20 * MAX_WHITESPACE_RUN);
  const s = await ollama(answer(text, 1));
  expect(await ask(s.url)).toEqual(value);
  expect(s.closedEarly()).toBe(0);
});

test('an answer that turns into runaway whitespace is cut there, the request ended, and the failure is a ModelOutputError', async () => {
  const s = await ollama(runaway);
  const err = await ask(s.url).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ModelOutputError);
  expect((err as Error).message).toMatch(new RegExp(`gemma4 wrote ${MAX_WHITESPACE_RUN} or more whitespace characters in a row`));
  expect((err as Error).message).toMatch(/"excerpt": "y"/);
  await expect.poll(() => s.closedEarly()).toBe(1);
  // About MAX_WHITESPACE_RUN / 3 blank pieces, not a decode to the end of num_predict.
  expect(s.sent()).toBeLessThan(MAX_WHITESPACE_RUN);
});

test('askJson asks again at once after a runaway answer, and takes the second', async () => {
  const s = await ollama(runaway, answer('{"label":"neutral"}'));
  const provider = makeProvider('ollama:gemma4', { OLLAMA_URL: s.url }, {});
  const out = await askJson(provider, { system: 'S', user: 'U', schema: { type: 'object' } }, (raw) => raw as { label: string });
  expect(out).toEqual({ label: 'neutral' });
  expect(s.asked()).toBe(2);
});

test('an error Ollama reports mid-stream is an outage, as the same crash answered unstreamed (HTTP 500) was', async () => {
  const s = await ollama((send, res) => {
    send(piece('{"label":'));
    send({ error: 'model runner has unexpectedly stopped' });
    res.end();
  });
  const err = await ask(s.url).catch((e: unknown) => e);
  expect((err as Error).message).toBe('ollama 500: model runner has unexpectedly stopped');
  expect(providerUnavailableReason(err)).toMatch(/answered HTTP 500/);
});

test('a repetition abort Ollama reports mid-stream is still this answer\'s failure, not an outage', async () => {
  const s = await ollama((send, res) => {
    send(piece('{"label":'));
    send({ error: 'prediction aborted: token repeat limit reached' });
    res.end();
  });
  expect(providerUnavailableReason(await ask(s.url).catch((e: unknown) => e))).toBeNull();
});

test('a wide verbatim quote inside a JSON string is never cut; whitespace that runs on inside a string still is', async () => {
  const quote = `name${' '.repeat(230)}status\napi-7f9c${' '.repeat(226)}CrashLoopBackOff`;
  const value = { excerpt: quote, why: 'the status column says the pod is crashing' };
  const s = await ollama(answer(JSON.stringify(value), 3));
  expect(await ask(s.url)).toEqual(value);
  expect(s.closedEarly()).toBe(0);
  // An escaped quote does not end the string, so its spaces are still read as the string's.
  const escaped = { excerpt: `say \"${' '.repeat(300)}\" twice` };
  expect(await ask((await ollama(answer(JSON.stringify(escaped), 5))).url)).toEqual(escaped);
  const runaway = await ollama((send, res) => {
    send(piece('{"excerpt": "a'));
    const tick = setInterval(() => { if (res.destroyed) clearInterval(tick); else send(piece(' '.repeat(50))); }, 1);
    res.on('close', () => clearInterval(tick));
  });
  const err = await ask(runaway.url).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ModelOutputError);
  expect((err as Error).message).toMatch(new RegExp(`wrote ${MAX_STRING_WHITESPACE_RUN} or more whitespace characters`));
});

test('a stream that stalls past the time limit is a ModelTimeoutError, as an answer that never came was', async () => {
  const s = await ollama((send) => { send(piece('{"label":')); });
  const err = await ask(s.url, { timeoutMs: 100 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ModelTimeoutError);
  expect((err as Error).message).toMatch(/Ollama \(gemma4\) did not answer within 0\.1 s/);
});

test('a caller that gives up mid-stream gets its own reason back', async () => {
  const s = await ollama((send) => { send(piece('{"label":')); });
  const stop = new AbortController();
  const p = ollamaChatJson({ url: s.url, model: 'm', system: 'S', user: 'U', schema: {}, signal: stop.signal }).catch((e: unknown) => e);
  setTimeout(() => stop.abort(new Error('check expired')), 20);
  expect(((await p) as Error).message).toBe('check expired');
});
