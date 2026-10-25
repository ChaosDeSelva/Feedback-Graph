import { expect, test } from 'vitest';
import { makeProvider } from './providers.ts';
import type { ProviderHealth } from '../types.ts';
import { ModelTimeoutError, modelTimeoutReason, ProviderUnavailableError, providerUnavailableReason, withHealth } from './unavailable.ts';

const task = { system: 'S', user: 'U', schema: { type: 'object' } };
const fetchFails = (cause: object) => (async () => { throw new TypeError('fetch failed', { cause }); }) as unknown as typeof fetch;
const answers = (status: number, text: string) => (async () => new Response(text, { status })) as unknown as typeof fetch;

/** What a real provider throws for a given failure, run through the classifier. */
async function reasonFor(spec: string, env: Record<string, string>, o: Parameters<typeof makeProvider>[2]) {
  const err = await makeProvider(spec, env, o).json(task).then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  return providerUnavailableReason(err);
}

test('a model that cannot be reached is unavailable: refused, DNS, reset', async () => {
  expect(await reasonFor('ollama:gemma4', { OLLAMA_URL: 'http://o' }, { fetchImpl: fetchFails({ code: 'ECONNREFUSED' }) })).toMatch(/Ollama is not reachable at http:\/\/o \(gemma4, ECONNREFUSED\)/);
  expect(await reasonFor('openai:gpt', { OPENAI_API_KEY: 'k' }, { fetchImpl: fetchFails({ code: 'ENOTFOUND' }) })).toMatch(/cannot reach.*ENOTFOUND/);
  expect(await reasonFor('ollama:gemma4', {}, { fetchImpl: fetchFails({ code: 'EAI_AGAIN' }) })).toMatch(/EAI_AGAIN/);
});

test('a call that timed out is not unavailability: it is that item\'s failure, with its own reason', async () => {
  const slow = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as unknown as typeof fetch;
  expect(await reasonFor('ollama:gemma4', {}, { fetchImpl: slow })).toBeNull();
  const ollamaErr = await makeProvider('ollama:gemma4', {}, { fetchImpl: slow }).json(task).catch((e: unknown) => e);
  expect(ollamaErr).toBeInstanceOf(ModelTimeoutError);
  expect(modelTimeoutReason(ollamaErr)).toMatch(/Ollama \(gemma4\) did not answer within 120 s.*OLLAMA_TIMEOUT_SECONDS/);
  const cliTimeout = async () => ({ code: 124, stdout: '', stderr: '\nclaude timed out after 120000ms' });
  expect(await reasonFor('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec: cliTimeout })).toBeNull();
  expect(modelTimeoutReason(new Error('claude exit 124: claude timed out after 120000ms'))).toMatch(/timed out waiting for claude/);
  expect(modelTimeoutReason(new Error('codex exit 124: x'))).toMatch(/timed out waiting for codex/);
  expect(modelTimeoutReason(new Error('openai:gpt 408: slow'))).toMatch(/timed out/);
  expect(modelTimeoutReason(new DOMException('aborted', 'TimeoutError'))).toMatch(/timed out/);
  expect(modelTimeoutReason(new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }))).toMatch(/timed out/);
  expect(providerUnavailableReason(new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }))).toBeNull();
  // Failing to connect at all is still unavailability, even when it ends in a timeout.
  expect(modelTimeoutReason(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))).toBeNull();
  expect(providerUnavailableReason(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))).toMatch(/cannot reach/);
  expect(modelTimeoutReason(new Error('label: invalid'))).toBeNull();
});

test('HTTP 5xx, a missing model (404), auth and rate limits are unavailable', async () => {
  expect(await reasonFor('ollama:gemma4', {}, { fetchImpl: answers(404, '{"error":"model \\"gemma4\\" not found, try pulling it first"}') })).toMatch(/model not found.*gemma4/);
  expect(await reasonFor('ollama:gemma4', {}, { fetchImpl: answers(503, 'loading') })).toMatch(/HTTP 503/);
  expect(await reasonFor('anthropic:m', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl: answers(529, 'overloaded') })).toMatch(/HTTP 529/);
  expect(await reasonFor('openai:gpt', { OPENAI_API_KEY: 'k' }, { fetchImpl: answers(401, 'bad key') })).toMatch(/not authorized/);
  expect(await reasonFor('openrouter:x/y', { OPENROUTER_API_KEY: 'k' }, { fetchImpl: answers(429, 'slow down') })).toMatch(/rate limited/);
});

