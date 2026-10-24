import { beforeAll, describe, expect, test } from 'vitest';
import type { ExternalThread, Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { Classification, ExternalRef, ParsedSession, Project } from '../types.ts';

const project: Project = { key: 'shop', name: 'shop', repoPath: '/vibe/shop' };
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 'missing null check', signals: [] };

const ref = (n: number, o: Partial<ExternalRef> = {}): ExternalRef => ({
  source: 'github',
  kind: 'review_comment',
  author: 'reviewer',
  url: `https://github.com/acme/shop/pull/7#discussion_r${n}`,
  thread: 'acme/shop#7',
  title: 'Add checkout',
  threadUrl: 'https://github.com/acme/shop/pull/7',
  path: 'src/cart.ts',
  line: 12,
  diffHunk: '@@ -1 +1 @@\n-a\n+b',
  branch: 'feat/checkout',
  createdAt: `2026-10-02T10:0${n}:00Z`,
  linkedSessionIds: [],
  ...o,
});

const thread = (n: number): ExternalThread => ({
  id: 'github:acme/shop#7',
  source: 'github',
  items: Array.from({ length: n }, (_, i) => ({
    uuid: `github:acme/shop#7/c${i + 1}`,
    ts: `2026-10-02T10:0${i + 1}:00Z`,
    index: i + 1,
    text: i === 0 ? 'This drops the null check; token ghp_' + 'a'.repeat(36) + ' leaked' : `comment ${i + 1}`,
    context: 'PR acme/shop#7: Add checkout',
    external: ref(i + 1),
  })),
});

function work(id: string, branch: string | null, startedAt: string, endedAt: string): ParsedSession {
  return {
    sessionId: id,
    sourceFile: `/t/${id}.jsonl`,
    cwd: '/Users/j/shop',
    gitBranch: branch,
    startedAt,
    endedAt,
    turns: [{ uuid: `${id}-t1`, sessionId: id, ts: startedAt, index: 0, text: 'build checkout', precedingAssistantText: '', precedingToolCalls: [] }],
    toolCalls: [],
  };
}

describeStores('external feedback threads', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  test('comments become classifiable turns; pushback becomes a github Inbox item with the comment details', async () => {
    expect(await store.graph.upsertExternalThread(project, thread(2))).toBe(2);
    const turns = await store.graph.unclassifiedTurns(10, ['shop']);
    expect(turns.map((t) => t.uuid).sort()).toEqual(['github:acme/shop#7/c1', 'github:acme/shop#7/c2']);
    const first = turns.find((t) => t.index === 1)!;
    expect(first.text).not.toContain('ghp_');
    expect(first.precedingAssistantText).toBe('PR acme/shop#7: Add checkout');
    expect(first.external).toMatchObject({ author: 'reviewer', path: 'src/cart.ts', line: 12 });

    expect(await store.graph.saveClassification('github:acme/shop#7/c1', pushback, true)).toBe('github:acme/shop#7/c1');
    const [c] = await store.graph.listCandidates({ status: 'pending' });
    expect(c).toMatchObject({ source: 'github', projectKey: 'shop', external: { thread: 'acme/shop#7', url: ref(1).url } });
    const d = await store.graph.candidateDetail(c.id);
    expect(d?.turn.external?.author).toBe('reviewer');
    expect(d?.after.map((t) => t.index)).toEqual([2]);
  });

  test('syncing the thread again adds only new comments and keeps classifications', async () => {
    await store.graph.upsertExternalThread(project, thread(1));
    await store.graph.saveClassification('github:acme/shop#7/c1', pushback, true);
    expect(await store.graph.upsertExternalThread(project, thread(3))).toBe(2);
    const left = await store.graph.unclassifiedTurns(10, ['shop']);
    expect(left.map((t) => t.index).sort()).toEqual([2, 3]);
    expect(await store.graph.listCandidates({})).toHaveLength(1);
  });

  test('stand-in threads are not sessions: not listed, not counted in stats', async () => {
    await store.graph.upsertExternalThread(project, thread(2));
    const { sessions } = await store.sessions.list({ projectKeys: ['shop'], limit: 10 });
    expect(sessions).toEqual([]);
    expect(await store.graph.stats()).toEqual([]);
  });

  test('confirmed comment feedback reaches the post-mortem queue with its details', async () => {
    await store.graph.upsertExternalThread(project, thread(1));
    await store.graph.saveClassification('github:acme/shop#7/c1', pushback, true);
    await store.graph.decide('github:acme/shop#7/c1', 'confirmed', null);
    const [input] = await store.knowledge.feedbackNeedingPostmortem(5);
    expect(input.feedback.external?.diffHunk).toContain('+b');
    expect(input.source).toBe('github');
  });

  test('an agent report never merges into a synced comment', async () => {
    const now = new Date().toISOString();
    await store.graph.upsertExternalThread(project, {
      ...thread(1),
      items: [{ ...thread(1).items[0], ts: now, text: 'the null check is missing in cart' }],
    });
    await store.graph.saveClassification('github:acme/shop#7/c1', pushback, true);
    const id = await store.knowledge.createManualFeedback({ project, cwd: '/Users/j/shop', text: 'the null check is missing in cart', whatWasDone: 'x' });
    expect(id).toMatch(/^manual:/);
  });

  describe('workSessions', () => {
    test('finds sessions on the branch that started before the comment, newest first', async () => {
      await store.graph.upsertSession(project, work('a', 'feat/checkout', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'), []);
      await store.graph.upsertSession(project, work('b', 'feat/checkout', '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'), []);
      await store.graph.upsertSession(project, work('c', 'main', '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'), []);
      await store.graph.upsertSession(project, work('late', 'feat/checkout', '2026-10-03T11:00:00Z', '2026-10-03T12:00:00Z'), []);
      await store.graph.upsertExternalThread(project, thread(1));
      const found = await store.graph.workSessions({ projectKey: 'shop', branch: 'feat/checkout', before: '2026-10-02T10:01:00Z', limit: 5 });
      expect(found.map((s) => s.id)).toEqual(['b', 'a']);
      expect(found[0]).toMatchObject({ source: 'claude', gitBranch: 'feat/checkout', cwd: '/Users/j/shop' });
    });

    test('without a branch, finds sessions active in the time window', async () => {
      await store.graph.upsertSession(project, work('old', null, '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'), []);
      await store.graph.upsertSession(project, work('recent', null, '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'), []);
      const found = await store.graph.workSessions({ projectKey: 'shop', branch: null, after: '2026-09-30T00:00:00Z', before: '2026-10-02T00:00:00Z', limit: 5 });
      expect(found.map((s) => s.id)).toEqual(['recent']);
      expect(await store.graph.workSessions({ projectKey: 'shop', branch: null, before: '2026-10-02T00:00:00Z', limit: 5 })).toEqual([]);
    });
  });
});
