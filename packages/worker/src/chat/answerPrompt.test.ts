import type { ChatJob, ChatTurn } from '@fb/core';
import { expect, test } from 'vitest';
import { chatUserPrompt } from './answer.ts';

const turn = (seq: number, role: ChatTurn['role'], text: string): ChatTurn => ({
  id: `t${seq}`, conversationId: 'chat-1', seq, role, text, status: 'done', error: null, answer: null, sources: [], provider: null, createdAt: 't', startedAt: null, finishedAt: null,
});
const job = (turns: ChatTurn[], context: string): ChatJob => ({
  conversation: { id: 'chat-1', projectKey: 'demo', title: 't', provider: 'claude', createdAt: 't', updatedAt: 't', pending: true, turns },
  turn: turns.at(-1)!, question: turns.at(-2)!, context,
});

test('a first question with nothing matched says so, instead of leaving the pack and the conversation blank', () => {
  const p = chatUserPrompt(job([turn(1, 'user', 'where is auth?'), { ...turn(2, 'assistant', ''), status: 'pending' }], ''));
  expect(p).toContain('(empty: nothing in Feedback Graph matched)');
  expect(p).toContain('(this is the first question)');
});

test('a long earlier answer is clipped in the conversation the model is shown', () => {
  const long = 'x'.repeat(2000);
  const p = chatUserPrompt(job([turn(1, 'user', 'q1'), turn(2, 'assistant', long), turn(3, 'user', 'q2'), { ...turn(4, 'assistant', ''), status: 'pending' }], 'pack'));
  expect(p).toContain(`YOU ANSWERED: ${'x'.repeat(1500)}…`);
  expect(p).not.toContain('x'.repeat(1501));
});
