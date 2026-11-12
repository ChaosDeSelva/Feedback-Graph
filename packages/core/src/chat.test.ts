import { expect, test } from 'vitest';
import {
  ChatBusyError, chatTitle, cleanChatAnswer, cleanChatContext, cleanChatError, cleanChatSources, cleanChatText, cleanChatTitle,
  MAX_CHAT_CONTEXT, MAX_CHAT_ERROR, MAX_CHAT_TEXT, MAX_CHAT_TITLE, withPackSizes, type ChatTurn,
} from './chat.ts';

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

// A GitHub token (redact.ts replaces it with [REDACTED]); built at runtime so the source holds no secret-shaped literal.
const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;

test('chatTitle: the first question on one line, cut at 60 characters with an ellipsis; blank is "New chat"', () => {
  expect(chatTitle('  how does\n the  login   work? ')).toBe('how does the login work?');
  expect(chatTitle('   \n ')).toBe('New chat');
  expect(chatTitle('word '.repeat(30))).toBe(`${'word '.repeat(11)}word…`);
  // a cut that lands after a space does not leave it before the ellipsis
  expect(chatTitle(`${'x'.repeat(58)} yyyy`)).toBe(`${'x'.repeat(58)}…`);
  expect(chatTitle('x'.repeat(60))).toBe('x'.repeat(60));
});

test('stored chat text is redacted and capped', () => {
  expect(cleanChatTitle(`  token\n${TOKEN}  `)).toBe('token [REDACTED]');
  expect(cleanChatTitle('  ')).toBe('New chat');
  expect(cleanChatTitle('t'.repeat(500))).toHaveLength(MAX_CHAT_TITLE);
  expect(cleanChatText(`use ${TOKEN}`)).toBe('use [REDACTED]');
  expect(cleanChatText('a'.repeat(MAX_CHAT_TEXT + 10))).toHaveLength(MAX_CHAT_TEXT);
  expect(cleanChatContext('c'.repeat(MAX_CHAT_CONTEXT + 1))).toHaveLength(MAX_CHAT_CONTEXT);
  expect(cleanChatError(`failed: ${TOKEN}`)).toBe('failed: [REDACTED]');
  expect(cleanChatError('e'.repeat(MAX_CHAT_ERROR * 2))).toHaveLength(MAX_CHAT_ERROR);
});

test('stored sources keep only their fields, redacted, capped at 80', () => {
  const src = { id: 'S1', kind: 'doc' as const, ref: `docs/${TOKEN}.md`, title: 't'.repeat(400), extra: 'dropped' };
  const out = cleanChatSources(Array.from({ length: 100 }, () => src));
  expect(out).toHaveLength(80);
  expect(out[0]).toEqual({ id: 'S1', kind: 'doc', ref: 'docs/[REDACTED].md', title: 't'.repeat(300) });
});

test('a stored answer is redacted and capped: examples, their usages and lines', () => {
  const example = { path: `src/${TOKEN}.ts`, lines: '10-20', why: `because ${TOKEN}`, usages: Array.from({ length: 20 }, (_, i) => `u${i}`) };
  const out = cleanChatAnswer({
    answer: `see [S1] ${TOKEN}`,
    prompt: `brief ${TOKEN}`,
    examples: [...Array.from({ length: 25 }, () => example), { ...example, lines: null }],
  });
  expect(out.answer).toBe('see [S1] [REDACTED]');
  expect(out.prompt).toBe('brief [REDACTED]');
  expect(out.examples).toHaveLength(20);
  expect(out.examples[0]).toEqual({ path: 'src/[REDACTED].ts', lines: '10-20', why: 'because [REDACTED]', usages: Array.from({ length: 12 }, (_, i) => `u${i}`) });
  expect(cleanChatAnswer({ answer: '', prompt: '', examples: [{ ...example, lines: null }] }).examples[0]!.lines).toBeNull();
  expect(cleanChatAnswer({ answer: 'a'.repeat(50_000), prompt: '', examples: [] }).answer).toHaveLength(40_000);
});

test('ChatBusyError names itself so callers can tell it from other failures', () => {
  const e = new ChatBusyError();
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe('ChatBusyError');
  expect(e.message).toMatch(/still being answered/);
});
