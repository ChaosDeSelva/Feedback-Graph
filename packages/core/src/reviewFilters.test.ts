import { expect, test } from 'vitest';
import { reviewPatterns } from './reviewFilters.ts';
test('PR mentions use an exact numeric boundary in prose, references and URLs', () => {
  const pattern = new RegExp(reviewPatterns(14194).pr!, 'i');
  for (const text of ['Fix #14194', 'PR 14194 needs work', 'acme/app#14194.', 'https://github.com/acme/app/pull/14194/files']) expect(pattern.test(text), text).toBe(true);
  for (const text of ['#141940', 'PR 141940', '#14194abc', 'unrelated 14194']) expect(pattern.test(text), text).toBe(false);
});
test('author mentions are exact escaped login tokens', () => {
  const pattern = new RegExp(reviewPatterns(undefined, 'dev.name').author!, 'i');
  expect(pattern.test('by @dev.name: fix this')).toBe(true);
  expect(pattern.test('by devXname')).toBe(false);
  expect(pattern.test('@dev.name-other')).toBe(false);
});


test('a transcript author mention can end with sentence punctuation without matching another login', () => {
  const text = 'Please fix PR #14194 from @Octo.';
  expect(new RegExp(reviewPatterns(14194).pr!, 'i').test(text)).toBe(true);
  const author = new RegExp(reviewPatterns(undefined, 'octo').author!, 'i');
  expect(author.test(text)).toBe(true);
  expect(author.test('from @Octo, thanks')).toBe(true);
  expect(author.test('from @Octo)')).toBe(true);
  for (const other of ['@Octo-more', '@Octo_more', '@Octomore']) expect(author.test(other)).toBe(false);
});
