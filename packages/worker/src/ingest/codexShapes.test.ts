import { expect, test } from 'vitest';
import { parseCodexSession } from './codex.ts';

const ts = (s: number) => `2026-10-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const rec = (s: number, type: string, payload: object) => JSON.stringify({ timestamp: ts(s), type, payload });
const meta = rec(5, 'session_meta', { id: 'shape-1', cwd: '/work/shop', thread_source: 'user' });
const user = (s: number, text: string) => rec(s, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const call = (s: number, payload: object) => rec(s, 'response_item', payload);
/** The tool calls the second human turn followed. */
const callsBefore = (...lines: string[]) => {
  const [s] = parseCodexSession([meta, user(6, 'first ask'), ...lines, user(30, 'that is wrong')].join('\n'), 'e.jsonl');
  return s.turns[1].precedingToolCalls;
};

test('shell calls with no command, a blank one or an empty argv are recorded without a command', () => {
  expect(callsBefore(
    call(7, { type: 'local_shell_call', call_id: 'l1' }),
    call(8, { type: 'local_shell_call', action: { command: '   ' } }),
    call(9, { type: 'local_shell_call', action: { command: ['bash', '-lc', '  '] } }),
    call(10, { type: 'local_shell_call', action: { command: [] } }),
    call(11, { type: 'local_shell_call', action: { command: ['sh', '-c', 'pnpm test'] } }),
  )).toEqual([
    { name: 'Bash', ts: ts(7) }, { name: 'Bash', ts: ts(8) }, { name: 'Bash', ts: ts(9) }, { name: 'Bash', ts: ts(10) },
    { name: 'Bash', ts: ts(11), command: 'pnpm test' },
  ]);
});

test('an apply_patch call names its files whether the patch is under input or patch, and arguments as an object are read', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch';
  expect(callsBefore(
    call(7, { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ patch }) }),
    call(8, { type: 'function_call', name: 'apply_patch', arguments: { input: patch } }),
    call(9, { type: 'function_call', name: 'apply_patch', arguments: '{not json' }),
    call(10, { type: 'function_call', name: 'apply_patch', arguments: '{}' }),
  )).toEqual([
    { name: 'Edit', ts: ts(7), filePath: '/work/shop/src/a.ts' }, { name: 'Edit', ts: ts(8), filePath: '/work/shop/src/a.ts' },
    { name: 'Edit', ts: ts(9) }, { name: 'Edit', ts: ts(10) },
  ]);
});

test('a deleted file is recorded; a file change with no changes, or with changes that are not a list, records nothing', () => {
  const item = (s: number, o: object) => rec(s, 'event_msg', { type: 'item_completed', item: { type: 'FileChange', ...o } });
  expect(callsBefore(
    item(7, { changes: { 'src/old.ts': { type: 'delete' } } }),
    item(8, {}),
    rec(9, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: 'ls', parsed_cmd: 'ls' } }),
  )).toEqual([{ name: 'Delete', ts: ts(7), filePath: '/work/shop/src/old.ts' }, { name: 'Bash', ts: ts(9), command: 'ls' }]);
});

test('assistant parts that are not output text, or are empty, are no reply', () => {
  const [s] = parseCodexSession([
    meta, user(6, 'build it'),
    call(7, { type: 'message', role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'output_text', text: '  ' }, 'oops'] }),
  ].join('\n'), 'e.jsonl');
  expect(s.finalReply).toBeNull();
});

test('a human turn ignores empty text parts, and a record dated before the session start moves its start back', () => {
  const [s] = parseCodexSession([
    meta,
    rec(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }, { type: 'input_text', text: 'build it' }] }),
  ].join('\n'), 'e.jsonl');
  expect(s.turns.map((t) => t.text)).toEqual(['build it']);
  expect(s.startedAt).toBe(ts(2));
});

test('a turn context without a cwd keeps the folder', () => {
  const [s] = parseCodexSession([meta, rec(6, 'turn_context', { model: 'gpt' }), user(7, 'build it')].join('\n'), 'e.jsonl');
  expect(s.cwd).toBe('/work/shop');
});

test('a session meta with no id is skipped and the next one starts the session; with no time anywhere it starts at its first record', () => {
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/x', thread_source: 'user' } }),
    JSON.stringify({ type: 'session_meta', payload: { id: 'late-1', cwd: '/work/shop', thread_source: 'user', timestamp: ts(3) } }),
    user(4, 'build it'),
  ];
  const [s] = parseCodexSession(lines.join('\n'), 'e.jsonl');
  expect(s).toMatchObject({ sessionId: 'late-1', startedAt: ts(3), cwd: '/work/shop' });
  const [t] = parseCodexSession([JSON.stringify({ type: 'session_meta', payload: { id: 'undated', cwd: '/w', thread_source: 'user' } }), user(4, 'go')].join('\n'), 'e.jsonl');
  expect(t.startedAt).toBe('');
  expect(t.endedAt).toBe(ts(4));
});

test('a spawned sub-agent session, by either form of its source, is not read', () => {
  for (const source of ['subagent', { subagent: { parent: 'p1' } }]) {
    const m = rec(0, 'session_meta', { id: 'sub-1', cwd: '/work/shop', source });
    expect(parseCodexSession([m, user(1, 'build it')].join('\n'), 'e.jsonl')).toEqual([]);
  }
});
