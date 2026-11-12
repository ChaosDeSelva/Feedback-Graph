import { shownProjects, type ChatConversation, type ChatThread } from '@fb/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { ChatRouteDeps } from './chat.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

/** Reads a stream a fake second at a time while nothing arrives (at most a minute), until `until` holds. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until: (text: string) => boolean): Promise<string> {
  const dec = new TextDecoder();
  let text = '';
  for (let s = 0; s < 60 && !until(text);) {
    let got: ReadableStreamReadResult<Uint8Array> | null = null;
    const next = reader.read().then((r) => { got = r; });
    while (!got && s < 60) { await vi.advanceTimersByTimeAsync(1000); s++; }
    if (!got) break;
    await next;
    const { value, done } = got as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    text += dec.decode(value);
  }
  return text;
}

test('/api/events sends an answer\'s status changes for a shown project\'s chat, never for a hidden one', async () => {
  let status: 'pending' | 'done' = 'pending';
  const conv = (id: string, projectKey: string): ChatConversation => ({ id, projectKey, title: 'T', provider: null, createdAt: 't', updatedAt: status, pending: status === 'pending' });
  const thread = (id: string, projectKey: string): ChatThread => ({ ...conv(id, projectKey), turns: [{ id: `${id}-a`, role: 'assistant', status, error: null }] as never });
  // A store that ignores projectKeys: the hidden project's conversation is still never streamed.
  const store = {
    listConversations: async () => [conv('c-secret', 'secret'), conv('c-shop', 'shop')],
    conversation: async (id: string) => (id === 'c-shop' ? thread(id, 'shop') : thread(id, 'secret')),
  } as unknown as ChatRouteDeps['store'];
  const app = createApp(repo, {
    shown: () => shownProjects({ tracked: ['shop'], initialized: true }, { excludeProjects: [] }),
    chat: { store, build: async () => ({ context: '', sources: [] }) },
  });
  const res = await app.request('/api/events');
  const reader = res.body!.getReader();
  await readUntil(reader, (t) => t.includes('retry:'));
  await vi.advanceTimersByTimeAsync(3000);
  status = 'done';
  const text = await readUntil(reader, (t) => t.includes('"conversationId":"c-shop"'));
  expect(text).toContain('event: chat');
  expect(text).toContain('"conversationId":"c-shop"');
  expect(text).not.toContain('secret');
  await reader.cancel();
});
