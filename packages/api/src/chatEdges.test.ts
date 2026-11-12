import { ChatBusyError, shownProjects, type ChatThread, type SessionListItem } from '@fb/core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { buildChatContext, type ChatRouteDeps } from './chat.ts';
import type { ContextDeps } from './context.ts';

const session = (id: string, turnCount: number, snippet: string | null, lastActivityAt: string | null): SessionListItem => ({
  id, projectKey: 'demo', source: 'claude', cwd: null, gitBranch: null, startedAt: null, lastActivityAt, turnCount, state: 'idle',
  snippet, summarizedThrough: null, summaryUpdatedAt: null, summaryVersion: 1, pendingTurns: 0,
} as SessionListItem);
const link = { id: 'link:api|demo', a: 'api', b: 'demo', relation: 'same_product' as const, note: 'the app calls this api', status: 'confirmed' as const, source: 'you' as const, score: 0, evidence: [], createdAt: 't', updatedAt: 't', decidedBy: 'you' };
const fact = (id: string, statement: string, lines: string | null) => ({
  id, kind: 'api' as const, statement, path: 'src/routes.ts', lines, confidence: 0.9, why: 'w', source: 'x', createdAt: 't', scanJobId: null, fileHash: null, fileSummary: null, relevance: 1, relevanceBy: null, docId: null,
});

function deps(): ContextDeps {
  const root = mkdtempSync(join(tmpdir(), 'fb-chat-edges-'));
  mkdirSync(join(root, 'demo'));
  return {
    roots: [{ host: '/Users/me/Vibe', container: root }],
    embed: async (texts) => texts.map(() => [1, 0]),
    k: {
      searchLessons: async () => [],
      missesNaming: async () => [], relatedMisses: async (q) => (q.projectKey === 'api' ? [{ missId: 'ma', missed: 'broke the v1 response shape', cause: 'context_missing', feedbackText: 'you broke the app', sessionId: 'sa', ts: '2026-10-02T10:00:00Z', score: 0.86 }] : []),
      recordPreDoneCheck: async () => {},
      createManualFeedback: async () => 'manual:1',
    },
    judge: async () => [],
    facts: { searchFacts: async (q) => (q.projectKey === 'api' ? [{ fact: fact('fa', 'Responses are wrapped in { data, error }', '4-9'), score: 0.95 }, { fact: fact('fb', 'Errors carry a code', null), score: 0.9 }] : []) },
    docs: { searchDocs: async (q) => (q.projectKey === 'api' ? [{ docId: 'd', source: 'upload', ref: 'api.md', title: 'API guide', url: null, text: 'All routes need a bearer token.', score: 0.8 }] : []) },
    links: { listLinks: async () => [link] },
    sessions: {
      list: async () => ({ sessions: [session('s-new', 6, 'Added the orders page against the api', '2026-10-05T09:00:00Z'), session('s-undated', 3, null, null), session('s-probe', 1, 'hi', '2026-10-06T09:00:00Z')], next: null }),
      detail: async () => null,
    } as never,
    exists: () => true,
  };
}

test('an Ask pack cites recent sessions and what the confirmed linked project knows, each as its own source', async () => {
  const pack = await buildChatContext('demo', 'show orders from the api', [], { context: deps() });
  expect(pack.sources.map((s) => [s.kind, s.ref])).toEqual(expect.arrayContaining([['session', 's-new'], ['session', 's-undated'], ['linked', 'api']]));
  // A one-turn probe is not a session to learn from.
  expect(pack.sources.some((s) => s.ref === 's-probe')).toBe(false);
  expect(pack.context).toContain('## Recent sessions in this project');
  expect(pack.context).toMatch(/2026-10-05 · claude · idle: Added the orders page against the api/);
  // No date and no summary yet still reads as a line, not "undefined".
  expect(pack.context).toMatch(/^\[S\d+\] unknown date · claude · idle: $/m);
  const linked = pack.context.slice(pack.context.indexOf('## From linked projects'));
  expect(linked).toMatch(/api \(same_product\): the app calls this api/);
  expect(linked).toContain('  - past miss: broke the v1 response shape (cause: context_missing)');
  expect(linked).toContain('  - fact: `src/routes.ts:4-9` (api): Responses are wrapped in { data, error }');
  expect(linked).toContain('  - fact: `src/routes.ts` (api): Errors carry a code');
  expect(linked).toContain('  - document API guide (api.md):');
  expect(linked).toContain('All routes need a bearer token.');
});

// ── A question that loses the race for a conversation ───────────────────

const OWNER = 'owner-test-token-01234567890123456789';
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

test('a second question that reaches the store after another one started is refused as busy (409), not a 500', async () => {
  const thread: ChatThread = { id: 'chat-1', projectKey: 'demo', title: 'New chat', provider: null, createdAt: 't', updatedAt: 't', pending: false, turns: [] };
  // The route saw no pending answer, but another tab's question reached the store first.
  const store = { conversation: async () => thread, addUserTurn: async () => { throw new ChatBusyError(); } } as unknown as ChatRouteDeps['store'];
  const app = createApp(repo, {
    shown: () => shownProjects({ tracked: ['demo'], initialized: true }, { excludeProjects: [] }, new Map()),
    chat: { store, build: async () => ({ context: 'pack', sources: [] }) },
    auth: { ownerToken: OWNER },
  });
  const res = await app.request('/api/chats/chat-1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' }, body: JSON.stringify({ text: 'and another' }) });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/still being answered/);
});

function askApp(thread: ChatThread, addUserTurn: ChatRouteDeps['store']['addUserTurn'], renamed: unknown[] = []) {
  const store = { conversation: async () => thread, addUserTurn, updateConversation: async (...a: unknown[]) => { renamed.push(a); return null; } } as unknown as ChatRouteDeps['store'];
  return createApp(repo, {
    shown: () => shownProjects({ tracked: ['demo'], initialized: true }, { excludeProjects: [] }, new Map()),
    chat: { store, build: async () => ({ context: 'pack', sources: [] }) },
    auth: { ownerToken: OWNER },
  });
}
const ask = (text: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' }, body: JSON.stringify({ text }) });

test('a follow-up question keeps the chat\'s title: only a new chat is named after its first question', async () => {
  const done = { id: 'u1', role: 'user', status: 'done' } as never;
  const thread: ChatThread = { id: 'chat-1', projectKey: 'demo', title: 'Orders export', provider: null, createdAt: 't', updatedAt: 't', pending: false, turns: [done] };
  const renamed: unknown[] = [];
  const res = await askApp(thread, async () => ({ ...thread, pending: true }), renamed).request('/api/chats/chat-1/messages', ask('and the CSV header?'));
  expect(res.status).toBe(202);
  expect((await res.json()).title).toBe('Orders export');
  expect(renamed).toEqual([]);
});

test('a store failure while adding a question is a server error, not a busy chat', async () => {
  const thread: ChatThread = { id: 'chat-1', projectKey: 'demo', title: 'New chat', provider: null, createdAt: 't', updatedAt: 't', pending: false, turns: [] };
  const res = await askApp(thread, async () => { throw new Error('disk full'); }).request('/api/chats/chat-1/messages', ask('add a page'));
  expect(res.status).toBe(500);
});
