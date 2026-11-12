import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { Dashboard, PathLine, queueLine, waitedFor } from './Dashboard.tsx';
import { chatHref, newChatHref } from './links.ts';
import { loopMetrics, loopState } from './testing/loop.ts';

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
  '/api/loop': loopState(),
  '/api/loop/metrics': loopMetrics(),
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
afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals(); });

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

test('ask: on a read-only install the box, starters, suggestions and Ask are off, so nothing reaches a 403', async () => {
  const { OwnerWrites } = await import('./ownerAccess.tsx');
  render(<OwnerWrites.Provider value={false}><Dashboard /></OwnerWrites.Provider>);
  const ask = await region(/^ask$/i);
  const box = within(ask).getByLabelText('question') as HTMLTextAreaElement;
  expect(box.disabled).toBe(true);
  expect((within(ask).getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(ask).getByRole('button', { name: /where should a new api endpoint go/i }) as HTMLButtonElement).disabled).toBe(true);
  const suggested = within(await within(ask).findByRole('list', { name: 'suggested questions' }));
  const hotspot = await suggested.findByRole('button', { name: /src\/db\/pool\.ts/ }) as HTMLButtonElement;
  expect(hotspot.disabled).toBe(true);
  fireEvent.click(hotspot);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(location.hash).toBe('#dashboard');
});

test('the tables that scroll sideways at phone width can be reached and scrolled by keyboard', async () => {
  const { overflowAll, unreachableScrollers } = await import('./ui/scrollReach.ts');
  onTestFinished(overflowAll());
  const { container } = render(<Dashboard />);
  await screen.findByRole('region', { name: 'projects table' });
  await screen.findByRole('region', { name: 'files with misses table' });
  expect(unreachableScrollers(container).map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
});

test('a queue that only runs says none are waiting; a wait of days reads in days', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  expect(waitedFor('2026-11-07T11:00:00Z', now)).toBe('3 d');
  expect(waitedFor('2026-11-08T13:00:00Z', now)).toBe('47 h');
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  expect(queueLine('chats', { waiting: 0, oldestAt: null, running: [{ what: 'conversation c1', since }] })).toBe('Ask queue: none waiting; running conversation c1 for 5 min');
});

test('a pipeline that cannot load shows why in its own section', async () => {
  serve({ '/api/pipeline': new Error('pipeline broke') });
  render(<Dashboard />);
  await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain('pipeline broke'));
  expect(screen.queryByLabelText('inbox, waiting on you')).toBeNull();
});

test('ask: with no conversations yet it says questions are kept here', async () => {
  serve({ '/api/chats': [] });
  render(<Dashboard />);
  const ask = await region(/^ask$/i);
  expect(await within(ask).findByText(/No chats yet: your questions are kept here/)).toBeTruthy();
});

test('the Learning loop card shows this week, the rollback rate and Pause, and an older API without the loop shows none', async () => {
  render(<Dashboard />);
  const card = await screen.findByRole('region', { name: 'Learning loop' });
  expect(await within(card).findByText(/9 applied, 5 proposed/)).toBeTruthy();
  expect(within(card).getByRole('button', { name: 'Pause learning' })).toBeTruthy();
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/loop' ? Response.json({ error: 'not found' }, { status: 404 }) : Response.json((routes as Record<string, unknown>)[url] ?? []))));
  render(<Dashboard />);
  await screen.findByRole('region', { name: 'Now' });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Learning loop' })).toBeNull());
});

