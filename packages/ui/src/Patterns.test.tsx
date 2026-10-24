import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fillWeeks, Patterns } from './Patterns.tsx';

const report = {
  causes: [{ cause: 'context_available_ignored', count: 5 }, { cause: 'verification_gap', count: 2 }],
  weekly: [{ week: '2026-W40', feedback: 4, repeats: 0 }, { week: '2026-W41', feedback: 3, repeats: 2 }],
  repeatGroups: [{ cause: 'context_available_ignored', count: 3, projects: ['shop'], examples: ['no tenant scoping', 'tenant scoping again', 'scoping, third time'], lastSeen: '2026-10-09T10:00:00Z' }],
  preDone: { checks: 8, withGaps: 2, gapsFound: 3 },
};
let urls: string[];
beforeEach(() => {
  urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/projects') return Response.json([{ key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null }]);
    if (url.startsWith('/api/patterns')) return Response.json(report);
    if (url.startsWith('/api/codemap/hotspots')) return Response.json([
      { projectKey: 'shop', path: 'src/db/pool.ts', churn: 7, misses: 2, dependents: 3, score: 13 },
      { projectKey: 'blog', path: 'lib/render.ts', churn: 30, misses: 0, dependents: 1, score: 5.95 },
    ]);
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('shows causes, repeat groups, weekly trend and the pre-done catch rate', async () => {
  render(<Patterns />);
  expect(await screen.findByText('context available, ignored')).toBeTruthy();
  expect(screen.getByText('no tenant scoping')).toBeTruthy();
  expect(screen.getByText(/3× · shop/)).toBeTruthy();
  expect(screen.getByText('2026-W41')).toBeTruthy();
  expect(screen.getByLabelText('pre-done checks').textContent).toContain('8');
  expect(screen.getByLabelText('checks that caught a gap').textContent).toContain('25%');
  expect(screen.getByLabelText('repeat rate').textContent).toContain('29%'); // 2 repeats of 7 feedback
});

test('project filter rescopes the report', async () => {
  render(<Patterns />);
  await screen.findByText('no tenant scoping');
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'shop' } });
  await waitFor(() => expect(urls).toContain('/api/patterns?project=shop'));
  expect(urls).toContain('/api/patterns');
});

test('the weekly chart fills quiet weeks with zeros and shows at least eight, across a year end', () => {
  const weeks = fillWeeks([{ week: '2025-W52', feedback: 2, repeats: 1 }, { week: '2026-W02', feedback: 1, repeats: 0 }]);
  expect(weeks.map((w) => w.week)).toEqual(['2025-W47', '2025-W48', '2025-W49', '2025-W50', '2025-W51', '2025-W52', '2026-W01', '2026-W02']);
  expect(weeks.map((w) => w.feedback)).toEqual([0, 0, 0, 0, 0, 2, 0, 1]);
  expect(fillWeeks([{ week: '2020-W53', feedback: 1, repeats: 0 }]).slice(-2).map((w) => w.week)).toEqual(['2020-W52', '2020-W53']);
});

test('where agents struggle: the top hotspots across the selected projects, rescoped by the project filter', async () => {
  render(<Patterns />);
  const card = await screen.findByRole('region', { name: /where agents struggle/i });
  expect(await within(card).findByText('src/db/pool.ts')).toBeTruthy();
  expect(within(card).getByText('lib/render.ts')).toBeTruthy();
  expect(within(card).getByText('blog')).toBeTruthy();
  expect(urls).toContain('/api/codemap/hotspots?limit=10');
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'shop' } });
  await waitFor(() => expect(urls).toContain('/api/codemap/hotspots?project=shop&limit=10'));
});

test('where agents struggle: test files are left out until "include tests" is ticked', async () => {
  render(<Patterns />);
  const card = await screen.findByRole('region', { name: /where agents struggle/i });
  await within(card).findByText('src/db/pool.ts');
  const box = within(card).getByLabelText(/include tests/i) as HTMLInputElement;
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  await waitFor(() => expect(urls).toContain('/api/codemap/hotspots?limit=10&tests=1'));
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'shop' } });
  await waitFor(() => expect(urls).toContain('/api/codemap/hotspots?project=shop&limit=10&tests=1'));
});

test('a slow all-projects report never replaces the one for the project you picked', async () => {
  const shopOnly = { ...report, repeatGroups: [{ ...report.repeatGroups[0], examples: ['only in shop'] }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([{ key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null }]);
    if (url === '/api/patterns') { await new Promise((r) => setTimeout(r, 80)); return Response.json(report); }
    if (url === '/api/patterns?project=shop') return Response.json(shopOnly);
    return Response.json([]);
  }));
  render(<Patterns />);
  await waitFor(() => expect(screen.getByRole('option', { name: 'shop' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'shop' } });
  expect(await screen.findByText('only in shop')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 120));
  expect(screen.getByText('only in shop')).toBeTruthy();
  expect(screen.queryByText('no tenant scoping')).toBeNull();
});
