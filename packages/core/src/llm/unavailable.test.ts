import { expect, test } from 'vitest';
import { makeProvider } from './providers.ts';
import type { ProviderHealth } from '../types.ts';
import { ProviderUnavailableError, providerUnavailableReason, withHealth } from './unavailable.ts';

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

test('a timeout is unavailable', async () => {
  const slow = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as unknown as typeof fetch;
  expect(await reasonFor('ollama:gemma4', {}, { fetchImpl: slow })).toMatch(/timed out/);
  const cliTimeout = async () => ({ code: 124, stdout: '', stderr: '\nclaude timed out after 120000ms' });
  expect(await reasonFor('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec: cliTimeout })).toMatch(/timed out/);
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
