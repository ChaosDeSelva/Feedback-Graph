import { expect, test } from 'vitest';
import {
  decodeSessionCursor, encodeSessionCursor, finalReplyDue, latestTime, mergeFiles, readSummary, SessionSummarySchema,
  summaryMarkdown, summaryRetryAt, summarySnippet, withMarkdown,
} from './sessions.ts';

const fields = {
  goal: 'Fix the login page',
  done: ['added a test', 'fixed the handler'],
  decisions: [],
  openThreads: ['dark mode'],
  filesTouched: ['src/a`b.ts'],
  pushback: [],
  outcome: 'Login works',
};

test('the model output is flattened, deduplicated and capped; an empty goal is refused', () => {
  const parsed = SessionSummarySchema.parse({ goal: '  Fix\n the   login ', done: ['a', ' a ', '', 'b'], filesTouched: Array.from({ length: 50 }, (_, i) => `f${i}`) });
  expect(parsed.goal).toBe('Fix the login');
  expect(parsed.done).toEqual(['a', 'b']);
  expect(parsed.decisions).toEqual([]);
  expect(parsed.filesTouched).toHaveLength(40);
  expect(parsed.outcome).toBe('');
  expect(SessionSummarySchema.safeParse({ goal: '   ' }).success).toBe(false);
});

test('mergeFiles joins both lists, trimmed and deduplicated, at most 40', () => {
  expect(mergeFiles(['a.ts', ' b.ts '], ['b.ts', '', 'c.ts'])).toEqual(['a.ts', 'b.ts', 'c.ts']);
  expect(mergeFiles(Array.from({ length: 30 }, (_, i) => `a${i}`), Array.from({ length: 30 }, (_, i) => `b${i}`))).toHaveLength(40);
});

test('summaryMarkdown renders only the non-empty sections and keeps backticks out of file code spans', () => {
  expect(summaryMarkdown(fields)).toBe(
    ['**Goal:** Fix the login page', '', '**Done**', '- added a test', '- fixed the handler', '',
      '**Open threads**', '- dark mode', '', '**Files touched**', "- `src/a'b.ts`", '', '**Outcome:** Login works'].join('\n'),
  );
  expect(summaryMarkdown({ ...fields, done: [], openThreads: [], filesTouched: [], outcome: '' })).toBe('**Goal:** Fix the login page');
  expect(withMarkdown(fields).markdown).toBe(summaryMarkdown(fields));
});

test('readSummary reads a stored row, a JSON string or a damaged value without throwing', () => {
  expect(readSummary(null)).toBeNull();
  expect(readSummary('')).toBeNull();
  expect(readSummary('{not json')).toBeNull();
  expect(readSummary('42')).toBeNull();
  expect(readSummary(JSON.stringify({ ...fields, markdown: 'stored' }))).toEqual({ ...fields, markdown: 'stored' });
  // missing or wrongly typed fields come back empty, and the markdown is rendered when none was stored
  const read = { goal: '', done: ['ok'], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: 'x' };
  expect(readSummary({ goal: 7, done: ['ok', 3, null], decisions: 'nope', outcome: 'x' })).toEqual({ ...read, markdown: summaryMarkdown(read) });
});

test('summarySnippet is the goal, else the outcome, cut to 200 characters; null when there is nothing', () => {
  const s = withMarkdown(fields);
  expect(summarySnippet(null)).toBeNull();
  expect(summarySnippet(s)).toBe('Fix the login page');
  expect(summarySnippet({ ...s, goal: '' })).toBe('Login works');
  expect(summarySnippet({ ...s, goal: '', outcome: '' })).toBeNull();
  expect(summarySnippet({ ...s, goal: 'x'.repeat(300) })).toHaveLength(200);
});

test('summaryRetryAt backs off from 5 minutes, doubling, up to 6 hours', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const after = (attempts: number) => (Date.parse(summaryRetryAt(attempts, now)) - now.getTime()) / 60_000;
  expect([0, 1, 2, 3, 7, 8, 20].map(after)).toEqual([5, 5, 10, 20, 320, 360, 360]);
});

test('latestTime is the newest readable time, ignoring missing and unreadable ones', () => {
  expect(latestTime('2026-01-01T00:00:00Z', null, 'garbage', '2026-03-01T00:00:00Z', undefined)).toBe('2026-03-01T00:00:00.000Z');
  expect(latestTime(null, 'garbage')).toBeNull();
  expect(latestTime()).toBeNull();
});

test('finalReplyDue only when the summary reached the last turn but not the reply stored after it', () => {
  const base = {
    finalReply: { ts: '2026-01-01T00:00:05Z', text: 'done' },
    finalReplySummarizedTs: null as string | null,
    summarizedThrough: { index: 4, ts: 't' } as { index: number; ts: string } | null,
    lastTurn: { index: 4, ts: 't' },
    rebuild: false,
  };
  expect(finalReplyDue(base)).toBe(true);
  expect(finalReplyDue({ ...base, finalReplySummarizedTs: '2026-01-01T00:00:05Z' })).toBe(false);
  expect(finalReplyDue({ ...base, finalReply: null })).toBe(false);
  expect(finalReplyDue({ ...base, rebuild: true })).toBe(false);
  expect(finalReplyDue({ ...base, summarizedThrough: null })).toBe(false);
  expect(finalReplyDue({ ...base, summarizedThrough: { index: 3, ts: 't' } })).toBe(false);
});

test('a session cursor round-trips; anything else decodes to null', () => {
  const c = { at: '2026-01-01T00:00:00.000Z', id: 'abc' };
  expect(decodeSessionCursor(encodeSessionCursor(c))).toEqual(c);
  expect(decodeSessionCursor(encodeSessionCursor({ at: '', id: 'x' }))).toEqual({ at: '', id: 'x' });
  expect(decodeSessionCursor('%%%')).toBeNull();
  expect(decodeSessionCursor(Buffer.from('{"at":"a","id":"b"}').toString('base64url'))).toBeNull();
  expect(decodeSessionCursor(Buffer.from('["a",1]').toString('base64url'))).toBeNull();
});
