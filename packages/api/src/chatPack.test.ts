import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shownProjects, type ChatThread, type Lesson, type MapFile, type MapSymbol, type ModuleContext, type StoredCodeMap } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { buildChatContext, readSnippet, SNIPPET_BYTES, type ChatContextDeps, type ChatRouteDeps } from './chat.ts';
import type { ContextDeps } from './context.ts';

/** A project folder demo-shop under a temporary root, with these files (path -> content). */
function project(files: Record<string, string>): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'fb-chat-pack-'));
  const repo = join(root, 'demo-shop');
  mkdirSync(repo);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
  return { root, repo };
}

const lesson = (o: Partial<Lesson> = {}): Lesson => ({
  id: 'lesson:a', projectKey: 'demo-shop', title: 'Reuse the shared Modal', rule: 'Use the Modal', appliesWhen: '', scope: 'project', paths: [],
  status: 'approved', source: 'postmortem', cause: 'requirement_unstated', missId: null, createdAt: 't', decidedAt: 't', ...o,
});
const file = (path: string): MapFile => ({ path, lang: 'tsx', hash: 'h', loc: 10, isTest: path.includes('.test.') });
const sym = (path: string, name: string, lines: string, o: Partial<MapSymbol> = {}): MapSymbol => ({ id: `${path}#${name}`, path, name, kind: 'function', exported: true, lines, ...o });
const miss = { missId: 'miss:1', missed: 'built a second modal', cause: 'context_available_ignored' as const, causeExplanation: '', feedbackId: 'f1', feedbackText: 'we have one', sessionId: 's1', ts: '2026-10-01T10:00:00Z', fixedHere: false, paths: ['src/ui/Modal.tsx'] };

