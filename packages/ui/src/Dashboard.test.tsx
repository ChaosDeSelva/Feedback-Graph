import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from './Dashboard.tsx';
import { newChatHref } from './links.ts';

const ok = (provider: string) => ({ provider, ok: true, reason: null });
const status = {
  version: '0.5.0', store: 'postgres', graph: true, worker: null, workerHealthy: true, authRequired: false, selection: { initialized: true, tracked: 2, roots: 1, note: null },
  models: { classify: { provider: 'ollama:gemma4', ok: false, reason: 'model not found (ollama 404)' }, postmortem: ok('claude-cli'), scan: ok('claude-cli'), summary: { provider: null, ok: true, reason: null, off: true } },
  stage: { name: 'classify', startedAt: new Date(Date.now() - 70_000).toISOString(), current: 'turn-9' }, progress: { done: 3, total: 50 },
};
const pipeline = {
  stage: status.stage, progress: status.progress, sessions: 12, classify: { backlog: 40, capped: true }, inbox: { pending: 5, confirmed: 9 },
  postmortems: { queued: 2 }, lessons: { proposed: 3, approved: 7 }, scans: { done: 4, queued: 1, running: 2, failed: 1, never: 0 },
};
const report = {
  causes: [], repeatGroups: [], preDone: { checks: 8, withGaps: 2, gapsFound: 3 },
  weekly: [{ week: '2026-W40', feedback: 4, repeats: 0 }, { week: '2026-W41', feedback: 3, repeats: 2 }],
};
const scan = { id: 'scan:1', projectKey: 'acme', repoPath: '/r/acme', provider: null, status: 'done', requestedAt: '2026-10-20T10:00:00Z', startedAt: '2026-10-20T10:00:00Z', finishedAt: '2026-10-20T10:05:00Z', filesScanned: 10, factsAdded: 4, error: null, attempts: 0, retryAt: null };
const projects = [
  { key: 'demo-shop', repoPath: '/r/demo-shop', remote: null, aliases: [], sessions: 3, feedback: 2, lessons: 1, facts: 0, lastScan: null, pinned: true, links: 2 },
  { key: 'acme', repoPath: '/r/acme', remote: null, aliases: [], sessions: 9, feedback: 4, lessons: 5, facts: 21, lastScan: scan, pinned: false, links: 0 },
];
const hotspots = [
  { projectKey: 'demo-shop', path: 'src/db/pool.ts', churn: 7, misses: 2, dependents: 3, score: 13 },
  { projectKey: 'acme', path: 'lib/render.ts', churn: 30, misses: 0, dependents: 1, score: 5.95 },
];
const activity = [
  { id: 'a1', ts: new Date(Date.now() - 120_000).toISOString(), kind: 'lesson_decided', actor: 'you', projectKey: 'acme', subject: 'approved "scope every query by tenant"', why: '', details: { status: 'approved' }, targets: [] },
];
const routes: Record<string, unknown> = {
  '/api/status': status, '/api/pipeline': pipeline, '/api/patterns': report, '/api/projects': projects,
  '/api/codemap/hotspots?limit=8': hotspots, '/api/activity?limit=10': activity,
};

