import { expect, test } from 'vitest';
import { chunkBySymbols } from './chunk.ts';

const lines = (n: number, width = 9) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(width - 1, '0')};`).join('\n');

test('a file under the limit is one chunk', () => {
  expect(chunkBySymbols('a\nb\n', [1], 100, 4)).toEqual([{ text: 'a\nb\n', lines: '1-3' }]);
});

test('a large file is cut where top-level symbols start, never inside one that fits', () => {
  // 30 lines of 10 chars (with the newline): symbols start at 1, 11 and 21.
  const src = lines(30);
  const chunks = chunkBySymbols(src, [1, 11, 21], 220, 4);
  expect(chunks.map((c) => c.lines)).toEqual(['1-20', '21-30']);
  expect(chunks[0].text.split('\n')[0]).toBe('00000001;');
  expect(chunks[1].text.split('\n')[0]).toBe('00000021;');
});

test('a symbol bigger than the limit is cut at line boundaries', () => {
  const chunks = chunkBySymbols(lines(30), [1], 100, 10);
  expect(chunks.every((c) => c.text.length <= 100)).toBe(true);
  expect(chunks[0].lines).toBe('1-10');
  expect(chunks.at(-1)!.lines).toBe('21-30');
});

test('without symbols the file is cut at line boundaries; at most maxChunks are returned, from the top', () => {
  const chunks = chunkBySymbols(lines(30), [], 100, 2);
  expect(chunks.map((c) => c.lines)).toEqual(['1-10', '11-20']);
});