function deps(root: string, map: Partial<StoredCodeMap> | null, over: Partial<ContextDeps> = {}): ChatContextDeps {
  const context: ContextDeps = {
    roots: [{ host: '/Users/me/Vibe', container: root }],
    embed: async (texts) => texts.map(() => [1, 0]),
    k: { searchLessons: async () => [], relatedMisses: async () => [], missesNaming: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:1' },
    judge: async () => [],
    exists: () => true,
    ...over,
  };
  const full: StoredCodeMap | null = map && { fingerprint: null, builtAt: 't', stats: { files: 0, symbols: 0, imports: 0, tests: 0 }, candidates: null, files: [], outside: [], symbols: [], imports: [], ...map };
  return { context, codeMap: async () => full };
}

describe('readSnippet', () => {
  test('never reads a path that leaves the folder, a secret, a missing folder, a directory or a huge file', async () => {
    const { repo } = project({ 'src/a.ts': 'a', 'big.ts': 'x'.repeat(2_000_001) });
    mkdirSync(join(repo, 'dir'));
    expect(await readSnippet(repo, '../demo-shop/src/a.ts', null)).toBeNull();
    expect(await readSnippet(repo, '.env', null)).toBeNull();
    expect(await readSnippet(join(repo, 'gone'), 'src/a.ts', null)).toBeNull();
    expect(await readSnippet(repo, 'dir', null)).toBeNull();
    expect(await readSnippet(repo, 'big.ts', null)).toBeNull();
    expect(await readSnippet(repo, 'src/a.ts', null)).toEqual({ text: 'a', lines: '1-1' });
  });

  test('a one-line range reads that line, and a very long line is cut with an ellipsis', async () => {
    const { repo } = project({ 'src/a.ts': ['one', 'two', 'y'.repeat(400)].join('\n') });
    expect(await readSnippet(repo, 'src/a.ts', '2')).toEqual({ text: 'two', lines: '2-2' });
    expect(await readSnippet(repo, 'src/a.ts', '3')).toEqual({ text: `${'y'.repeat(300)}…`, lines: '3-3' });
  });
});

describe('buildChatContext', () => {
  test('a project outside every root: the pack says nothing was searched for it, and no source is read', async () => {
    const { root } = project({ 'src/ui/Modal.tsx': 'export const Modal = 1;' });
    const pack = await buildChatContext('elsewhere', 'Modal', [], deps(root, { files: [file('src/ui/Modal.tsx')], symbols: [sym('src/ui/Modal.tsx', 'Modal', '1-1')] }, { exists: existsSync }));
    expect(pack.context).toContain('Note: this project is not selected in Feedback Graph (or its folder is not mounted)');
    expect(pack.context).toContain('## Code map matches');
    expect(pack.context).not.toContain('## Source snippets');
  });

  test('a search that fails with something other than an Error still says why', async () => {
    const { root } = project({});
    const pack = await buildChatContext('demo-shop', 'modal', [], deps(root, null, { embed: async () => { throw 'ollama is down'; } }));
    expect(pack.context).toContain('could not be searched (ollama is down)');
  });

  test('lessons, misses, code matches, facts, docs and linked projects: every optional detail reads as a line', async () => {
    const { root } = project({ 'src/ui/Modal.tsx': 'export const Modal = 1;' });
    const paths = Array.from({ length: 8 }, (_, i) => `src/ui/p${i}.ts`);
    const tied = lesson({ id: 'lesson:tied', appliesWhen: '' });
    const many = lesson({ id: 'lesson:many', title: 'Many paths', appliesWhen: 'always', paths: ['src/ui/Modal.tsx', ...paths] });
    const moduleContext = async (): Promise<ModuleContext> => ({ path: 'src/ui/Modal.tsx', importers: [], tests: [], misses: [miss], lessons: [] } as unknown as ModuleContext);
    const d = deps(root, {
      files: [file('src/ui/Modal.tsx'), file('src/ui/Modal.test.tsx')],
      symbols: [sym('src/ui/Modal.tsx', 'Modal', '1-1', { kind: undefined as never, exported: false })],
      imports: [...Array.from({ length: 14 }, (_, i) => ({ from: `src/u${i}.ts`, to: 'src/ui/Modal.tsx', names: ['Modal'] })), { from: 'src/ui/Modal.test.tsx', to: 'src/ui/Modal.tsx', names: ['Modal'] }] as never,
    }, {
      k: {
        searchLessons: async () => [{ lesson: many, score: 0.9 }],
        missesNaming: async () => [],
        relatedMisses: async (q) => q.projectKey === 'demo-shop'
          ? [
              { missId: 'miss:other', missed: 'broke src/api/other.ts', cause: 'context_missing', feedbackText: 'see src/api/other.ts', sessionId: 's2', ts: '2026-10-02T10:00:00Z', score: 0.95 },
              { missId: 'miss:near', missed: 'broke src/ui/Dialog.tsx', cause: 'context_missing', feedbackText: 'see src/ui/Dialog.tsx', sessionId: 's5', ts: '2026-10-02T10:00:00Z', score: 0.95 },
              { missId: 'miss:here', missed: 'broke the modal', cause: 'context_missing', feedbackText: 'in src/ui/Modal.tsx', sessionId: 's3', ts: '2026-10-03T10:00:00Z', score: 0.95 },
            ]
          : q.projectKey === 'web' ? [] : [{ missId: 'miss:api', missed: 'broke the api', cause: 'context_missing', feedbackText: 'x', sessionId: 's4', ts: '2026-10-04T10:00:00Z', score: 0.95 }],
        recordPreDoneCheck: async () => {},
        createManualFeedback: async () => 'manual:1',
      },
      codegraph: { lessonsForPaths: async () => [{ lesson: tied, paths: ['src/ui/Modal.tsx'] }], moduleContext } as never,
      docs: { searchDocs: async (q) => (q.projectKey === 'api' ? [] : [{ docId: 'd', source: 'upload', ref: `${q.projectKey}.md`, title: 'Modal guide', url: null, text: `modal does ${'z'.repeat(700)}`, score: 0.95 }]) },
      links: { listLinks: async () => ['api', 'web'].map((a) => ({ id: `link:${a}|demo-shop`, a, b: 'demo-shop', relation: 'related' as const, note: '', status: 'confirmed' as const, source: 'you' as const, score: 0, evidence: [], createdAt: 't', updatedAt: 't', decidedBy: 'you' })) },
      inScope: () => true,
    });
    const pack = await buildChatContext('demo-shop', 'how does the modal in Modal.tsx work?', [], d);
    // A lesson tied by its miss has no paths; one with many lists the first six.
    expect(pack.context).toMatch(/\*\*Reuse the shared Modal\*\*: Use the Modal\n {2}- applies when: n\/a · scope: project\n/);
    expect(pack.context).toContain('and 3 more');
    // A miss about another file than the one named is left out, even one in the same folder.
    expect(pack.context).toContain('broke the modal');
    expect(pack.context).not.toContain('broke src/api/other.ts');
    expect(pack.context).not.toContain('broke src/ui/Dialog.tsx');
    expect(pack.context).toMatch(/\[S\d+\] built a second modal \(cause: context_available_ignored\) · in `src\/ui\/Modal\.tsx`/);
    // An unexported symbol of no known kind; more importers than are listed.
    expect(pack.context).toMatch(/`src\/ui\/Modal\.tsx:1-1` symbol Modal · used by: .*`src\/u7\.ts` \(14 files import it\) · tests: `src\/ui\/Modal\.test\.tsx`/);
    expect(pack.context).toMatch(/modal does z{589}…\n--- end of untrusted document ---/);
    // A link with no note shows only the relation.
    expect(pack.context).toMatch(/\] api \(related\)\n {2}- past miss: broke the api/);
    // A linked project with only a document still has its section.
    expect(pack.context).toMatch(/\] web \(related\)\n {2}- document Modal guide \(web\.md\):/);
  });
});

