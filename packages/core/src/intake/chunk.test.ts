import { expect, test } from 'vitest';
import { chunkSourceText, embeddingInput } from './chunk.ts';

const joined = (text: string, size?: number) => chunkSourceText(text, size).join('\n\n');

test('chunks join back to the text exactly, blank lines and all', () => {
  const texts = [
    'one',
    'a\n\nb\n\nc',
    'Ana: first\nBo: second\n\n\n\nAna: third',
    '\n\nleading and trailing\n\n',
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ana>Hello\n\n00:00:02.000 --> 00:00:03.000\n<v Bo>Hi',
    `${'x'.repeat(5000)}\n\n${'y'.repeat(10)}\n\n${'z'.repeat(1490)}`,
  ];
  for (const t of texts) for (const size of [5, 20, 1500]) expect(joined(t, size)).toBe(t);
});

test('paragraphs are packed up to the size, and one longer than it is a chunk of its own', () => {
  expect(chunkSourceText('aaaa\n\nbbbb\n\ncccc', 10)).toEqual(['aaaa\n\nbbbb', 'cccc']);
  expect(chunkSourceText(`${'x'.repeat(30)}\n\nshort`, 10)).toEqual(['x'.repeat(30), 'short']);
  expect(chunkSourceText('', 10)).toEqual(['']);
});

test('an embedding reads at most the start of a long chunk', () => {
  expect(embeddingInput('abc', 2)).toBe('ab');
  expect(embeddingInput('abc')).toBe('abc');
});
