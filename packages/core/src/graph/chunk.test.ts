import { expect, test } from 'vitest';
import { chunkText } from './docs.ts';

test('chunkText packs paragraphs up to the size and splits oversized ones', () => {
  expect(chunkText('a\n\nb\n\nc', 10)).toEqual(['a\n\nb\n\nc']);
  expect(chunkText('aaaa\n\nbbbb\n\ncccc', 10)).toEqual(['aaaa\n\nbbbb', 'cccc']);
  expect(chunkText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  expect(chunkText('  \n\n ')).toEqual([]);
});
