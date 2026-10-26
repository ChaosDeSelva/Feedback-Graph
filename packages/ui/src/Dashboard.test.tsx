import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from './Dashboard.tsx';
import { chatHref, newChatHref } from './links.ts';

const ok = (provider: string) => ({ provider, ok: true, reason: null });
const status = {
  version: '0.5.0', store: 'postgres', graph: true, worker: null, workerHealthy: true, authRequired: false, selection: { initialized: true, tracked: 2, roots: 1, note: null },
  models: { classify: { provider: 'ollama:gemma4', ok: false, reason: 'model not found (ollama 404)' }, postmortem: ok('claude-cli'), scan: ok('claude-cli'), summary: { provider: null, ok: true, reason: null, off: true } },
  stage: { name: 'classify', startedAt: new Date(Date.now() - 70_000).toISOString(), current: 'turn-9' }, progress: { done: 3, total: 50 },
};
const pipeline = {
  stage: status.stage, progress: status.progress, sessions: 12, classify: { backlog: 40, capped: true }, inbox: { pending: 5, confirmed: 9 },
  postmortems: { queued: 2 }, lessons: { proposed: 3, approved: 7, global: 4 }, scans: { done: 4, queued: 1, running: 2, failed: 1, never: 0 },
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
  '/api/codemap/hotspots?limit=8': hotspots, '/api/codemap/hotspots?limit=8&misses=1': hotspots.filter((h) => h.misses > 0), '/api/activity?limit=10': activity,
  '/api/chats': [
    { id: 'c1', projectKey: 'acme', title: 'Where do modals live?', provider: 'claude', createdAt: '2026-10-24T10:00:00Z', updatedAt: new Date(Date.now() - 3_600_000).toISOString(), pending: false },
  ],
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

test('pipeline: a line per busy queue says how many wait, the oldest wait, and what runs now for how long', async () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  serve({ '/api/pipeline': { ...pipeline, queues: {
    scans: {
      waiting: 7, oldestAt: ago(125), running: [{ what: 'big', since: ago(14), shards: { done: 11, total: 40 } }],
      projects: [{ project: 'big', status: 'running', since: ago(14), shards: { done: 11, total: 40 } }],
    },
    classify: { waiting: 40, capped: true, oldestAt: ago(190), running: [] },
    postmortems: { waiting: 2, oldestAt: ago(10), running: [{ what: 'fb-1', since: ago(3) }] },
    // Nothing waits or runs: no line.
    chats: { waiting: 0, oldestAt: null, running: [] },
  } } });
  render(<Dashboard />);
  const queues = await screen.findByRole('list', { name: 'queues' });
  const lines = within(queues).getAllByRole('listitem').map((li) => li.textContent);
  expect(lines).toEqual([
    'Scan queue: 7 waiting, oldest 2 h; running shard 12/40 of big for 14 min',
    'Classify queue: 40+ waiting, oldest at least 3 h',
    'Post-mortem queue: 2 waiting, oldest 10 min; running fb-1 for 3 min',
  ]);
});

test('pipeline: no queue line from an API without queues, or when every queue is empty', async () => {
  render(<Dashboard />);
  await waitFor(() => expect(screen.getByLabelText('turns to classify').textContent).toContain('40+'));
  expect(screen.queryByRole('list', { name: 'queues' })).toBeNull();
  cleanup();
  const empty = { waiting: 0, oldestAt: null, running: [] };
  serve({ '/api/pipeline': { ...pipeline, queues: { scans: { ...empty, projects: [] }, classify: empty, postmortems: empty, chats: null } } });
  render(<Dashboard />);
  await waitFor(() => expect(screen.getByLabelText('turns to classify').textContent).toContain('40+'));
  expect(screen.queryByRole('list', { name: 'queues' })).toBeNull();
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

test('where agents struggle: only files with misses, each linking to its module panel on the Projects page', async () => {
  render(<Dashboard />);
  const card = await region(/where agents struggle/i);
  expect((await within(card).findByRole('link', { name: 'src/db/pool.ts' })).getAttribute('href')).toBe('#projects/demo-shop/src%2Fdb%2Fpool.ts');
  // A busy file no miss touched is a hotspot, not a struggle.
  expect(within(card).queryByRole('link', { name: 'lib/render.ts' })).toBeNull();
  expect(urls).toContain('/api/codemap/hotspots?limit=8&misses=1');
});

test('where agents struggle, with no file missed yet, says so and links the hotspots', async () => {
  serve({ '/api/codemap/hotspots?limit=8&misses=1': [] });
  render(<Dashboard />);
  const card = await region(/where agents struggle/i);
  expect(await within(card).findByText(/no files with misses yet/i)).toBeTruthy();
  expect(within(card).getByRole('link', { name: /hotspots/i }).getAttribute('href')).toBe('#projects');
});

test('projects: 10 at a time, then all of them on request; the global lessons are counted under the table', async () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ ...projects[1], key: `p${String(i).padStart(2, '0')}` }));
  serve({ '/api/projects': many });
  render(<Dashboard />);
  const card = await region(/projects/i);
  await within(card).findByText('p00');
  expect(within(card).getAllByRole('row')).toHaveLength(11);
  fireEvent.click(within(card).getByRole('button', { name: 'Show all 14' }));
  expect(within(card).getAllByRole('row')).toHaveLength(15);
  expect(await within(card).findByText(/4 global lessons/)).toBeTruthy();
});

