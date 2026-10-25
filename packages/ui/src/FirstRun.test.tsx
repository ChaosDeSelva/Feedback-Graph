import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PipelineStatus } from '@fb/core';
import { FirstRun, stageLine } from './FirstRun.tsx';

const NOW = Date.parse('2026-10-24T10:02:10Z');
const pipeline = (o: Partial<PipelineStatus> = {}): PipelineStatus => ({
  stage: { name: 'classify', startedAt: '2026-10-24T10:00:00Z', current: 'turn-9' },
  progress: { done: 3, total: 50 },
  sessions: 12,
  classify: { backlog: 1000, capped: true },
  inbox: { pending: 0, confirmed: 0 },
  postmortems: { queued: 2 },
  lessons: { proposed: 0, approved: 0 },
  scans: { done: 1, queued: 4, running: 1, failed: 0, never: 2 },
  ...o,
});

let served: PipelineStatus;
beforeEach(() => {
  served = pipeline();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/pipeline' ? Response.json(served) : Response.json([]))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('while the Inbox is empty, the panel shows every stage, linked to its page, and what runs now and for how long', async () => {
  render(<FirstRun view="inbox" now={() => NOW} />);
  const panel = await screen.findByRole('region', { name: 'pipeline' });
  const w = within(panel);
  expect(w.getByText(/Classifying turns: 3 of 50, for 2m 10s/)).toBeTruthy();
  const row = (name: RegExp) => w.getByRole('link', { name });
  expect(row(/Sessions read\s*12/).getAttribute('href')).toBe('#sessions');
  expect(row(/Turns to classify\s*1000\+/).getAttribute('href')).toBe('#activity/candidate_flagged');
  expect(row(/Inbox, waiting on you\s*0/).getAttribute('href')).toBe('#inbox');
  expect(row(/Post-mortems queued\s*2/).getAttribute('href')).toBe('#inbox/confirmed');
  expect(row(/Lessons\s*0 proposed, 0 approved/).getAttribute('href')).toBe('#lessons');
  expect(row(/Project scans\s*1 done, 1 running, 4 queued, 2 never/).getAttribute('href')).toBe('#projects');
});

test('once a page has something to show, the panel folds to one line: the stage now and the backlog, with the stages on request', async () => {
  served = pipeline({ inbox: { pending: 3, confirmed: 0 } });
  render(<FirstRun view="inbox" now={() => NOW} />);
  const panel = await screen.findByRole('region', { name: 'pipeline' });
  expect(panel.textContent).toMatch(/Classifying turns: 3 of 50/);
  expect(panel.textContent).toMatch(/1000\+ turns to classify/);
  expect(panel.textContent).toMatch(/2 post-mortems queued/);
  expect(within(panel).queryByRole('link', { name: /Sessions read/ })).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'show stages' }));
  expect(within(panel).getByRole('link', { name: /Sessions read\s*12/ })).toBeTruthy();
  cleanup();
  render(<FirstRun view="lessons" now={() => NOW} />);
  expect(await screen.findByText(/nothing to show here yet/)).toBeTruthy();
});

test('an empty state filtered to one project asks for that project\'s counts and shows the whole panel', async () => {
  served = pipeline({ inbox: { pending: 0, confirmed: 0 } });
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return Response.json(served); }));
  render(<FirstRun view="inbox" project="demo-shop" force now={() => NOW} />);
  const panel = await screen.findByRole('region', { name: 'pipeline' });
  expect(urls).toContain('/api/pipeline?project=demo-shop');
  expect(panel.textContent).toMatch(/demo-shop/);
  expect(within(panel).getByRole('link', { name: /Inbox, waiting on you\s*0/ })).toBeTruthy();
});

test('stage lines read plainly, with or without counts, and say when the worker is offline', () => {
  expect(stageLine(pipeline(), NOW)).toBe('Classifying turns: 3 of 50, for 2m 10s (turn-9)');
  expect(stageLine(pipeline({ stage: { name: 'scan', startedAt: '2026-10-24T10:02:00Z', current: 'demo-shop' }, progress: null }), NOW)).toBe('Scanning a project, for 10s (demo-shop)');
  expect(stageLine(pipeline({ stage: { name: 'waiting', startedAt: '2026-10-24T09:02:10Z', current: null }, progress: null }), NOW)).toBe('Waiting for new work, for 1h 0m');
  expect(stageLine(pipeline({ stage: null, progress: null }), NOW)).toBe('The worker is not reporting (offline, or older than this page)');
  // A stage with nothing counted yet never reads "0 of 0".
  expect(stageLine(pipeline({ progress: { done: 0, total: 0 } }), NOW)).toBe('Classifying turns, for 2m 10s (turn-9)');
});
