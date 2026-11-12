import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Select } from './controls.tsx';
import { thClass } from './display.tsx';
import { ListRow } from './SplitPane.tsx';

afterEach(cleanup);

test('a selected row opens 13px clear of its 3px mark, whatever it starts with; with a lead control the mark is the whole row\'s', () => {
  render(<ul><li><ListRow selected onClick={() => {}}><input type="checkbox" aria-label="inside" /> text</ListRow></li><li><ListRow selected={false} lead={<input type="checkbox" aria-label="lead" />} onClick={() => {}}>other</ListRow></li></ul>);
  const plain = screen.getByRole('button', { name: /text/ });
  expect(plain.className).toMatch(/before:w-\[3px\]/);
  expect(plain.className).toMatch(/\bpl-4\b/);
  const lead = screen.getByRole('checkbox', { name: 'lead' }).parentElement!;
  expect(lead.className).toMatch(/\bpl-4\b/);
  expect(screen.getByRole('button', { name: 'other' }).className).not.toMatch(/before:/);
});

test('table headers stay on one line, and a select never collapses below 6rem', () => {
  expect(thClass).toMatch(/\bwhitespace-nowrap\b/);
  render(<Select aria-label="s"><option>one</option></Select>);
  expect(screen.getByRole('combobox', { name: 's' }).parentElement!.className).toMatch(/\bmin-w-24\b/);
});
