import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { byScore, judgementFirst, ScoreChip, scoreBand } from './ScoreChip.tsx';

afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; });

test('the bands: green from 7, red at 3 and under, grey between', () => {
  expect([0, 3, 3.1, 6.9, 7, 10].map(scoreBand)).toEqual(['low', 'low', 'middle', 'middle', 'high', 'high']);
});

test('the chip shows the number, says it and its reasons to a screen reader, and puts the why in its tooltip', () => {
  render(<ScoreChip score={8.6} why="8.6 · loop proposes approve_lesson: you kept 12 of 14 in its band (p .91)" />);
  const chip = screen.getByRole('img', { name: 'Approve score 8.6 of 10: loop proposes approve_lesson: you kept 12 of 14 in its band (p .91)' });
  expect(chip.textContent).toBe('8.6');
  expect(chip.dataset.band).toBe('high');
  expect(chip.querySelector('[title]')!.getAttribute('title')).toBe('8.6 · loop proposes approve_lesson: you kept 12 of 14 in its band (p .91)');
});

test('each band has its own tone, and no chip at all without a score', () => {
  const { rerender, container } = render(<ScoreChip score={2.1} why="2.1 · flagged risky-command" />);
  expect(container.querySelector('.bg-bad-soft.text-bad-text')).toBeTruthy();
  rerender(<ScoreChip score={5} why="5.0 · not checked yet" />);
  expect(container.querySelector('.bg-neutral-soft.text-muted')).toBeTruthy();
  rerender(<ScoreChip score={9} why={null} />);
  expect(container.querySelector('.bg-ok-soft.text-ok-text')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Approve score 9.0 of 10' })).toBeTruthy();
  rerender(<ScoreChip score={null} why={null} />);
  expect(container.innerHTML).toBe('');
});

test('in light and dark the chip uses only theme colour tokens (styles.css swaps their values), never a fixed colour', () => {
  const seen: string[][] = [];
  for (const theme of ['light', 'dark']) {
    document.documentElement.dataset.theme = theme;
    const { container, unmount } = render(<><ScoreChip score={9} why="" /><ScoreChip score={5} why="" /><ScoreChip score={1} why="" /></>);
    const colours = [...container.querySelectorAll('span')].flatMap((e) => [...e.classList]).filter((c) => /^(bg|text)-(?!\[)/.test(c));
    expect(colours.sort()).toEqual(['bg-bad-soft', 'bg-neutral-soft', 'bg-ok-soft', 'text-bad-text', 'text-muted', 'text-ok-text']);
    seen.push(colours);
    unmount();
  }
  expect(seen[0]).toEqual(seen[1]);
});

test('byScore puts the highest first and unscored last; judgementFirst the grey band nearest 5 first', () => {
  const rows = [{ score: 9 }, { score: null }, { score: 4.5 }, { score: 1 }, { score: 6 }];
  expect([...rows].sort(byScore).map((r) => r.score)).toEqual([9, 6, 4.5, 1, null]);
  expect([...rows].sort(judgementFirst).map((r) => r.score)).toEqual([4.5, 6, 9, 1, null]);
});
