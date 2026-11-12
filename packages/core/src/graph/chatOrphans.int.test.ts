import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';

describeStores('ChatStore after its project is deleted', (h) => {
  let s: Store;
  beforeAll(() => {
    s = h.store;
  });

  test('a question waiting for its answer goes with its project: the queue does not keep it, and the next one is served', async () => {
    await s.graph.canonicalProject({ key: 'gone', name: 'gone', repoPath: '/vibe/gone' });
    const doomed = await s.chats.createConversation({ projectKey: 'gone', title: 'q', provider: 'local' });
    await s.chats.addUserTurn(doomed.id, 'how many modals?', { context: 'pack', sources: [] });
    await s.portability.deleteProject('gone');
    expect(await s.chats.conversation(doomed.id)).toBeNull();
    expect(await s.chats.pendingTurns()).toEqual([]);
    expect(await s.chats.chatQueue()).toMatchObject({ waiting: 0 });
    expect(await s.chats.nextPendingTurn()).toBeNull();

    const kept = await s.chats.createConversation({ projectKey: 'demo', title: 'q', provider: 'local' });
    await s.chats.addUserTurn(kept.id, 'and here?', { context: 'other pack', sources: [] });
    expect(await s.chats.nextPendingTurn()).toMatchObject({ conversation: { id: kept.id }, question: { text: 'and here?' }, context: 'other pack' });
  });
});
