import { expect, test } from 'vitest';
import { parseCodexSession } from './codex.ts';

const ts = (s: number) => `2026-10-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const rec = (s: number, type: string, payload: object) => JSON.stringify({ timestamp: ts(s), type, payload });
const meta = rec(0, 'session_meta', { id: 'edge-1', cwd: '/work/shop', thread_source: 'user' });
const user = (s: number, text: string) => rec(s, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
/** The tool calls the second human turn followed. */
const callsBefore = (...lines: string[]) => {
  const [s] = parseCodexSession([meta, user(1, 'first ask'), ...lines, user(9, 'that is wrong')].join('\n'), 'e.jsonl');
  return s.turns[1].precedingToolCalls;
};

test('a custom tool other than apply_patch is recorded by name', () => {
  expect(callsBefore(rec(2, 'response_item', { type: 'custom_tool_call', name: 'web_search', call_id: 'c1', input: 'docs' }))).toEqual([{ name: 'web_search', ts: ts(2) }]);
});

test('a file change of an unknown kind is not recorded; known kinds are, at their moved path', () => {
  const item = (changes: object) => rec(3, 'event_msg', { type: 'item_completed', item: { id: 'i1', type: 'FileChange', changes } });
  expect(callsBefore(item({ 'src/a.ts': { type: 'rename' }, 'src/b.ts': null, 'src/c.ts': { kind: { type: 'update', move_path: 'src/d.ts' } } }))).toEqual([
    { name: 'Edit', ts: ts(3), filePath: '/work/shop/src/d.ts' },
  ]);
});

test('records that are neither wrapped nor a known bare shape are skipped', () => {
  const lines = [
    JSON.stringify({ timestamp: ts(2), type: 'response_item', payload: 'not an object' }),
    JSON.stringify({ timestamp: ts(2), payload: { type: 'message' } }),
    JSON.stringify({ record_type: 'state' }),
  ];
  expect(callsBefore(...lines)).toEqual([]);
});

test('an environment context without a cwd leaves a meta with none still without one', () => {
  const noCwdMeta = rec(0, 'session_meta', { id: 'edge-2', thread_source: 'user' });
  const env = rec(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <shell>zsh</shell>\n</environment_context>' }, { type: 'input_text', text: 'hello' }] });
  const [s] = parseCodexSession([noCwdMeta, env].join('\n'), 'n.jsonl');
  expect(s.cwd).toBe('');
  expect(s.turns.map((t) => t.text)).toEqual(['hello']);
});

test('a timestamp no store can hold is the one before it, so the session still ingests', () => {
  const bad = JSON.stringify({ timestamp: '2026-10-01T10:60:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'that is wrong' }] } });
  const [s] = parseCodexSession([meta, user(1, 'first ask'), bad].join('\n'), 'e.jsonl');
  expect(s.turns.map((t) => t.ts)).toEqual([ts(1), ts(1)]);
  expect(s.endedAt).toBe(ts(1));
});
