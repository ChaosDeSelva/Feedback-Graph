import { expect, test } from 'vitest';
import { withPackSizes, type ChatTurn } from './chat.ts';

const turn = (seq: number, role: ChatTurn['role'], sources = 0): ChatTurn => ({
  id: `t${seq}`, conversationId: 'c', seq, role, text: '', status: 'done', error: null, answer: null,
  sources: Array.from({ length: sources }, (_, i) => ({ id: `S${i + 1}`, kind: 'code' as const, ref: 'a.ts', title: 'a' })),
  provider: null, createdAt: 't', startedAt: null, finishedAt: null,
});

test('withPackSizes: each answer carries the size of the pack it was answered from (the question\'s stored context)', () => {
  const turns = withPackSizes([
    { turn: turn(1, 'user'), contextChars: 1234 },
    { turn: turn(2, 'assistant', 3), contextChars: null },
    // a question stored before packs were kept on it
    { turn: turn(3, 'user'), contextChars: null },
    { turn: turn(4, 'assistant', 1), contextChars: null },
  ]);
  expect(turns.map((t) => t.pack)).toEqual([null, { chars: 1234, sources: 3 }, null, null]);
});
