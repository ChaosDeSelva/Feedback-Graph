import { expect, test } from 'vitest';
import type { HumanTurn } from '@fb/core';
import { classifyTurn } from './classify.ts';
import { ollamaChatJson, ProviderUnavailableError } from '@fb/core';

const turn: HumanTurn = {
  uuid: 'u1', sessionId: 's', ts: 't', index: 1,
  text: "this isn't good enough, filter server-side",
  precedingAssistantText: 'Done: client-side filtering.',
  precedingToolCalls: [{ name: 'Edit', ts: 't', filePath: '/a.ts' }],
};
const deps = (chat: (o: { user: string }) => Promise<unknown>) => ({ id: 'fake', agentic: false, json: chat }) as never;

test('passes through a valid classification with prefilter signals', async () => {
  let seenUser = '';
  const chat = async (o: { user: string }) => { seenUser = o.user; return { label: 'pushback', confidence: 0.9, summary: 'wants server-side' }; };
  const c = await classifyTurn(turn, deps(chat));
  expect(c).toMatchObject({ label: 'pushback', confidence: 0.9, summary: 'wants server-side' });
  expect(c!.signals.length).toBeGreaterThan(0);
  expect(seenUser).toContain('client-side filtering');
  expect(seenUser).toContain('Edit /a.ts');
  expect(seenUser).toContain('filter server-side');
});

test('returns null when the model answers with something unusable', async () => {
  expect(await classifyTurn(turn, deps(async () => { throw new SyntaxError('Unexpected token'); }))).toBeNull();
  expect(await classifyTurn(turn, deps(async () => { throw new Error('openai:gpt 400: context length exceeded'); }))).toBeNull();
});

test('throws ProviderUnavailableError when the model cannot be asked, so the turn is not charged an attempt', async () => {
  const refused = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  await expect(classifyTurn(turn, deps(refused))).rejects.toBeInstanceOf(ProviderUnavailableError);
  const missing = async () => { throw new Error('ollama 404: {"error":"model \\"gemma4\\" not found"}'); };
  await expect(classifyTurn(turn, deps(missing))).rejects.toThrow(/model not found/);
  const timeout = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  await expect(classifyTurn(turn, deps(timeout))).rejects.toThrow(/timed out/);
});

test('returns null on an invalid label', async () => {
  expect(await classifyTurn(turn, deps(async () => ({ label: 'banana', confidence: 1, summary: '' })))).toBeNull();
});

test('ollamaChatJson posts a non-streaming chat with the schema and parses content', async () => {
  let body: any;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ message: { content: '{"label":"neutral"}' } }));
  }) as typeof fetch;
  const out = await ollamaChatJson({ url: 'http://o', model: 'm', system: 'S', user: 'U', schema: { type: 'object' }, fetchImpl });
  expect(out).toEqual({ label: 'neutral' });
  expect(body).toMatchObject({ model: 'm', stream: false, format: { type: 'object' } });
  expect(body.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
});

test('ollamaChatJson throws on a non-2xx response', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  await expect(ollamaChatJson({ url: 'http://o', model: 'm', system: '', user: '', schema: {}, fetchImpl })).rejects.toThrow();
});

test('an agentic classifier (claude-cli, codex-cli) runs in a fresh empty folder, never the worker folder, removed afterwards', async () => {
  const { readdir, stat } = await import('node:fs/promises');
  const seen: { cwd?: string; files: string[] }[] = [];
  const llm = { id: 'claude-cli', agentic: true, json: async (t: { cwd?: string }) => {
    seen.push({ cwd: t.cwd, files: t.cwd ? await readdir(t.cwd) : [] });
    return { label: 'neutral', confidence: 0.9, summary: '' };
  } } as never;
  await classifyTurn(turn, llm);
  expect(seen).toHaveLength(1);
  expect(seen[0].cwd).toBeTruthy();
  expect(seen[0].cwd).not.toBe(process.cwd());
  expect(seen[0].files).toEqual([]);
  await expect(stat(seen[0].cwd!)).rejects.toThrow();
});