let urls: string[];
function serve(over: Record<string, unknown> = {}) {
  urls = [];
  const all = { ...routes, ...over };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    const body = all[url];
    if (body instanceof Error) return Response.json({ error: body.message }, { status: 500 });
    return Response.json(body ?? []);
  }));
}
beforeEach(() => { serve(); location.hash = '#dashboard'; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const region = (name: RegExp | string) => screen.findByRole('region', { name });

test('now: what the worker is doing, for how long, and each model that is down', async () => {
  render(<Dashboard />);
  const now = await region(/^now$/i);
  expect(await within(now).findByText(/Classifying turns: 3 of 50, for 1m 1\ds \(turn-9\)/)).toBeTruthy();
  expect(within(now).getByText(/model not found \(ollama 404\)/)).toBeTruthy();
  expect(within(now).getAllByText('claude-cli').length).toBe(2);
  // A job turned off on purpose is not listed as a model.
  expect(within(now).queryByText(/summary/i)).toBeNull();
});

test('pipeline tiles: inbox, classify backlog, post-mortems, lessons and scans', async () => {
  render(<Dashboard />);
  await waitFor(() => expect(screen.getByLabelText('inbox, waiting on you').textContent).toContain('5'));
  expect(screen.getByLabelText('turns to classify').textContent).toContain('40+');
  expect(screen.getByLabelText('post-mortems queued').textContent).toContain('2');
  expect(screen.getByLabelText('lessons').textContent).toContain('3 / 7');
  // Running scans are their own number, never counted as queued.
  expect(screen.getByLabelText('scans').textContent).toContain('4 / 1 / 2 / 1');
  expect(screen.getByLabelText('scans').textContent).toContain('done / queued / running / failed');
});

test('each backlog tile links to where that backlog is shown', async () => {
  render(<Dashboard />);
  await waitFor(() => expect(screen.getByLabelText('turns to classify').textContent).toContain('40+'));
  const href = (label: string) => screen.getByLabelText(label).closest('a')!.getAttribute('href');
  // Confirmed items are what wait for post-mortems: the Inbox's confirmed tab shows each one's post-mortem state.
  expect(href('post-mortems queued')).toBe('#inbox/confirmed');
  // The classifier's output, with the backlog shown on top.
  expect(href('turns to classify')).toBe('#activity/candidate_flagged');
});

test('quality: the repeat rate, the pre-done catch rate and the weekly chart', async () => {
  render(<Dashboard />);
  const q = await region(/quality/i);
  await waitFor(() => expect(within(q).getByLabelText('repeat rate').textContent).toContain('29%'));
  expect(within(q).getByLabelText('checks that caught a gap').textContent).toContain('25%');
  expect(within(q).getByLabelText(/2026-W41: 3 feedback, 2 repeats/)).toBeTruthy();
});

test('projects: pinned first, with sessions, lessons, facts, last scan and confirmed links', async () => {
  render(<Dashboard />);
  const card = await region(/projects/i);
  const rows = await within(card).findAllByRole('row');
  expect(rows[1].textContent).toContain('demo-shop');
  expect(rows[1].textContent).toContain('pinned');
  expect(within(rows[2]).getByText('21')).toBeTruthy();
  expect(within(rows[2]).getByText(/done/)).toBeTruthy();
  expect(within(rows[1]).getByLabelText('links').textContent).toBe('2');
  expect(within(rows[1]).getByText('never')).toBeTruthy();
});

test('hotspots: the top 8, each linking to its module panel on the Projects page', async () => {
  render(<Dashboard />);
  const card = await region(/hotspots/i);
  expect((await within(card).findByRole('link', { name: 'src/db/pool.ts' })).getAttribute('href')).toBe('#projects/demo-shop/src%2Fdb%2Fpool.ts');
  expect(within(card).getByRole('link', { name: 'lib/render.ts' }).getAttribute('href')).toBe('#projects/acme/lib%2Frender.ts');
  expect(urls).toContain('/api/codemap/hotspots?limit=8');
});

test('recent activity: the last 10 entries', async () => {
  render(<Dashboard />);
  const card = await region(/recent activity/i);
  expect(await within(card).findByText('approved "scope every query by tenant"')).toBeTruthy();
  expect(within(card).getAllByText('lesson decision').length).toBeGreaterThan(0);
  expect(urls).toContain('/api/activity?limit=10');
});

test('a failing endpoint shows its error in its own section; the rest still renders', async () => {
  serve({ '/api/patterns': new Error('patterns broke'), '/api/codemap/hotspots?limit=8': new Error('no map store'), '/api/status': new Error('status broke') });
  render(<Dashboard />);
  expect((await within(await region(/quality/i)).findByRole('alert')).textContent).toBe('patterns broke');
  expect((await within(await region(/hotspots/i)).findByRole('alert')).textContent).toBe('no map store');
  await waitFor(() => expect(within(screen.getByRole('region', { name: /^now$/i })).getByRole('alert').textContent).toBe('status broke'));
  expect(await screen.findByText('approved "scope every query by tenant"')).toBeTruthy();
  expect(screen.getByLabelText('inbox, waiting on you').textContent).toContain('5');
  expect(screen.getAllByText('demo-shop').length).toBeGreaterThan(0);
});

test('with nothing selected every section says it is empty instead of failing', async () => {
  serve({
    '/api/status': { ...status, selection: { initialized: true, tracked: 0, roots: 1, note: 'none' }, stage: null, progress: null, models: null },
    '/api/pipeline': { stage: null, progress: null, sessions: null, classify: null, inbox: null, postmortems: null, lessons: null, scans: null },
    '/api/patterns': { causes: [], repeatGroups: [], preDone: { checks: 0, withGaps: 0, gapsFound: 0 }, weekly: [] },
    '/api/projects': [], '/api/codemap/hotspots?limit=8': [], '/api/activity?limit=10': [],
  });
  render(<Dashboard />);
  const card = await region(/projects/i);
  expect(await within(card).findByRole('link', { name: 'Settings' })).toBeTruthy();
  expect(within(await region(/hotspots/i)).getByText(/no code map yet/i)).toBeTruthy();
  expect(within(await region(/recent activity/i)).getByText(/nothing has happened yet/i)).toBeTruthy();
  expect(screen.getByLabelText('inbox, waiting on you').textContent).toContain('–');
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
});

test('an answer of an unexpected shape breaks only its own section', async () => {
  serve({ '/api/codemap/hotspots?limit=8': { not: 'a list' } });
  render(<Dashboard />);
  expect((await within(await region(/hotspots/i)).findByRole('alert')).textContent).toMatch(/this section could not be shown/i);
  expect(await screen.findByText('approved "scope every query by tenant"')).toBeTruthy();
});

test('ask: picks a project and a question, then opens a new chat on the Ask page', async () => {
  render(<Dashboard />);
  const card = await region(/^ask$/i);
  const button = within(card).getByRole('button', { name: 'Ask' }) as HTMLButtonElement;
  await waitFor(() => expect((within(card).getByLabelText('ask project') as HTMLSelectElement).value).toBe('demo-shop'));
  expect(button.disabled).toBe(true);
  fireEvent.change(within(card).getByLabelText('ask project'), { target: { value: 'acme' } });
  fireEvent.change(within(card).getByLabelText('question'), { target: { value: 'add a modal / dialog?' } });
  fireEvent.click(button);
  expect(location.hash).toBe(newChatHref('acme', 'add a modal / dialog?'));
  expect(location.hash).toContain('project=acme');
});
