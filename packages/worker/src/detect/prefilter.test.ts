import { expect, test } from 'vitest';
import { prefilterPushback } from './prefilter.ts';

test.each([
  "this isn't good enough",
  'you missed the server-side filtering',
  "no, that's wrong",
  'why did you remove X',
  'still broken',
  "that's not what I asked",
  'is this 100% done? you keep stopping',
  'uil-tx-6a-na-d26-buda-hays looks bad redo it',
  'WTF IS THIS ... I STILL SEE wavy lines in this section',
  "why is it smaller for wk 6 ... it should match the other weeks height",
  'STOP this is over, I told you to not touch another match game',
  'th drawer is broken',
  'g is cut off in the title',
  'I am not seeing it on the page',
  'the info icon is way too big',
  "it doesn't work on mobile",
  'you forgot the tests',
  'you were suppose to leave overall on primary yellow',
  'why are all label and input pairs so tight, I dont like it',
  'the line up sucks',
])('hit: %s', (text) => {
  const r = prefilterPushback(text);
  expect(r.hit).toBe(true);
  expect(r.signals.length).toBeGreaterThan(0);
});

test.each([
  'how do I play this?',
  'looks great, ship it',
  'can you add a settings screen',
  'yes build all of this out now',
  'give me the list of all 13',
  'awesome billing find, fix that , thanks',
  'keep going I want to finish all of this',
  'make the columns the same width',
])('miss: %s', (text) => {
  expect(prefilterPushback(text)).toEqual({ hit: false, signals: [] });
});

const FENCE = '`'.repeat(3);

test.each([
  // A pasted sign-in error: the strong word is the developer's, but the message is mostly the paste.
  `wtf is this\n${FENCE}\nError: Couldn't sign in\nAuthError: invalid_grant (refresh token expired)\n    at refresh (src/auth/session.ts:88:11)\n${FENCE}`,
  // A 404 report, the log pasted bare.
  'why is this\nGET /api/projects/demo-shop/issues 404 Not Found\n2026-10-23T22:41:07Z ERROR route not found: /api/projects/demo-shop/issues',
  // Words that only appear inside the paste never count.
  `${FENCE}\nError: wrong password, still failing after redo\n${FENCE}\ncan you look into this`,
  '> you missed the deadline, the client said\nadd a banner for the sale',
  // A long explanation with a passing "why the": defending a choice, not frustration.
  `Why the extra wrapper? It keeps the retry logic in one place, and the cache layer needs the same hook. ${'We measured it on the staging data and the overhead is a single allocation per request. '.repeat(4)}`,
])('weak or pasted signals alone miss: %s', (text) => {
  expect(prefilterPushback(text).hit).toBe(false);
});

test('a strong signal in the prose still hits beside a paste', () => {
  const r = prefilterPushback(`you didn't fix it, same error:\n${FENCE}\nError: Couldn't sign in\n${FENCE}`);
  expect(r.hit).toBe(true);
  expect(r.signals).toEqual(["you didn't"]);
});

test('a terse weak signal with nothing pasted still hits', () => {
  expect(prefilterPushback('wtf').hit).toBe(true);
  expect(prefilterPushback('why is the header blue').hit).toBe(true);
});

test('a correction of git behaviour hits: what the agent did, and what it was told', () => {
  expect(prefilterPushback('you pushed to main, I said not to').signals).toEqual(['I said not to', 'you pushed']);
  expect(prefilterPushback('you merged it into main without asking').hit).toBe(true);
  expect(prefilterPushback('I asked you to keep this local').hit).toBe(true);
});

test('signals are the phrases that matched, not regex source', () => {
  expect(prefilterPushback("This isn't good enough. You didn't add a test.").signals).toEqual(["isn't good enough", "You didn't"]);
});