test('a section that could not be shown is tried again with the next poll, and shows once the answer is whole', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    serve({ '/api/status': { ...status, models: { classify: null } } });
    render(<Dashboard />);
    const now = await region(/^now$/i);
    expect((await within(now).findByRole('alert')).textContent).toMatch(/could not be shown/i);
    serve();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(within(now).queryByRole('alert')).toBeNull());
    expect(within(now).getByText('classifier')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test('now: a model with no job label is named by its job, one down without a reason says unavailable since when; embeddings and the last worker error', async () => {
  serve({
    '/api/status': {
      ...status,
      models: { chat: { provider: 'codex-cli', ok: false, reason: null, since: '2026-10-24T10:00:00Z' } },
      ollama: { ok: false, reason: null, url: 'http://ollama:11434' },
      worker: { version: '0.7.6', lastBeat: new Date().toISOString(), lastError: 'scan parked' },
    },
  });
  render(<Dashboard />);
  const now = await region(/^now$/i);
  expect(await within(now).findByText('chat')).toBeTruthy();
  expect(within(now).getByText(/^unavailable \(since /)).toBeTruthy();
  expect(within(now).getByText('not answering at http://ollama:11434')).toBeTruthy();
  expect(within(now).getByText(/last error: scan parked/)).toBeTruthy();
  cleanup();
  serve({ '/api/status': { ...status, ollama: { ok: true, reason: null, url: 'http://ollama:11434' } } });
  render(<Dashboard />);
  const embeddings = await within(await region(/^now$/i)).findByText('embeddings');
  expect(embeddings.className).toMatch(/\bok\b|text-ok/);
});

test('a wait under a minute reads in seconds; a queue with no oldest time says only how many wait', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  expect(waitedFor('2026-11-10T11:59:20Z', now)).toBe('40 s');
  expect(queueLine('scans', { waiting: 3, oldestAt: null, running: [] })).toBe('Scan queue: 3 waiting');
});

test('pipeline: a classify backlog the worker counted in full has no plus', async () => {
  serve({ '/api/pipeline': { ...pipeline, classify: { backlog: 12, capped: false }, lessons: { proposed: 3, approved: 7, global: 1 } } });
  render(<Dashboard />);
  expect((await screen.findByLabelText('turns to classify')).textContent).toMatch(/^12$|12(?!\+)/);
  expect(await screen.findByRole('link', { name: '1 global lesson' })).toBeTruthy();
});

test('projects: a scan still queued is dated by its request; a project from an API without link counts shows a dash', async () => {
  const { links: _, ...noLinks } = projects[1];
  serve({ '/api/projects': [{ ...noLinks, lastScan: { ...scan, status: 'queued', finishedAt: null } }] });
  render(<Dashboard />);
  const table = await region(/^projects$/i);
  await waitFor(() => expect(within(table).getByLabelText('links').textContent).toBe('–'));
  expect(within(table).getByText('queued')).toBeTruthy();
});

test('ask: a hotspot with one past miss says so in the singular; a chat still answering says so', async () => {
  serve({
    '/api/codemap/hotspots?limit=8': [{ ...hotspots[0], misses: 1 }],
    '/api/chats': [{ id: 'c1', projectKey: 'acme', title: 'Where do modals live?', provider: 'claude', createdAt: '2026-10-24T10:00:00Z', updatedAt: new Date().toISOString(), pending: true }],
  });
  render(<Dashboard />);
  expect(await screen.findByText(/a hotspot, 1 past miss$/)).toBeTruthy();
  expect(await screen.findByText(/· answering$/)).toBeTruthy();
});

test('a model job this release does not know is listed by the name the worker sent', async () => {
  serve({ '/api/status': { ...status, models: { rerank: ok('ollama:bge') } } });
  render(<Dashboard />);
  expect(await within(await region(/^now$/i)).findByText('rerank')).toBeTruthy();
});

test('with the API down the page shows one alert, not one per section, and every section loads once it answers', async () => {
  // Retries run on fake timers that also follow the clock, so the check below can step well past several of them.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let down = true;
  const working = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (down) throw new TypeError('Failed to fetch'); return working(url, init); }));
  render(<Dashboard retryMs={20} />);
  await waitFor(() => expect(screen.getAllByText('Not loaded yet: shown when the API answers.').length).toBeGreaterThan(4));
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(/Could not reach the Feedback Graph API/);
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(screen.getAllByRole('alert')).toEqual([alert]);
  down = false;
  expect(await screen.findByText('approved "scope every query by tenant"', {}, { timeout: 5000 })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 15000 });
  expect(screen.getAllByText('demo-shop').length).toBeGreaterThan(0);
}, 30000);

