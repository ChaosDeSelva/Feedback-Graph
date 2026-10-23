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

test('signals are the phrases that matched, not regex source', () => {
  expect(prefilterPushback("This isn't good enough. You didn't add a test.").signals).toEqual(["isn't good enough", "You didn't"]);
});
