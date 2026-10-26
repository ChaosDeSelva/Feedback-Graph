import { expect, test } from 'vitest';
import { SOURCE_TONE } from '../CandidateDetail.tsx';
import { CAUSE_LABEL, causeLabel, causeTone, TONE_FILL } from './display.tsx';

test('every cause has its own tone, so no two causes read as the same color', () => {
  const tones = Object.keys(CAUSE_LABEL).map(causeTone);
  expect(new Set(tones).size).toBe(tones.length);
  // Each one also has a solid fill for bars and dots (Patterns, the Lessons list).
  for (const t of tones) expect(TONE_FILL[t]).toBeTruthy();
});

test('a cause that is a word on Object.prototype reads as itself, in the neutral tone', () => {
  for (const c of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    expect(causeLabel(c)).toBe(c);
    expect(causeTone(c)).toBe('neutral');
  }
});

test('every feedback source has its own tone: Claude, Codex, GitHub and Linear never share a color', () => {
  const tones = Object.values(SOURCE_TONE);
  expect(new Set(tones).size).toBe(tones.length);
});
