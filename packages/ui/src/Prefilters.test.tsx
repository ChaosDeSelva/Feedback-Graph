import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FEEDBACK_SKIP_RULES } from '@fb/core/feedback-rules';
import { Prefilters } from './Prefilters.tsx';

let answer: () => Response;

beforeEach(() => {
  answer = () => Response.json({ error: 'down' }, { status: 500 });
  vi.stubGlobal('fetch', vi.fn(async () => answer()));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('lists every skip rule with its name and description, read-only', () => {
  render(<Prefilters />);
  const list = screen.getByRole('list', { name: 'comments skipped before the classifier' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(FEEDBACK_SKIP_RULES.length);
  for (const r of FEEDBACK_SKIP_RULES) {
    expect(within(list).getByText(r.name)).toBeTruthy();
    expect(within(list).getByText(r.description)).toBeTruthy();
  }
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('each rule says how many comments it has skipped, and since when', async () => {
  answer = () => Response.json({
    rules: FEEDBACK_SKIP_RULES.map((r) => ({ name: r.name, description: r.description, skipped: r.name === 'pr-author-reply' ? 3 : 0 })),
    skippedSince: '2026-10-20T10:00:00Z',
  });
  render(<Prefilters />);
  const row = (await screen.findByText('3 skipped')).closest('li')!;
  expect(within(row).getByText('pr-author-reply')).toBeTruthy();
  expect(screen.getAllByText('0 skipped')).toHaveLength(FEEDBACK_SKIP_RULES.length - 1);
  expect(screen.getByText(/counted since/i)).toBeTruthy();
  expect(screen.getByRole('link', { name: /see them in Activity/i }).getAttribute('href')).toBe('#activity');
});