test('ask: a suggested question keeps a long path on one line, cut in its folders, never mid file name, with the full path to hover', async () => {
  const path = 'packages/portal/main/src/segments/api/rpc/tools/very/deep/folder/handlers/orderListing.ts';
  render(<PathLine path={path} />);
  const line = screen.getByTitle(path);
  const [folders, file] = [...line.children] as HTMLElement[];
  expect(folders.textContent).toBe(path.slice(0, path.lastIndexOf('/') + 1));
  expect(folders.className).toMatch(/\btruncate\b/);
  expect(file.textContent).toBe('orderListing.ts');
  expect(file.className).toMatch(/\bshrink-0\b/);
  cleanup();
  render(<PathLine path="README.md" />);
  expect(screen.getByTitle('README.md').children).toHaveLength(1);
});

test('now: a job whose Codex runner is off on purpose is neutral, with what to do, and a failing one stays red', async () => {
  serve({ '/api/status': { ...status, models: { scan: { provider: 'codex-cli', ok: false, reason: 'sandbox: nested sandbox startup failed', disabled: true }, docs: { provider: 'codex-cli', ok: false, reason: 'login expired' } } } });
  render(<Dashboard />);
  const now = await region(/^now$/i);
  const off = await within(now).findByText(/^Codex runner off on this machine \(sandbox: nested sandbox startup failed\): paused/);
  expect(off.className).not.toMatch(/bad/);
  expect(off.closest('li')!.innerHTML).not.toMatch(/bad/);
  expect(within(now).getByText('login expired').className).toMatch(/text-bad-text/);
});

test('ask: the starter questions share one row as wide as the box, each cut to fit with its full text as its name and title', async () => {
  render(<Dashboard />);
  const ask = await region(/^ask$/i);
  const row = within(ask).getByRole('group', { name: 'starter questions' });
  expect(row.className).not.toMatch(/flex-wrap/);
  expect(row.className).toMatch(/overflow-x-auto/);
  const chips = within(row).getAllByRole('button');
  expect(chips.length).toBeGreaterThan(1);
  for (const c of chips) {
    expect(c.className).toMatch(/\btruncate\b/);
    expect(c.className).toMatch(/\bflex-1\b.*\bbasis-0\b/);
    expect(c.getAttribute('title')).toBe(c.textContent);
    expect(c.getAttribute('aria-label')).toBe(c.textContent);
  }
  // The box spans the page width like the cards below it: no narrower max width.
  expect(within(ask).getByLabelText('question').closest('form')!.className).not.toMatch(/max-w-/);
});

test('the learning-loop metrics card shows each measure with its n and interval, per week, and rollbacks by type', async () => {
  render(<Dashboard />);
  const card = await region('Learning-loop metrics');
  expect(await within(card).findByLabelText('Gaps fixed per serving')).toBeTruthy();
  expect(within(card).getByLabelText('Gaps fixed per serving').textContent).toBe('Gaps fixed per serving3%1 of 40 servings · 95% 0%–13%');
  expect(within(card).getByLabelText('Not applicable').textContent).toMatch(/40%12 of 30 verdicts/);
  expect(within(card).getByText('last 8 weeks, from 2026-W39')).toBeTruthy();
  expect(within(card).getByText('Proposals per week (6 in all)')).toBeTruthy();
  expect(within(card).getByLabelText('2026-W46: 3 proposals')).toBeTruthy();
  // Only types with something applied, each with its interval.
  expect(within(card).getByText(/Rolled back, by type/).parentElement!.textContent).toBe('Rolled back, by type: retire lesson 1 of 10 (95% 2%–40%)');
});

