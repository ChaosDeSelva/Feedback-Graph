import { expect, test } from 'vitest';
import { suggestedRoot } from './candidates.ts';

test("a session outside every root suggests its folder's parent, never the disk root, home, a temp or dot folder", () => {
  expect(suggestedRoot('/Users/me/Code/app/', '/Users/me')).toBe('/Users/me/Code');
  expect(suggestedRoot('/')).toBeNull();
  expect(suggestedRoot('/Users/me/app', '/Users/me')).toBeNull();
  expect(suggestedRoot('/Users/me/.config/tool')).toBeNull();
  expect(suggestedRoot('/private/tmp/x/y')).toBeNull();
});
