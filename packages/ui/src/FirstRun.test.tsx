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

test('while the Inbox is empty, one line says so and what runs now, and every stage is one press away, linked to its page', async () => {
  render(<FirstRun view="inbox" now={() => NOW} />);
  const panel = await screen.findByRole('region', { name: 'pipeline' });
  const w = within(panel);
  expect(panel.textContent).toMatch(/Nothing in the Inbox yet\. Pushback the classifier finds in your sessions shows up here to confirm\./);
  expect(w.getByRole('link', { name: 'Getting started' }).getAttribute('href')).toBe('#dashboard');
  expect(panel.textContent).toMatch(/Now: Classifying turns: 3 of 50, for 2m 10s/);
  // The stages stay folded, so the panel never fills a phone's first screen.
  expect(w.queryByRole('link', { name: /Sessions read/ })).toBeNull();
  fireEvent.click(w.getByRole('button', { name: 'show stages' }));
  expect(w.getByRole('button', { name: 'hide stages' }).getAttribute('aria-expanded')).toBe('true');
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
  fireEvent.click(within(panel).getByRole('button', { name: 'hide stages' }));
  expect(within(panel).queryByRole('link', { name: /Sessions read/ })).toBeNull();
  cleanup();
  render(<FirstRun view="lessons" now={() => NOW} />);
  expect((await screen.findByRole('region', { name: 'pipeline' })).textContent).toMatch(/No lessons yet\./);
});

test('an empty page says where things stand as steps complete, and stops pointing at Getting started once a lesson is approved', async () => {
  served = pipeline({ inbox: { pending: 0, confirmed: 2 }, lessons: { proposed: 0, approved: 1 } });
  render(<FirstRun view="inbox" now={() => NOW} />);
  const panel = await screen.findByRole('region', { name: 'pipeline' });
  expect(panel.textContent).toMatch(/Nothing waiting for you in the Inbox\./);
  expect(panel.textContent).not.toMatch(/nothing to show|Inbox yet/);
  expect(within(panel).queryByRole('link', { name: 'Getting started' })).toBeNull();
  cleanup();
  served = pipeline({ inbox: { pending: 0, confirmed: 1 }, lessons: null });
  render(<FirstRun view="inbox" now={() => NOW} />);
  expect((await screen.findByRole('region', { name: 'pipeline' })).textContent).toMatch(/Nothing waiting for you in the Inbox\./);
});

test('an empty state filtered to one project asks for that project\'s counts and says what it waits for', async () => {
  served = pipeline({ inbox: { pending: 0, confirmed: 0 } });
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return Response.json(served); }));
  render(<FirstRun view="inbox" project="demo-shop" force now={() => NOW} />);
  const panel = await screen.findByRole('region', { name: 'pipeline' });
  expect(urls).toContain('/api/pipeline?project=demo-shop');
  expect(panel.textContent).toMatch(/demo-shop: Nothing in the Inbox yet/);
  fireEvent.click(within(panel).getByRole('button', { name: 'show stages' }));
  expect(panel.textContent).toMatch(/Counts are for this project/);
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

test('a count with no known total, or none counted of an unknown total, reads plainly', () => {
  expect(stageLine(pipeline({ progress: { done: 4, total: null } }), NOW)).toBe('Classifying turns: 4, for 2m 10s (turn-9)');
  expect(stageLine(pipeline({ progress: { done: 0, total: null } }), NOW)).toBe('Classifying turns, for 2m 10s (turn-9)');
});

test('the folded line names each backlog in the singular or plural it needs, and none when nothing waits', async () => {
  served = pipeline({ inbox: { pending: 3, confirmed: 0 }, classify: { backlog: 1, capped: false }, postmortems: { queued: 1 }, scans: { done: 1, queued: 1, running: 0, failed: 0, never: 0 } });
  const { unmount } = render(<FirstRun view="inbox" now={() => NOW} />);
  expect(await screen.findByText('1 turn to classify · 1 post-mortem queued · 1 scan queued or running')).toBeTruthy();
  unmount();
  served = pipeline({ inbox: { pending: 3, confirmed: 0 }, classify: { backlog: 1, capped: true }, postmortems: { queued: 0 }, scans: { done: 1, queued: 0, running: 0, failed: 0, never: 0 } });
  const second = render(<FirstRun view="inbox" now={() => NOW} />);
  expect(await screen.findByText('1+ turns to classify')).toBeTruthy();
  second.unmount();
  served = pipeline({ inbox: { pending: 3, confirmed: 0 }, classify: { backlog: 0, capped: false }, postmortems: { queued: 0 }, scans: { done: 1, queued: 0, running: 0, failed: 2, never: 0 } });
  render(<FirstRun view="inbox" now={() => NOW} />);
  const line = await screen.findByRole('region', { name: 'pipeline' });
  expect(line.textContent).not.toMatch(/to classify|queued/);
  fireEvent.click(within(line).getByRole('button', { name: 'show stages' }));
  expect(await screen.findByText('1 done, 2 failed')).toBeTruthy();
});

test('a stage this release does not know reads as its name', () => {
  expect(stageLine(pipeline({ stage: { name: 'reindex' as never, startedAt: '2026-10-24T10:02:00Z', current: null }, progress: null }), NOW)).toBe('reindex, for 10s');
});

test('only the step is announced: a new count or a longer time leaves the live region alone, a new step updates it', async () => {
  const { rerender } = render(<FirstRun view="inbox" now={() => NOW} />);
  const panel = await screen.findByRole('region', { name: 'pipeline' });
  const live = within(panel).getByRole('status');
  expect(live.textContent).toBe('Classifying turns');
  const changes: MutationRecord[] = [];
  const watch = new MutationObserver((m) => changes.push(...m));
  watch.observe(live, { childList: true, characterData: true, subtree: true });
  rerender(<FirstRun view="inbox" now={() => NOW + 7000} />);
  expect(panel.textContent).toMatch(/for 2m 17s/);
  await new Promise((r) => setTimeout(r, 0));
  expect(changes).toEqual([]);
  watch.disconnect();
  served = pipeline({ inbox: { pending: 3, confirmed: 0 } });
  cleanup();
  render(<FirstRun view="inbox" now={() => NOW} />);
  expect(within(await screen.findByRole('region', { name: 'pipeline' })).getByRole('status').textContent).toBe('Classifying turns');
  cleanup();
  served = pipeline({ stage: null });
  render(<FirstRun view="inbox" now={() => NOW} />);
  expect(within(await screen.findByRole('region', { name: 'pipeline' })).getByRole('status').textContent).toMatch(/not reporting/);
});