test('a snippet that fills the whole budget leaves no room: later matches are cited without a snippet', async () => {
  // 64 lines, 16,384 characters with their line breaks: SNIPPET_BYTES exactly.
  const text = [...Array.from({ length: 63 }, () => 'a'.repeat(255)), 'a'.repeat(256)].join('\n');
  expect(text.length).toBe(SNIPPET_BYTES);
  const { root } = project({ 'src/big.ts': text, 'src/small.ts': 'export const Small = 1;' });
  const pack = await buildChatContext('demo-shop', 'Big and Small', [], deps(root, {
    files: [file('src/big.ts'), file('src/small.ts')],
    symbols: [sym('src/big.ts', 'Big', '1-64'), sym('src/small.ts', 'Small', '1-1')],
  }));
  const snippets = pack.context.slice(pack.context.indexOf('## Source snippets'));
  expect(snippets).toContain('src/big.ts:1-64');
  expect(snippets).not.toContain('src/small.ts');
  expect(pack.context).toMatch(/`src\/small\.ts:1-1` function Small/);
});

// ── Routes ─────────────────────────────────────────────────────────────

const OWNER = 'owner-test-token-01234567890123456789';
const OP = 'o'.repeat(32);
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const thread: ChatThread = { id: 'chat-1', projectKey: 'demo', title: 'x', provider: null, createdAt: 't', updatedAt: 't', pending: false, turns: [] };
const failed = { id: 'turn-2', conversationId: 'chat-1', seq: 2, role: 'assistant' as const, text: '', status: 'failed' as const, error: 'down', answer: null, provider: null, sources: [], createdAt: 't', startedAt: null, finishedAt: null };

function routes(store: Partial<ChatRouteDeps['store']>, view: 'shown' | 'all' = 'shown') {
  return createApp(repo, {
    ...(view === 'shown' && { shown: () => shownProjects({ tracked: ['demo'], initialized: true }, { excludeProjects: [] }, new Map()) }),
    chat: { store: { conversation: async () => thread, ...store } as ChatRouteDeps['store'], build: async () => ({ context: '', sources: [] }) },
    auth: { ownerToken: OWNER, operator: { token: OP, allow: ['chat', 'chat_delete'] as never } },
  });
}
const owner = { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' };
const inRun = { 'content-type': 'application/json', authorization: `Bearer ${OP}`, 'x-fg-run': 'run-a' };
const req = (method: string, headers: Record<string, string>, body?: unknown) => ({ method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('chat routes', () => {
  test('a bad list query is refused; without a project selection the asked project is listed as is', async () => {
    const asked: unknown[] = [];
    const app = routes({ listConversations: async (q) => { asked.push(q.projectKeys); return []; } }, 'all');
    expect((await app.request('/api/chats?project=')).status).toBe(400);
    expect((await app.request('/api/chats?project=demo')).status).toBe(200);
    expect((await app.request('/api/chats')).status).toBe(200);
    expect(asked).toEqual([['demo'], undefined]);
  });

  test('a conversation of a shown project is returned with its turns', async () => {
    const res = await routes({ conversation: async () => ({ ...thread, turns: [failed] }) }).request('/api/chats/chat-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...thread, turns: [failed] });
  });

  test('a run creates a conversation as its own, and cannot ask, retry, rename or delete in one it did not start (409)', async () => {
    const made: unknown[] = [];
    const app = routes({
      createConversation: async (i) => { made.push(i); return { id: 'chat-2', projectKey: i.projectKey, title: i.title, provider: i.provider, createdAt: 't', updatedAt: 't', pending: false }; },
      conversation: async () => ({ ...thread, turns: [failed] }),
    });
    expect((await app.request('/api/chats', req('POST', inRun, { project: 'demo' }))).status).toBe(201);
    expect(made).toEqual([{ projectKey: 'demo', title: 'New chat', provider: null, run: 'run-a' }]);
    for (const [method, path, body] of [['POST', '/api/chats/chat-1/messages', { text: 'hi' }], ['POST', '/api/chats/chat-1/turns/turn-2/retry', {}], ['PATCH', '/api/chats/chat-1', { title: 'y' }], ['DELETE', '/api/chats/chat-1', undefined]] as const) {
      const res = await app.request(path, req(method, inRun, body));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/run-a/);
    }
  });

  test('a conversation that disappears while it is being changed is not found (404)', async () => {
    const gone = routes({ conversation: async () => null });
    expect((await gone.request('/api/chats/chat-1/turns/turn-2/retry', req('POST', owner, {}))).status).toBe(404);
    expect((await gone.request('/api/chats/chat-1', req('PATCH', owner, { title: 'y' }))).status).toBe(404);
    const racing = routes({
      conversation: async () => ({ ...thread, turns: [failed] }),
      addUserTurn: async () => null,
      retryTurn: async () => null,
      updateConversation: async () => null,
    });
    expect((await racing.request('/api/chats/chat-1/messages', req('POST', owner, { text: 'hi' }))).status).toBe(404);
    const retried = await racing.request('/api/chats/chat-1/turns/turn-2/retry', req('POST', owner, {}));
    expect(retried.status).toBe(404);
    expect((await retried.json()).error).toMatch(/only a failed answer/);
    expect((await racing.request('/api/chats/chat-1', req('PATCH', owner, { title: 'y' }))).status).toBe(404);
  });
});
