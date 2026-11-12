import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi, onTestFinished } from 'vitest';
import { fillWeeks, Patterns } from './Patterns.tsx';
import { heldAnswer } from './testing/heldAnswer.ts';

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
    if (url === '/api/projects') return Response.json([
      { key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null },
      { key: 'quiet', repoPath: '/y', sessions: 1, feedback: 0, lessons: 0, facts: 4, lastScan: null },
    ]);
    if (url.startsWith('/api/patterns')) return Response.json(report);
    if (url.startsWith('/api/codemap/hotspots')) return Response.json([
      { projectKey: 'shop', path: 'src/db/pool.ts', churn: 7, misses: 2, dependents: 3, score: 13 },
      { projectKey: 'blog', path: 'lib/render.ts', churn: 30, misses: 1, dependents: 1, score: 5.95 },
    ].filter((h) => !noMisses || !url.includes('misses=1')));
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); noMisses = false; });
let noMisses = false;

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

test('the project filter lists every project, as other pages do; one with no feedback says so', async () => {
  render(<Patterns />);
  await screen.findByText('no tenant scoping');
  const select = screen.getByLabelText('project') as HTMLSelectElement;
  await waitFor(() => expect([...select.options].map((o) => o.value)).toEqual(['', 'shop', 'quiet']));
  fireEvent.change(select, { target: { value: 'quiet' } });
  expect(await screen.findByText('No feedback in quiet yet')).toBeTruthy();
});

test('the weekly chart fills quiet weeks with zeros and shows at least eight, across a year end', () => {
  const weeks = fillWeeks([{ week: '2025-W52', feedback: 2, repeats: 1 }, { week: '2026-W02', feedback: 1, repeats: 0 }]);
  expect(weeks.map((w) => w.week)).toEqual(['2025-W47', '2025-W48', '2025-W49', '2025-W50', '2025-W51', '2025-W52', '2026-W01', '2026-W02']);
  expect(weeks.map((w) => w.feedback)).toEqual([0, 0, 0, 0, 0, 2, 0, 1]);
  expect(fillWeeks([{ week: '2020-W53', feedback: 1, repeats: 0 }]).slice(-2).map((w) => w.week)).toEqual(['2020-W52', '2020-W53']);
});

test('where agents struggle: the files with misses across the selected projects, rescoped by the project filter', async () => {
  render(<Patterns />);
  const card = await screen.findByRole('region', { name: /where agents struggle/i });
  expect(await within(card).findByText('src/db/pool.ts')).toBeTruthy();
  expect(within(card).getByText('lib/render.ts')).toBeTruthy();
  expect(within(card).getByText('blog')).toBeTruthy();
  expect(urls).toContain('/api/codemap/hotspots?limit=10&misses=1');
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'shop' } });
  await waitFor(() => expect(urls).toContain('/api/codemap/hotspots?project=shop&limit=10&misses=1'));
});

test('where agents struggle, with no file missed yet, says so and links the hotspots (never lists files with 0 misses)', async () => {
  noMisses = true;
  render(<Patterns />);
  const card = await screen.findByRole('region', { name: /where agents struggle/i });
  expect(await within(card).findByText(/no files with misses yet/i)).toBeTruthy();
  expect(within(card).getByRole('link', { name: /hotspots/i }).getAttribute('href')).toBe('#projects');
});

test('where agents struggle, when the hotspots fail to load, shows the error (not "no files with misses") and retries', async () => {
  const working = fetch;
  let failing = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (failing && url.startsWith('/api/codemap/hotspots')) return Response.json({ error: 'graph unavailable' }, { status: 503 });
    return working(url, init);
  }));
  render(<Patterns />);
  const card = await screen.findByRole('region', { name: /where agents struggle/i });
  expect((await within(card).findByRole('alert')).textContent).toMatch(/graph unavailable/);
  expect(within(card).queryByText(/no files with misses yet/i)).toBeNull();
  failing = false;
  fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
  expect(await within(card).findByText('src/db/pool.ts')).toBeTruthy();
  expect(within(card).queryByRole('alert')).toBeNull();
});

test('where agents struggle: test files are left out until "include tests" is ticked', async () => {
  render(<Patterns />);
  const card = await screen.findByRole('region', { name: /where agents struggle/i });
  await within(card).findByText('src/db/pool.ts');
  const box = within(card).getByLabelText(/include tests/i) as HTMLInputElement;
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  await waitFor(() => expect(urls).toContain('/api/codemap/hotspots?limit=10&tests=1&misses=1'));
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'shop' } });
  await waitFor(() => expect(urls).toContain('/api/codemap/hotspots?project=shop&limit=10&tests=1&misses=1'));
});

test('a slow all-projects report never replaces the one for the project you picked', async () => {
  const shopOnly = { ...report, repeatGroups: [{ ...report.repeatGroups[0], examples: ['only in shop'] }] };
  const all = heldAnswer(report);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([{ key: 'shop', repoPath: '/x', sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null }]);
    if (url === '/api/patterns') return all.answer();
    if (url === '/api/patterns?project=shop') return Response.json(shopOnly);
    return Response.json([]);
  }));
  render(<Patterns />);
  await waitFor(() => expect(screen.getByRole('option', { name: 'shop' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'shop' } });
  expect(await screen.findByText('only in shop')).toBeTruthy();
  await all.deliver();
  expect(screen.getByText('only in shop')).toBeTruthy();
  expect(screen.queryByText('no tenant scoping')).toBeNull();
});

