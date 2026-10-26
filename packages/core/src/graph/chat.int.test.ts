import { beforeAll, expect, test } from 'vitest';
import { ChatBusyError, MAX_CHAT_CONTEXT, type ChatAnswer, type ChatSource } from '../chat.ts';
import type { ChatStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';

const src = (id: string, ref = 'src/ui/Modal.tsx:10-42'): ChatSource => ({ id, kind: 'code', ref, title: 'Modal' });
const answer = (text = 'There are 4 modals [S1].'): ChatAnswer => ({
  answer: text,
  examples: [{ path: 'src/ui/Modal.tsx', lines: '10-42', why: 'the shared modal', usages: ['src/App.tsx'] }],
  prompt: 'Goal: add a modal.',
});
const tick = () => new Promise((r) => setTimeout(r, 5));

describeStores('ChatStore', (h) => {
  let c: ChatStore;
  beforeAll(() => {
    c = h.store.chats;
  });

  test('a conversation is created, listed newest activity first, and renamed or switched to another provider', async () => {
    const a = await c.createConversation({ projectKey: 'demo-shop', title: 'add a modal', provider: 'claude' });
    expect(a).toMatchObject({ projectKey: 'demo-shop', title: 'add a modal', provider: 'claude', pending: false });
    expect(a.createdAt).toBe(a.updatedAt);
    await tick();
    const b = await c.createConversation({ projectKey: 'acme', title: 'add feature foobar', provider: null });
    expect((await c.listConversations({})).map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await c.listConversations({ projectKeys: ['demo-shop'] })).map((x) => x.id)).toEqual([a.id]);
    expect(await c.listConversations({ projectKeys: [] })).toEqual([]);
    await tick();
    const renamed = await c.updateConversation(a.id, { title: 'modals', provider: null });
    expect(renamed).toMatchObject({ id: a.id, title: 'modals', provider: null });
    expect(renamed!.updatedAt > a.updatedAt).toBe(true);
    // Only what the patch names changes.
    expect(await c.updateConversation(a.id, { provider: 'codex' })).toMatchObject({ title: 'modals', provider: 'codex' });
    expect((await c.listConversations({})).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(await c.updateConversation('chat-missing', { title: 'x' })).toBeNull();
    expect(await c.conversation('chat-missing')).toBeNull();
  });

  test('a question adds the user turn with its pack and a pending assistant turn, and blocks a second question until answered', async () => {
    const conv = await c.createConversation({ projectKey: 'demo-shop', title: 'q', provider: 'local' });
    const thread = await c.addUserTurn(conv.id, 'how many modals?', { context: '# pack\n[S1] src/ui/Modal.tsx', sources: [src('S1')] });
    expect(thread!.pending).toBe(true);
    const [user, asst] = thread!.turns;
    expect(user).toMatchObject({ conversationId: conv.id, seq: 1, role: 'user', text: 'how many modals?', status: 'done', sources: [], answer: null });
    expect(asst).toMatchObject({ conversationId: conv.id, seq: 2, role: 'assistant', text: '', status: 'pending', error: null, answer: null, sources: [src('S1')], provider: null, startedAt: null, finishedAt: null });
    // The answer says how big its pack is (the UI shows it); the question itself has none.
    expect(asst.pack).toEqual({ chars: '# pack\n[S1] src/ui/Modal.tsx'.length, sources: 1 });
    expect(user.pack).toBeNull();
    await expect(c.addUserTurn(conv.id, 'again', { context: '', sources: [] })).rejects.toBeInstanceOf(ChatBusyError);
    expect((await c.listConversations({}))[0].pending).toBe(true);
    expect(await c.addUserTurn('chat-missing', 'x', { context: '', sources: [] })).toBeNull();
  });

  test('the worker picks the oldest pending turn with its question and pack, claims it once, and saves the answer', async () => {
    const one = await c.createConversation({ projectKey: 'demo-shop', title: 'one', provider: null });
    await c.addUserTurn(one.id, 'first?', { context: 'pack one', sources: [src('S1')] });
    await tick();
    const two = await c.createConversation({ projectKey: 'demo-shop', title: 'two', provider: null });
    await c.addUserTurn(two.id, 'second?', { context: 'pack two', sources: [] });
    const job = await c.nextPendingTurn();
    expect(job!.conversation.id).toBe(one.id);
    expect(job!.question).toMatchObject({ role: 'user', text: 'first?' });
    expect(job!.turn).toMatchObject({ role: 'assistant', status: 'pending' });
    expect(job!.context).toBe('pack one');
    expect(await c.markAnswering(job!.turn.id, 'claude-cli')).toBe(true);
    expect(await c.markAnswering(job!.turn.id, 'claude-cli')).toBe(false);
    // Answering is not pending: the next job is the other conversation's.
    expect((await c.nextPendingTurn())!.conversation.id).toBe(two.id);
    const answering = (await c.conversation(one.id))!.turns[1];
    expect(answering).toMatchObject({ status: 'answering', provider: 'claude-cli' });
    expect(answering.startedAt).not.toBeNull();
    expect(await c.saveAnswer(job!.turn.id, answer())).toBe(true);
    const done = (await c.conversation(one.id))!;
    expect(done.pending).toBe(false);
    expect(done.turns[1]).toMatchObject({ status: 'done', answer: answer(), text: answer().answer, provider: 'claude-cli' });
    expect(done.turns[1].finishedAt).not.toBeNull();
    // Saved once: a second save (a requeued duplicate) is refused.
    expect(await c.saveAnswer(job!.turn.id, answer('other'))).toBe(false);
    // The next question gets the next numbers.
    const next = await c.addUserTurn(one.id, 'follow up', { context: 'pack three', sources: [] });
    expect(next!.turns.map((t) => [t.seq, t.role])).toEqual([[1, 'user'], [2, 'assistant'], [3, 'user'], [4, 'assistant']]);
  });

  test('the question queue: how many wait, since when the oldest has, and which are being answered since when', async () => {
    expect(await c.chatQueue()).toEqual({ waiting: 0, oldestAt: null, running: [] });
    const a = await c.createConversation({ projectKey: 'demo-shop', title: 'modals', provider: null });
    const b = await c.createConversation({ projectKey: 'acme', title: 'routes', provider: null });
    const first = (await c.addUserTurn(a.id, 'how many modals?', { context: 'ctx', sources: [] }))!.turns.at(-1)!;
    await tick();
    await c.addUserTurn(b.id, 'where are routes?', { context: 'ctx', sources: [] });
    expect(await c.chatQueue()).toEqual({ waiting: 2, oldestAt: first.createdAt, running: [] });
    expect(await c.markAnswering(first.id, 'claude-cli')).toBe(true);
    const q = await c.chatQueue();
    expect(q.waiting).toBe(1);
    expect(q.oldestAt).not.toBe(first.createdAt);
    expect(q.running).toEqual([{ id: first.id, projectKey: 'demo-shop', startedAt: expect.any(String) }]);
  });

  test('a failed turn keeps its reason, can be retried with the same pack, and stale answering turns go back to pending', async () => {
    const conv = await c.createConversation({ projectKey: 'demo-shop', title: 'f', provider: 'codex' });
    const t = await c.addUserTurn(conv.id, 'why?', { context: 'the pack', sources: [src('S1')] });
    const turnId = t!.turns[1].id;
    expect(await c.failTurn(turnId, 'model unavailable: codex is not signed in')).toBe(true);
    const failed = (await c.conversation(conv.id))!;
    expect(failed.pending).toBe(false);
    expect(failed.turns[1]).toMatchObject({ status: 'failed', error: 'model unavailable: codex is not signed in' });
    expect(await c.nextPendingTurn()).toBeNull();
    // Only a failed assistant turn can be retried.
    expect(await c.retryTurn(conv.id, failed.turns[0].id)).toBeNull();
    expect(await c.retryTurn('chat-missing', turnId)).toBeNull();
    const retried = await c.retryTurn(conv.id, turnId);
    expect(retried!.turns[1]).toMatchObject({ status: 'pending', error: null, answer: null, finishedAt: null });
    expect(await c.retryTurn(conv.id, turnId)).toBeNull();
    const job = await c.nextPendingTurn();
    expect(job!.context).toBe('the pack');
    await c.markAnswering(turnId, 'codex-cli');
    expect(await c.requeueStaleTurns()).toBe(1);
    expect((await c.conversation(conv.id))!.turns[1]).toMatchObject({ status: 'pending', startedAt: null });
  });

  test('text, packs, answers and errors are redacted, and a long pack is capped', async () => {
    const key = `ghp_${'E'.repeat(36)}`;
    const conv = await c.createConversation({ projectKey: 'demo-shop', title: `token ${key}`, provider: null });
    expect(conv.title).not.toContain(key);
    const t = await c.addUserTurn(conv.id, `my token is ${key}`, { context: `${key}\n${'x'.repeat(MAX_CHAT_CONTEXT + 500)}`, sources: [src('S1', `src/${key}.ts`)] });
    expect(t!.turns[0].text).not.toContain(key);
    expect(t!.turns[1].sources[0].ref).not.toContain(key);
    const job = await c.nextPendingTurn();
    expect(job!.context).not.toContain(key);
    expect(job!.context.length).toBeLessThanOrEqual(MAX_CHAT_CONTEXT);
    await c.markAnswering(job!.turn.id, 'ollama:gemma4');
    await c.saveAnswer(job!.turn.id, { ...answer(`use ${key}`), prompt: `export TOKEN=${key}` });
    const done = (await c.conversation(conv.id))!.turns[1];
    expect(JSON.stringify(done)).not.toContain(key);
    const again = await c.addUserTurn(conv.id, 'x', { context: '', sources: [] });
    await c.failTurn(again!.turns[3].id, `failed with ${key}`);
    expect((await c.conversation(conv.id))!.turns[3].error).not.toContain(key);
  });

  test('deleting a conversation removes its turns; deleting a project removes its chats; chats are never exported', async () => {
    const gone = await c.createConversation({ projectKey: 'gone', title: 'secret plan', provider: null });
    await c.addUserTurn(gone.id, 'the secret plan question', { context: 'secret pack', sources: [] });
    const stay = await c.createConversation({ projectKey: 'stay', title: 'kept', provider: null });
    await c.addUserTurn(stay.id, 'kept question', { context: 'kept pack', sources: [] });
    const other = await c.createConversation({ projectKey: 'stay', title: 'deleted by hand', provider: null });
    await c.addUserTurn(other.id, 'by hand', { context: 'x', sources: [] });
    expect(await c.deleteConversation(other.id)).toBe(true);
    expect(await c.deleteConversation(other.id)).toBe(false);
    expect(await c.conversation(other.id)).toBeNull();
    const bundle = JSON.stringify(await h.store.portability.exportData({}));
    expect(bundle).not.toContain('secret plan');
    expect(bundle).not.toContain('kept question');
    await h.store.portability.deleteProject('gone');
    expect(await c.conversation(gone.id)).toBeNull();
    expect((await c.listConversations({})).map((x) => x.id)).toEqual([stay.id]);
    // Its pending turn went with it.
    expect((await c.nextPendingTurn())!.conversation.id).toBe(stay.id);
  });
});
