import { expect, test } from 'vitest';
import { claudeInstructionFiles } from './instructions.ts';
import { parseTranscript } from './parseTranscript.ts';

const line = (o: object) => JSON.stringify({ sessionId: 's', ...o });

test('records out of order, and a folder and branch known only from later records, still give the whole session', () => {
  const [s] = parseTranscript([
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:05:00Z', message: { content: 'still broken' } }),
    line({ type: 'user', uuid: 'u0', timestamp: '2026-10-01T10:00:00Z', cwd: '/H/demo', gitBranch: 'feat/x', message: { content: 'build it' } }),
  ].join('\n'), 's.jsonl');
  expect(s).toMatchObject({ startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:05:00Z', cwd: '/H/demo', gitBranch: 'feat/x' });
});

test('lines that are JSON but no record, assistant text that is a plain string, a tool call with no input and a text part with no text are skipped', () => {
  const [s] = parseTranscript([
    'null',
    '42',
    line({ type: 'user', uuid: 'u0', timestamp: '2026-10-01T10:00:00Z', cwd: '/H/demo', message: { content: 'build it' } }),
    line({ type: 'assistant', uuid: 'a0', timestamp: '2026-10-01T10:01:00Z', message: { content: 'a plain string' } }),
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:02:00Z', message: { content: [{ type: 'tool_use', name: 'Edit' }] } }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:03:00Z', message: { content: [{ type: 'text' }, { type: 'text', text: 'that is wrong' }] } }),
  ].join('\n'), 's.jsonl');
  expect(s.toolCalls).toEqual([{ name: 'Edit', ts: '2026-10-01T10:02:00Z' }]);
  expect(s.turns.map((t) => t.text)).toEqual(['build it', 'that is wrong']);
  expect(s.turns[1].precedingAssistantText).toBe('');
});

test('an attachment with empty fields or nested past four levels names no instruction file', () => {
  const deep = { a: { b: { c: { d: { e: { path: '/r/CLAUDE.md' } } } } } };
  expect(claudeInstructionFiles({ type: 'attachment', attachment: { content: null, nested: deep } })).toEqual([]);
  expect(claudeInstructionFiles({ type: 'attachment', attachment: { a: { b: { path: '/r/CLAUDE.md' } } } })).toEqual(['/r/CLAUDE.md']);
});