test('the hotspots table, which scrolls sideways at phone width, can be reached and scrolled by keyboard', async () => {
  const { overflowAll, unreachableScrollers } = await import('./ui/scrollReach.ts');
  onTestFinished(overflowAll());
  const { container } = render(<Patterns />);
  await screen.findByRole('region', { name: 'hotspots table' });
  expect(unreachableScrollers(container).map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
});

test('where agents struggle says it is loading until the hotspots arrive', async () => {
  let answer: (r: Response) => void = () => {};
  const inner = fetch as unknown as (url: string) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn((url: string) => (url.startsWith('/api/codemap/hotspots') ? new Promise<Response>((r) => { answer = r; }) : inner(url))));
  render(<Patterns />);
  const card = await screen.findByRole('region', { name: /where agents struggle/i });
  expect(within(card).getByText('Loading…')).toBeTruthy();
  answer(Response.json([{ projectKey: 'shop', path: 'src/db/pool.ts', churn: 7, misses: 2, dependents: 3, score: 13 }]));
  expect(await within(card).findByText('src/db/pool.ts')).toBeTruthy();
});

test('with nothing yet, causes, the weekly trend and repeats each say so; projects that cannot load say why', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json({ error: 'the store is starting' }, { status: 503 });
    if (url.startsWith('/api/patterns')) return Response.json({ causes: [], weekly: [], repeatGroups: [], preDone: { checks: 0, withGaps: 0, gapsFound: 0 } });
    return Response.json([]);
  }));
  render(<Patterns />);
  expect(await screen.findByText('the store is starting')).toBeTruthy();
  expect(await screen.findByText(/No post-mortems yet/)).toBeTruthy();
  expect(screen.getByText(/No confirmed feedback yet/)).toBeTruthy();
  expect(screen.getByText(/No repeats found/)).toBeTruthy();
  expect(fillWeeks([])).toEqual([]);
});

test('a long trend labels every few weeks and the last, not each one', async () => {
  const weekly = Array.from({ length: 20 }, (_, i) => ({ week: `2026-W${String(i + 10).padStart(2, '0')}`, feedback: 1, repeats: 0 }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.startsWith('/api/patterns') ? { ...report, weekly } : [])));
  const { container } = render(<Patterns />);
  await screen.findByLabelText('2026-W29: 1 feedback, 0 repeats');
  const labels = [...container.querySelectorAll('[aria-hidden="true"].font-mono > span')];
  expect(labels.filter((l) => !l.className.includes('invisible')).map((l) => l.textContent)).toEqual(['W10', 'W13', 'W16', 'W19', 'W22', 'W25', 'W28', 'W29']);
});

test('a keyboard Retry of where agents struggle leaves focus on the card heading, not on the page body', async () => {
  const working = fetch;
  let failing = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (failing && url.startsWith('/api/codemap/hotspots')) return Response.json({ error: 'graph unavailable' }, { status: 503 });
    return working(url, init);
  }));
  render(<main tabIndex={-1}><Patterns /></main>);
  const card = await screen.findByRole('region', { name: /where agents struggle/i });
  const retry = await within(card).findByRole('button', { name: 'Retry' });
  retry.focus();
  failing = false;
  await userEvent.setup().keyboard('{Enter}');
  expect(await within(card).findByText('src/db/pool.ts')).toBeTruthy();
  expect(document.activeElement).toBe(within(card).getByRole('heading', { name: /where agents struggle/i }));
});

test('a failed report says so with a Retry that loads it, clears the error and keeps focus on the page', async () => {
  const working = fetch;
  let failing = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (failing && url.startsWith('/api/patterns')) return Response.json({ error: 'graph unavailable' }, { status: 503 });
    return working(url, init);
  }));
  render(<main tabIndex={-1}><Patterns /></main>);
  expect((await screen.findByRole('alert')).textContent).toMatch(/graph unavailable/);
  failing = false;
  screen.getByRole('button', { name: 'Retry' }).focus();
  await userEvent.setup().keyboard('{Enter}');
  expect(await screen.findByText('no tenant scoping')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('main'));
});

test('a failed project list is retried with the report and its error clears once it loads', async () => {
  const working = fetch;
  let failing = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (failing && url === '/api/projects') throw new Error('api unavailable');
    return working(url, init);
  }));
  render(<Patterns />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/api unavailable/);
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'shop' })).toBeTruthy());
  expect(screen.queryByRole('alert')).toBeNull();
});

test('headings never skip a level: each card is an h2 under the page h1', async () => {
  const { container } = render(<Patterns />);
  await screen.findByText('no tenant scoping');
  await screen.findByText('src/db/pool.ts');
  const levels = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
  expect(levels[0]).toBe(1);
  expect(levels.filter((l, i) => i > 0 && l > levels[i - 1] + 1)).toEqual([]);
});