test('recent activity: the last 10 entries', async () => {
  render(<Dashboard />);
  const card = await region(/recent activity/i);
  expect(await within(card).findByText('approved "scope every query by tenant"')).toBeTruthy();
  expect(within(card).getAllByText('lesson decision').length).toBeGreaterThan(0);
  expect(urls).toContain('/api/activity?limit=10');
});

test('a failing endpoint shows its error in its own section; the rest still renders', async () => {
  serve({ '/api/patterns': new Error('patterns broke'), '/api/codemap/hotspots?limit=8&misses=1': new Error('no map store'), '/api/status': new Error('status broke') });
  render(<Dashboard />);
  expect((await within(await region(/quality/i)).findByRole('alert')).textContent).toBe('patterns broke');
  expect((await within(await region(/where agents struggle/i)).findByRole('alert')).textContent).toBe('no map store');
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
    '/api/projects': [], '/api/codemap/hotspots?limit=8': [], '/api/codemap/hotspots?limit=8&misses=1': [], '/api/activity?limit=10': [],
  });
  render(<Dashboard />);
  const card = await region(/projects/i);
  expect(await within(card).findByRole('link', { name: 'Settings' })).toBeTruthy();
  expect(within(await region(/where agents struggle/i)).getByText(/no files with misses yet/i)).toBeTruthy();
  expect(within(await region(/recent activity/i)).getByText(/nothing has happened yet/i)).toBeTruthy();
  expect(screen.getByLabelText('inbox, waiting on you').textContent).toContain('–');
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
});

test('an answer of an unexpected shape breaks only its own section', async () => {
  serve({ '/api/codemap/hotspots?limit=8&misses=1': { not: 'a list' } });
  render(<Dashboard />);
  expect((await within(await region(/where agents struggle/i)).findByRole('alert')).textContent).toMatch(/this section could not be shown/i);
  expect(await screen.findByText('approved "scope every query by tenant"')).toBeTruthy();
});

test('ask comes first, front and centre: one box, then the status cards', async () => {
  render(<Dashboard />);
  const ask = await region(/^ask$/i);
  const now = await region(/^now$/i);
  expect(ask.compareDocumentPosition(now) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(ask).getByRole('heading', { name: /what do you want to build/i })).toBeTruthy();
});

test('ask: Enter sends the question; Shift+Enter is a new line', async () => {
  render(<Dashboard />);
  const ask = await region(/^ask$/i);
  await waitFor(() => expect((within(ask).getByLabelText('ask project') as HTMLSelectElement).value).toBe('demo-shop'));
  const box = within(ask).getByLabelText('question');
  fireEvent.change(box, { target: { value: 'where do forms live' } });
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
  expect(location.hash).toBe('#dashboard');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(location.hash).toBe(newChatHref('demo-shop', 'where do forms live'));
});

test('ask: a starter question fills the box to edit, and a hotspot suggests a question about that file', async () => {
  render(<Dashboard />);
  const ask = await region(/^ask$/i);
  const box = within(ask).getByLabelText('question') as HTMLTextAreaElement;
  fireEvent.click(within(ask).getByRole('button', { name: /where should a new api endpoint go/i }));
  expect(box.value).toMatch(/where should a new api endpoint go/i);
  expect(location.hash).toBe('#dashboard');
  const suggested = within(await within(ask).findByRole('list', { name: 'suggested questions' }));
  fireEvent.click(await suggested.findByRole('button', { name: /src\/db\/pool\.ts/ }));
  expect(location.hash).toContain('project=demo-shop');
  expect(decodeURIComponent(location.hash)).toContain('src/db/pool.ts');
});

test('ask: recent chats link back to their conversation', async () => {
  render(<Dashboard />);
  const ask = await region(/^ask$/i);
  const recent = within(await within(ask).findByRole('list', { name: 'recent chats' }));
  const link = await recent.findByRole('link', { name: /Where do modals live\?/ });
  expect(link.getAttribute('href')).toBe(chatHref('c1'));
  expect(link.textContent).toContain('acme');
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

test('ask: the model to answer with can be chosen here too, and goes with the question to the Ask page', async () => {
  render(<Dashboard />);
  const card = await region(/^ask$/i);
  await waitFor(() => expect((within(card).getByLabelText('ask project') as HTMLSelectElement).value).toBe('demo-shop'));
  const model = within(card).getByLabelText('ask provider') as HTMLSelectElement;
  expect(model.value).toBe('');
  expect([...model.options].map((o) => o.textContent)).toEqual(['Default model', 'Claude', 'Codex', 'Local model']);
  fireEvent.change(model, { target: { value: 'codex' } });
  fireEvent.change(within(card).getByLabelText('question'), { target: { value: 'where do routes go?' } });
  fireEvent.click(within(card).getByRole('button', { name: 'Ask' }));
  expect(location.hash).toBe(newChatHref('demo-shop', 'where do routes go?', 'codex'));
  expect(location.hash).toContain('provider=codex');
});
