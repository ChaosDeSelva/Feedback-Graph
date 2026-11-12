import { expect, test } from 'vitest';
import { parseTranscript } from './parseTranscript.ts';

// A fictional Claude Code session started in the folder holding the projects, that then worked in two of them.
const ROOT = '/H/Code';
const projectOf = (cwd: string) => cwd.match(/^\/H\/Code\/([^/]+)/)?.[1] ?? null;
let n = 0;
const rec = (type: 'user' | 'assistant', cwd: string, text: string, sessionId = 's1') => JSON.stringify({
  type, sessionId, cwd, uuid: `u${++n}`, timestamp: `2026-11-01T10:${String(n).padStart(2, '0')}:00Z`, gitBranch: 'main',
  message: type === 'user' ? { content: text } : { content: [{ type: 'text', text }] },
});

test('a session that moves into project folders goes on as one segment per project, each with the turns typed there', () => {
  n = 0;
  const text = [
    rec('user', ROOT, 'which of these folders has the cart code?'),
    rec('assistant', ROOT, 'The cart lives in demo-shop.'),
    rec('assistant', `${ROOT}/demo-shop`, 'I am in demo-shop now.'),
    rec('user', `${ROOT}/demo-shop`, 'fix the cart total rounding'),
    rec('assistant', `${ROOT}/demo-shop/src`, 'Fixed in src/cart.ts.'),
    rec('user', `${ROOT}/demo-shop/src`, 'now run its tests'),
    rec('assistant', `${ROOT}/side-tool`, 'Moved to side-tool.'),
    rec('user', `${ROOT}/side-tool`, 'same fix here please'),
  ].join('\n');
  const segs = parseTranscript(text, 'f.jsonl', { projectOf });
  expect(segs.map((s) => ({ id: s.sessionId, cwd: s.cwd, turns: s.turns.map((t) => [t.index, t.sessionId, t.text]) }))).toEqual([
    { id: 's1', cwd: ROOT, turns: [[0, 's1', 'which of these folders has the cart code?']] },
    { id: 's1#2', cwd: `${ROOT}/demo-shop`, turns: [[1, 's1#2', 'fix the cart total rounding'], [2, 's1#2', 'now run its tests']] },
    { id: 's1#3', cwd: `${ROOT}/side-tool`, turns: [[3, 's1#3', 'same fix here please']] },
  ]);
  // The first turn of a segment answers what the agent said just before, wherever it said it.
  expect(segs[1].turns[0].precedingAssistantText).toBe('I am in demo-shop now.');
  expect(segs[0].finalReply).toBeNull();
});

test('a session that moves into a project before anyone typed is that project\'s from the start; without projectOf, the first cwd', () => {
  n = 0;
  const text = [
    rec('assistant', ROOT, 'Starting up.', 's2'),
    rec('user', `${ROOT}/demo-shop`, 'add a test for the discount code', 's2'),
  ].join('\n');
  expect(parseTranscript(text, 'f.jsonl', { projectOf }).map((s) => [s.sessionId, s.cwd, s.turns.length])).toEqual([['s2', `${ROOT}/demo-shop`, 1]]);
  expect(parseTranscript(text, 'f.jsonl').map((s) => [s.sessionId, s.cwd, s.turns.length])).toEqual([['s2', ROOT, 1]]);
});

test('a compaction summary is never a human turn: flagged or not, as text or parts, or shown in the transcript only', () => {
  const summary = 'This session is being continued from a previous conversation that ran out of context. Summary: the developer asked for a cart fix.';
  const user = (o: object) => JSON.stringify({ type: 'user', sessionId: 's3', cwd: '/H/Code/demo-shop', timestamp: '2026-11-01T11:00:00Z', ...o });
  const text = [
    user({ uuid: 'c1', message: { content: [{ type: 'text', text: summary }] } }),
    user({ uuid: 'c2', message: { content: summary } }),
    user({ uuid: 'c3', isVisibleInTranscriptOnly: true, message: { content: 'Compacted. ctrl+o to see the full summary' } }),
    user({ uuid: 'c4', message: { content: 'now fix the discount rounding too' } }),
  ].join('\n');
  expect(parseTranscript(text, 'f.jsonl')[0].turns.map((t) => t.uuid)).toEqual(['c4']);
});