test('the repeat rate and the checks that caught a gap show once on the Dashboard, in Quality, not again in the metrics card', async () => {
  render(<Dashboard />);
  const card = await region('Learning-loop metrics');
  await within(card).findByLabelText('Not applicable');
  expect(within(card).queryByLabelText(/repeat rate/i)).toBeNull();
  expect(within(card).queryByLabelText(/caught a gap/i)).toBeNull();
  expect(within(card).queryByText(/repeats of/)).toBeNull();
  const quality = await region('Quality');
  expect(await within(quality).findByLabelText('repeat rate')).toBeTruthy();
  expect(screen.getAllByLabelText(/^repeat rate$/i)).toHaveLength(1);
  expect(screen.getAllByLabelText(/^checks that caught a gap$/i)).toHaveLength(1);
});

test('a metrics tile says one check, not one checks, and never cuts its interval', async () => {
  const one = { k: 0, n: 1, rate: 0, ciLow: 0, ciHigh: 0.95 };
  serve({ '/api/loop/metrics': { ...loopMetrics(), gapsFixedPerServed: one, notApplicableShare: one } });
  render(<Dashboard />);
  const card = await region('Learning-loop metrics');
  const tile = await within(card).findByLabelText('Not applicable');
  expect(tile.textContent).toBe('Not applicable0%0 of 1 verdict · 95% 0%–95%');
  expect(within(card).getByLabelText('Gaps fixed per serving').textContent).toMatch(/0 of 1 serving ·/);
  // A half-width tile on a phone wraps the hint rather than cutting it at two lines ("95% 90%–…").
  expect(within(tile).getByText(/0 of 1 verdict/).className).not.toMatch(/line-clamp/);
});

test('the metrics card is quiet before anything is measured, and absent on an API without metrics', async () => {
  serve({ '/api/loop/metrics': loopMetrics(true) });
  render(<Dashboard />);
  const card = await region('Learning-loop metrics');
  expect(await within(card).findByText(/Nothing measured yet/)).toBeTruthy();
  expect(within(card).queryByLabelText('Not applicable')).toBeNull();
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/loop/metrics' ? Response.json({ error: 'no metrics' }, { status: 404 }) : Response.json(routes[url] ?? []))));
  render(<Dashboard />);
  await screen.findByRole('region', { name: 'Learning loop' });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Learning-loop metrics' })).toBeNull());
  expect(screen.queryByText(/could not be shown/)).toBeNull();
});

test('the metrics card waits through an API outage with the rest of the page, and fills in once it answers', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let down = true;
  const working = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (down) throw new TypeError('Failed to fetch'); return working(url, init); }));
  render(<Dashboard retryMs={20} />);
  const card = await region('Learning-loop metrics');
  expect(await within(card).findByText('Not loaded yet: shown when the API answers.')).toBeTruthy();
  expect(within(card).queryByRole('alert')).toBeNull();
  down = false;
  expect(await within(card).findByLabelText('Not applicable', {}, { timeout: 5000 })).toBeTruthy();
}, 30000);

test('ask: with knowledge intake on, "What do we know about …?" leads the starters and leaves the topic to type', async () => {
  serve({ '/api/status': { ...status, intake: { enabled: true } } });
  render(<Dashboard />);
  const ask = await region(/^ask$/i);
  const box = within(ask).getByLabelText('question') as HTMLTextAreaElement;
  fireEvent.click(await within(ask).findByRole('button', { name: 'What do we know about …?' }));
  expect(box.value).toBe('What do we know about ');
  cleanup();
  serve();
  render(<Dashboard />);
  const off = await region(/^ask$/i);
  await within(off).findByRole('button', { name: /where should a new api endpoint go/i });
  expect(within(off).queryByRole('button', { name: 'What do we know about …?' })).toBeNull();
});