test('a CLI that is missing or not signed in is unavailable', async () => {
  const notInstalled = async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', syscall: 'spawn claude', path: 'claude' }); };
  expect(await reasonFor('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec: notInstalled })).toMatch(/claude is not installed/);
  const loggedOut = async () => ({ code: 1, stdout: '', stderr: 'Invalid API key · Please run /login' });
  expect(await reasonFor('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec: loggedOut })).toMatch(/not signed in/);
  const expired = async () => ({ code: 0, stdout: JSON.stringify({ is_error: true, result: 'OAuth token has expired' }), stderr: '' });
  expect(await reasonFor('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec: expired })).toMatch(/not signed in/);
  const codexOut = async () => ({ code: 1, stdout: '', stderr: 'Error: Not logged in. Run codex login' });
  expect(await reasonFor('codex-cli', { ALLOW_UNCONFINED_CODEX: '1' }, { exec: codexOut })).toMatch(/not signed in/);
});

test('an answer that cannot be used is not unavailability: bad JSON, a 400, a CLI error about the task', async () => {
  expect(await reasonFor('ollama:gemma4', {}, { fetchImpl: (async () => Response.json({ message: { content: 'not json' } })) as unknown as typeof fetch })).toBeNull();
  expect(await reasonFor('openai:gpt', { OPENAI_API_KEY: 'k' }, { fetchImpl: answers(400, 'context length exceeded') })).toBeNull();
  const maxTurns = async () => ({ code: 0, stdout: JSON.stringify({ is_error: true, result: 'Reached max turns' }), stderr: '' });
  expect(await reasonFor('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec: maxTurns })).toBeNull();
  expect(providerUnavailableReason(new Error('label: invalid enum value'))).toBeNull();
  expect(providerUnavailableReason('boom')).toBeNull();
  // Ollama aborting one generation (stuck repeating, or out of context) answers 500, but the model is up: that item's
  // failure, so the stage goes on instead of pausing on the same item every cycle.
  expect(await reasonFor('ollama:gemma4', {}, { fetchImpl: answers(500, '{"error":"prediction aborted, token repeat limit reached"}') })).toBeNull();
  expect(providerUnavailableReason(new Error('ollama:gemma4 500: {"error":"prediction aborted, token repeat limit reached"}'))).toBeNull();
  expect(providerUnavailableReason(new Error('ollama:gemma4 500: {"error":"model runner has unexpectedly stopped"}'))).toMatch(/HTTP 500/);
});

test('reasons never carry a key, and ProviderUnavailableError keeps its own', async () => {
  const leaky = answers(401, 'invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
  expect(await reasonFor('anthropic:m', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl: leaky })).not.toMatch(/sk-ant-api03-abc/);
  expect(providerUnavailableReason(new ProviderUnavailableError('no classifier configured'))).toBe('no classifier configured');
});

test('withHealth reports ok on an answer and the reason on unavailability, and leaves bad answers alone', async () => {
  const seen: ProviderHealth[] = [];
  let next: () => Promise<unknown> = async () => ({ ok: 1 });
  const p = withHealth({ id: 'x', agentic: false, json: () => next() }, (h) => seen.push(h));
  expect(p).toMatchObject({ id: 'x', agentic: false });
  await p.json(task);
  next = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  await expect(p.json(task)).rejects.toThrow(/fetch failed/);
  next = async () => { throw new Error('unparseable'); };
  await expect(p.json(task)).rejects.toThrow(/unparseable/);
  expect(seen.map((h) => [h.ok, h.reason?.slice(0, 15) ?? null])).toEqual([[true, null], [false, 'cannot reach th']]);
  expect(seen[1].provider).toBe('x');
});

test('withHealth keeps whether the provider can read images', () => {
  const see = withHealth({ id: 'ollama:gemma4', agentic: false, vision: true, json: async () => ({}) }, () => {});
  const blindOne = withHealth({ id: 'jev', agentic: false, json: async () => ({}) }, () => {});
  expect(see.vision).toBe(true);
  expect(blindOne.vision).toBe(false);
});
