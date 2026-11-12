import { expect, test } from 'vitest';
import { architectureSvg, NARROW_WIDTH, wrapWords } from './architecture.ts';

test('the static diagram carries its own light and dark colours, the in-app one only theme variables', () => {
  const file = architectureSvg('static');
  expect(file).toMatch(/@media \(prefers-color-scheme: dark\)/);
  expect(file).not.toMatch(/var\(--/);
  const app = architectureSvg('tokens');
  expect(app).not.toMatch(/#[0-9a-f]{6}/i);
  expect(app).not.toMatch(/prefers-color-scheme/);
});

test('every label is escaped, so the markup parses', () => {
  for (const colors of ['static', 'tokens'] as const) {
    for (const layout of ['wide', 'narrow'] as const) {
      const doc = new DOMParser().parseFromString(architectureSvg(colors, layout), 'image/svg+xml');
      expect(doc.querySelector('parsererror')).toBeNull();
      expect(doc.querySelectorAll('rect').length).toBeGreaterThan(14);
    }
  }
});

const parse = (layout: 'wide' | 'narrow') => new DOMParser().parseFromString(architectureSvg('tokens', layout), 'image/svg+xml');
const smallest = (doc: Document) => Math.min(...[...doc.querySelectorAll('text')].map((t) => Number(t.getAttribute('font-size'))));
const width = (doc: Document) => Number(doc.querySelector('svg')!.getAttribute('viewBox')!.split(' ')[2]);

test('each layout keeps its smallest text at 11px or more in the narrowest column the Docs page draws it in', () => {
  // The wide one from a 976px column; the narrow one from 460px (narrower, it scrolls). At 1024px the column was 470px
  // and the wide diagram's text 5px.
  const wide = parse('wide');
  expect((smallest(wide) * 976) / width(wide)).toBeGreaterThanOrEqual(11);
  const narrow = parse('narrow');
  expect(width(narrow)).toBe(NARROW_WIDTH);
  expect((smallest(narrow) * 460) / width(narrow)).toBeGreaterThanOrEqual(11);
});

test('the narrow layout says what the wide one does, its lines wrapped to fit its boxes', () => {
  const words = (doc: Document) => [...doc.querySelectorAll('g')].map((g) => [...g.querySelectorAll('text')].map((t) => t.textContent).join(' '));
  expect(words(parse('narrow'))).toEqual(expect.arrayContaining(words(parse('wide'))));
  expect(words(parse('narrow'))).toHaveLength(14);
  // Every text line stays inside its box at the font's average character width.
  for (const g of parse('narrow').querySelectorAll('g')) {
    const box = Number(g.querySelector('rect')!.getAttribute('width'));
    for (const t of g.querySelectorAll('text')) {
      const per = Number(t.getAttribute('font-size')) * (t.getAttribute('font-weight') ? 0.55 : 0.5);
      expect(t.textContent!.length * per, t.textContent!).toBeLessThanOrEqual(box - 16);
    }
  }
  expect(parse('wide').querySelector('title')!.id).not.toBe(parse('narrow').querySelector('title')!.id);
});

test('words wrap at spaces to lines of at most the given length, a longer word on a line of its own', () => {
  expect(wrapWords('check_before_done judges the diff', 20)).toEqual(['check_before_done', 'judges the diff']);
  expect(wrapWords('Inbox', 5)).toEqual(['Inbox']);
});
