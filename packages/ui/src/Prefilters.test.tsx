import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { FEEDBACK_SKIP_RULES } from '@fb/core/feedback-rules';
import { Prefilters } from './Prefilters.tsx';

afterEach(cleanup);

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
