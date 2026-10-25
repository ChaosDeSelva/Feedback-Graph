import { beforeAll, describe, expect, test } from 'vitest';
import type { ExternalThread, Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { Classification, ExternalRef, ParsedSession, Project, ToolCall } from '../types.ts';

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

/** An agent session; by default it edited one file as it started. `calls` replaces its tool calls. */
function work(id: string, branch: string | null, startedAt: string, endedAt: string, calls?: ToolCall[]): ParsedSession {
  return {
    sessionId: id,
    sourceFile: `/t/${id}.jsonl`,
    cwd: '/Users/j/shop',
    gitBranch: branch,
    startedAt,
    endedAt,
    turns: [{ uuid: `${id}-t1`, sessionId: id, ts: startedAt, index: 0, text: 'build checkout', precedingAssistantText: '', precedingToolCalls: [] }],
    toolCalls: calls ?? [edit(startedAt)],
  };
}

const edit = (ts: string, name = 'Edit'): ToolCall => ({ name, ts, filePath: '/Users/j/shop/src/cart.ts' });
const read = (ts: string): ToolCall => ({ name: 'Read', ts, filePath: '/Users/j/shop/src/cart.ts' });
const bash = (ts: string, command: string): ToolCall => ({ name: 'Bash', ts, command });

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

  test('a comment keeps its ticket: description (redacted) and details reach the Inbox item', async () => {
    const ticket = { state: 'In Review', priority: 'High', labels: ['billing'], assignee: 'jo' };
    const t = thread(1);
    t.items[0].external = { ...ref(1), source: 'linear', kind: 'linear_comment', description: `Keep cents. ghp_${'c'.repeat(36)}`, ticket };
    await store.graph.upsertExternalThread(project, t);
    await store.graph.saveClassification('github:acme/shop#7/c1', pushback, true);
    const d = await store.graph.candidateDetail('github:acme/shop#7/c1');
    expect(d?.turn.external).toMatchObject({ ticket });
    expect(d?.turn.external?.description).toMatch(/^Keep cents\./);
    expect(d?.turn.external?.description).not.toContain('ghp_');
  });

  test('syncing the thread again adds only new comments and keeps classifications', async () => {
    await store.graph.upsertExternalThread(project, thread(1));
    await store.graph.saveClassification('github:acme/shop#7/c1', pushback, true);
    expect(await store.graph.upsertExternalThread(project, thread(3))).toBe(2);
    const left = await store.graph.unclassifiedTurns(10, ['shop']);
    expect(left.map((t) => t.index).sort()).toEqual([2, 3]);
    expect(await store.graph.listCandidates({})).toHaveLength(1);
  });

  test('pending synced items come back with their words, by id; a skip rejects one that is still pending and marks its turn', async () => {
    await store.graph.upsertExternalThread(project, thread(3));
    for (const n of [1, 2, 3]) await store.graph.saveClassification(`github:acme/shop#7/c${n}`, pushback, true);
    await store.graph.decide('github:acme/shop#7/c3', 'confirmed', null);
    // A transcript turn's Inbox item is not a synced comment: never listed here.
    await store.graph.upsertSession(project, work('s1', 'feat/checkout', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'), []);
    await store.graph.saveClassification('s1-t1', pushback, true);

    const first = await store.graph.pendingExternalItems({ limit: 1 });
    expect(first).toEqual([{ id: 'github:acme/shop#7/c1', turnUuid: 'github:acme/shop#7/c1', projectKey: 'shop', text: expect.not.stringContaining('ghp_'), external: expect.objectContaining({ author: 'reviewer', thread: 'acme/shop#7' }) }]);
    const next = await store.graph.pendingExternalItems({ limit: 10, afterId: first[0].id });
    expect(next.map((i) => i.id)).toEqual(['github:acme/shop#7/c2']);

    expect(await store.graph.skipPendingItem('github:acme/shop#7/c2', { rule: 'status-note', note: 'skipped by the status-note rule', by: 'skip-rules' })).toBe(true);
    const [c] = await store.graph.listCandidates({ status: 'rejected' });
    expect(c).toMatchObject({ id: 'github:acme/shop#7/c2', note: 'skipped by the status-note rule', decidedBy: 'skip-rules' });
    expect(c.classification.signals).toContain('skip:status-note');
    expect(c.decidedAt).not.toBeNull();
    // Decided already (by you, or by an earlier skip): left as it is.
    expect(await store.graph.skipPendingItem('github:acme/shop#7/c3', { rule: 'status-note', note: 'x', by: 'skip-rules' })).toBe(false);
    expect(await store.graph.skipPendingItem('github:acme/shop#7/c2', { rule: 'status-note', note: 'x', by: 'skip-rules' })).toBe(false);
    expect(await store.graph.skipPendingItem('nope', { rule: 'status-note', note: 'x', by: 'skip-rules' })).toBe(false);
    expect((await store.graph.listCandidates({ status: 'confirmed' })).map((k) => k.id)).toEqual(['github:acme/shop#7/c3']);
    expect((await store.graph.pendingExternalItems({ limit: 10 })).map((i) => i.id)).toEqual(['github:acme/shop#7/c1']);
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

  test("a lesson from a review comment says whose words its feedback is: the source, the reviewer and the review's verdict", async () => {
    const t = thread(1);
    t.items[0].external = { ...ref(1), reviewState: 'APPROVED' };
    await store.graph.upsertExternalThread(project, t);
    await store.graph.saveClassification('github:acme/shop#7/c1', pushback, true);
    await store.graph.decide('github:acme/shop#7/c1', 'confirmed', null);
    const unit = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    await store.knowledge.savePostmortem('github:acme/shop#7/c1', {
      taskTitle: 'Checkout', missed: 'dropped the null check', cause: 'implementation_error', causeExplanation: 'x', outcome: 'addressed',
      lesson: { title: 'Keep null checks', rule: 'Keep the null check in cart', appliesWhen: 'cart work', scope: 'project', paths: ['src/cart.ts'] },
      contextItems: [],
    }, { miss: unit, lesson: unit });
    const [lesson] = await store.knowledge.listLessons({ status: 'proposed' });
    const d = await store.knowledge.lessonDetail(lesson.id);
    expect(d?.feedback?.external).toEqual({ source: 'github', author: 'reviewer', url: ref(1).url, reviewState: 'APPROVED' });
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
      expect(found[0]).toMatchObject({ source: 'claude', gitBranch: 'feat/checkout', cwd: '/Users/j/shop', edits: 1, commits: 0 });
    });

    test('a session that only read on the branch (a review, a question) is never the work session', async () => {
      const at = '2026-10-01T11:00:00Z';
      const review = [read(at), bash(at, 'git diff main...HEAD'), bash(at, 'git log --grep commit')];
      await store.graph.upsertSession(project, work('review', 'feat/checkout', at, '2026-10-01T12:00:00Z', review), []);
      const q = { projectKey: 'shop', branch: 'feat/checkout', before: '2026-10-02T10:01:00Z', limit: 5 };
      expect(await store.graph.workSessions(q)).toEqual([]);
      await store.graph.upsertSession(project, work('coder', 'feat/checkout', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'), []);
      expect((await store.graph.workSessions(q)).map((s) => s.id)).toEqual(['coder']);
      // Read in the window, nothing else: not a candidate without a branch either.
      expect((await store.graph.workSessions({ ...q, branch: null, after: '2026-09-30T00:00:00Z' })).map((s) => s.id)).toEqual(['coder']);
    });

    test('a git commit counts as work; the session with the most edits comes first, then the most recent', async () => {
      const t = (h: number) => `2026-10-01T${String(h).padStart(2, '0')}:00:00Z`;
      await store.graph.upsertSession(project, work('many', 'feat/checkout', t(8), t(9), [edit(t(8)), edit(t(8), 'Write'), edit(t(8), 'MultiEdit')]), []);
      await store.graph.upsertSession(project, work('few', 'feat/checkout', t(10), t(11), [edit(t(10))]), []);
      await store.graph.upsertSession(project, work('committer', 'feat/checkout', t(12), t(13), [bash(t(12), 'git add -A && git commit -m wip')]), []);
      const found = await store.graph.workSessions({ projectKey: 'shop', branch: 'feat/checkout', before: '2026-10-02T10:01:00Z', limit: 5 });
      expect(found.map((s) => s.id)).toEqual(['many', 'few', 'committer']);
      expect(found[2]).toMatchObject({ edits: 0, commits: 1 });
    });

    test('work done only after the comment does not count', async () => {
      await store.graph.upsertSession(project, work('later', 'feat/checkout', '2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z', [read('2026-10-02T09:00:00Z'), edit('2026-10-02T11:00:00Z')]), []);
      expect(await store.graph.workSessions({ projectKey: 'shop', branch: 'feat/checkout', before: '2026-10-02T10:01:00Z', limit: 5 })).toEqual([]);
      expect(await store.graph.workSessions({ projectKey: 'shop', branch: 'feat/checkout', before: '2026-10-02T11:30:00Z', limit: 5 })).toHaveLength(1);
    });

    test('re-ingesting a session updates its work', async () => {
      const at = '2026-10-01T09:00:00Z';
      await store.graph.upsertSession(project, work('s', 'feat/checkout', at, at, [read(at)]), []);
      const q = { projectKey: 'shop', branch: 'feat/checkout', before: '2026-10-02T10:01:00Z', limit: 5 };
      expect(await store.graph.workSessions(q)).toEqual([]);
      await store.graph.upsertSession(project, work('s', 'feat/checkout', at, '2026-10-01T10:00:00Z', [read(at), edit('2026-10-01T10:00:00Z')]), []);
      expect(await store.graph.workSessions(q)).toMatchObject([{ id: 's', edits: 1 }]);
    });

    test('without a branch, finds sessions that did work in the time window', async () => {
      await store.graph.upsertSession(project, work('old', null, '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'), []);
      await store.graph.upsertSession(project, work('recent', null, '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'), []);
      await store.graph.upsertSession(project, work('reader', null, '2026-10-01T09:00:00Z', '2026-10-01T11:00:00Z', [read('2026-10-01T09:00:00Z')]), []);
      // Started long before, but its edits were in the window.
      await store.graph.upsertSession(project, work('long', null, '2026-09-01T09:00:00Z', '2026-10-01T08:00:00Z', [read('2026-09-01T09:00:00Z'), edit('2026-10-01T08:00:00Z')]), []);
      const found = await store.graph.workSessions({ projectKey: 'shop', branch: null, after: '2026-09-30T00:00:00Z', before: '2026-10-02T00:00:00Z', limit: 5 });
      expect(found.map((s) => s.id)).toEqual(['recent', 'long']);
      expect(await store.graph.workSessions({ projectKey: 'shop', branch: null, before: '2026-10-02T00:00:00Z', limit: 5 })).toEqual([]);
    });
  });
});
