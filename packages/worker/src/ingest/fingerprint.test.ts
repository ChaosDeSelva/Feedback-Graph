import type { HumanTurn, ParsedSession } from '@fb/core';
import { expect, test } from 'vitest';
import { conversationFingerprint } from './fingerprint.ts';

const turn = (i: number, text: string): HumanTurn => ({ uuid: `t${i}`, sessionId: 's', ts: `2026-10-01T10:0${i}:00Z`, index: i, text, precedingAssistantText: '', precedingToolCalls: [] });
const session = (texts: string[], extra: Partial<ParsedSession> = {}): ParsedSession => ({
  sessionId: 's', sourceFile: 'f', cwd: '/vibe/demo-shop', gitBranch: null, startedAt: '', endedAt: '', turns: texts.map((t, i) => turn(i, t)), toolCalls: [], ...extra,
});

test('the same conversation fingerprints the same in either agent, whatever the spacing, case or ids', () => {
  const claude = session(['Build the customer search page', 'No, the filter must run on the server.', 'add a footer'], { source: 'claude', sessionId: 'a' });
  const codex = session(['build the customer  search page\n', 'No - the filter must run on the server', 'Add a footer!'], { source: 'codex', sessionId: 'b' });
  expect(conversationFingerprint(claude)).not.toBeNull();
  expect(conversationFingerprint(codex)).toBe(conversationFingerprint(claude));
});

test('only the opening turns count, so a copy that has grown since still matches', () => {
  const a = session(['Build the customer search page', 'No, the filter must run on the server.', 'add a footer']);
  expect(conversationFingerprint(session([...a.turns.map((t) => t.text), 'and a header']))).toBe(conversationFingerprint(a));
});

test('a different conversation does not match; one too short to tell apart has no fingerprint', () => {
  const a = session(['Build the customer search page', 'No, the filter must run on the server.']);
  expect(conversationFingerprint(session(['Build the customer search page', 'make the filter faster please']))).not.toBe(conversationFingerprint(a));
  expect(conversationFingerprint(session(['hi', 'go on']))).toBeNull();
  expect(conversationFingerprint(session([]))).toBeNull();
  // One prompt given to both agents (to compare them) is two conversations, not a copy.
  expect(conversationFingerprint(session(['Build the customer search page with server-side filtering and paging']))).toBeNull();
});
