import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SessionDetail, SessionListItem } from './api.ts';
import { Sessions } from './Sessions.tsx';

const item = (id: string, o: Partial<SessionListItem> = {}): SessionListItem => ({
  id, projectKey: 'demo-shop', source: 'claude', cwd: '/vibe/demo-shop', gitBranch: 'main', startedAt: '2026-10-22T09:00:00.000Z',
  lastActivityAt: '2026-10-22T10:00:00.000Z', turnCount: 8, state: 'idle', snippet: `Goal of ${id}`, summarizedThrough: { index: 7, ts: 't7' },
  summaryUpdatedAt: '2026-10-22T10:20:00.000Z', summaryVersion: 2, pendingTurns: 0, ...o,
});

const s1: SessionDetail = {
  ...item('s1'),
  summary: {
    goal: 'Add an invoices list', done: ['built GET /invoices with paging'], decisions: ['sort by due date, newest first'], openThreads: ['CSV export'],
    filesTouched: ['src/routes/invoices.ts'], pushback: ['forgot tenant scoping'], outcome: 'list works, export left', markdown: '**Goal:** Add an invoices list',
  },
  summaryModel: 'ollama:gemma4',
  history: [
    { version: 1, from: null, to: { index: 3, ts: 't3' }, deltaTurns: 4, model: 'ollama:gemma4', at: '2026-10-22T09:30:00.000Z', rebuild: false },
    { version: 2, from: { index: 3, ts: 't3' }, to: { index: 7, ts: 't7' }, deltaTurns: 4, model: 'ollama:gemma4', at: '2026-10-22T10:20:00.000Z', rebuild: false },
  ],
  rebuildRequested: false, prunedTurns: 0, summaryError: null, summaryRetryAt: null,
  inbox: [{ id: 's1-t5', status: 'confirmed', label: 'pushback', summary: 'missed tenant scoping', lessonId: 'lesson:s1-t5', lessonStatus: 'approved' }],
};
const s2: SessionDetail = { ...item('s2', { snippet: null, summarizedThrough: null, state: 'active', pendingTurns: 3, turnCount: 3, summaryVersion: 0 }), summary: null, summaryModel: null, history: [], rebuildRequested: false, prunedTurns: 0, summaryError: null, summaryRetryAt: null, inbox: [] };

let urls: string[];
let posts: string[];
let resummarize: () => Response;
beforeEach(() => {
  urls = [];
  posts = [];
  location.hash = '';
  resummarize = () => Response.json({ queued: true }, { status: 202 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.method === 'POST') { posts.push(url); return resummarize(); }
    if (url === '/api/projects') return Response.json([{ key: 'demo-shop', repoPath: '/x', sessions: 2, feedback: 0, lessons: 0, facts: 0, lastScan: null }, { key: 'other', repoPath: '/y', sessions: 0, feedback: 0, lessons: 0, facts: 0, lastScan: null }]);
    if (url.startsWith('/api/sessions?') && url.includes('cursor=c2')) return Response.json({ sessions: [item('s3', { snippet: 'Goal of s3' })], next: null });
    if (url.startsWith('/api/sessions')) {
      if (url === '/api/sessions/s1') return Response.json(s1);
      if (url === '/api/sessions/s2') return Response.json(s2);
      if (url === '/api/sessions/s3') return Response.json({ ...s1, ...item('s3') });
      return Response.json({ sessions: [item('s1'), s2], next: 'c2' });
    }
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('lists sessions with their state and opens the newest with its structured summary', async () => {
  render(<Sessions />);
  const list = await screen.findByRole('complementary', { name: 'sessions' });
  expect(await within(list).findByText('Goal of s1')).toBeTruthy();
  expect(within(list).getByText('Not summarized yet')).toBeTruthy();
  expect(within(list).getAllByText('idle').length).toBeGreaterThan(0);
  expect(within(list).getByText('active')).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Add an invoices list' })).toBeTruthy();
  const summary = screen.getByRole('region', { name: 'Summary' });
  expect(within(summary).getByText('built GET /invoices with paging')).toBeTruthy();
  expect(within(summary).getByText('sort by due date, newest first')).toBeTruthy();
  expect(within(summary).getByText('CSV export')).toBeTruthy();
  expect(within(summary).getByText('forgot tenant scoping')).toBeTruthy();
  expect(within(summary).getByText('src/routes/invoices.ts')).toBeTruthy();
  expect(within(summary).getByText('list works, export left')).toBeTruthy();
  expect(screen.getByText(/through turn 7 of 8/)).toBeTruthy();
});

test('the update history and the Inbox items of the session link where they belong', async () => {
  render(<Sessions />);
  const history = await screen.findByRole('region', { name: 'Update history' });
  const rows = within(history).getAllByRole('row');
  expect(rows).toHaveLength(3); // header + two updates, newest first
  expect(rows[1].textContent).toContain('4–7');
  expect(rows[2].textContent).toContain('0–3');
  const flagged = screen.getByRole('region', { name: 'Flagged in this session' });
  expect(within(flagged).getByRole('link', { name: 'missed tenant scoping' }).getAttribute('href')).toBe('#inbox/s1-t5');
  expect(within(flagged).getByRole('link', { name: /lesson/ }).getAttribute('href')).toBe('#lessons/lesson%3As1-t5');
});

test('a session not summarized yet says when it will be', async () => {
  render(<Sessions />);
  fireEvent.click(await screen.findByText('Not summarized yet', { selector: 'div' }));
  expect(await screen.findByText(/once it has been quiet for a few minutes/)).toBeTruthy();
  expect(screen.getByText(/not yet · 3 turns waiting/)).toBeTruthy();
});

test('filters by project and state, and loads the next page with the cursor', async () => {
  render(<Sessions />);
  await screen.findByText('Goal of s1');
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'demo-shop' } });
  fireEvent.change(screen.getByLabelText('state'), { target: { value: 'idle' } });
  await waitFor(() => expect(urls).toContain('/api/sessions?project=demo-shop&state=idle'));
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Goal of s3')).toBeTruthy();
  expect(urls).toContain('/api/sessions?project=demo-shop&state=idle&cursor=c2');
});

test('rebuild queues a resummarize and says so; a refusal shows the server\'s reason', async () => {
  render(<Sessions />);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild summary' }));
  expect(await screen.findByText(/Queued: the worker rebuilds this summary/)).toBeTruthy();
  expect(posts).toEqual(['/api/sessions/s1/resummarize']);
  expect(screen.getByText('rebuild queued')).toBeTruthy();
  // Once queued it takes no more presses, but keeps focus (aria-disabled, not disabled).
  expect(screen.getByRole('button', { name: 'Rebuild summary' }).getAttribute('aria-disabled')).toBe('true');

  cleanup();
  resummarize = () => Response.json({ error: '3 turns of this session had their text removed by TURN_RETENTION_DAYS' }, { status: 409 });
  render(<Sessions />);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild summary' }));
  expect((await screen.findAllByText(/TURN_RETENTION_DAYS/)).length).toBeGreaterThan(0);
});

test('a link to one session (#sessions/<id>) opens it', async () => {
  location.hash = '#sessions/s2';
  render(<Sessions />);
  expect(await screen.findByText(/not yet · 3 turns waiting/)).toBeTruthy();
  expect(urls).toContain('/api/sessions/s2');
  expect(urls).not.toContain('/api/sessions/s1');
});

test('a failed update is shown with when it is tried again, over the last good summary', async () => {
  s1.summaryError = 'the model did not return a valid summary';
  s1.summaryRetryAt = '2026-10-22T11:00:00.000Z';
  try {
    render(<Sessions />);
    expect(await screen.findByText(/The last update failed: the model did not return a valid summary/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Summary' })).toBeTruthy();
  } finally {
    s1.summaryError = null;
    s1.summaryRetryAt = null;
  }
});

/** The fake API, with the given answers in front of it. */
function answering(over: (url: string) => Response | null) {
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => over(url) ?? inner(url, init)));
}

test('an older page that cannot load says why and keeps the sessions already listed', async () => {
  answering((url) => (url.includes('cursor=c2') ? Response.json({ error: 'the store timed out' }, { status: 504 }) : null));
  render(<Sessions />);
  await screen.findByText('Goal of s1');
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText(/the store timed out/)).toBeTruthy();
  expect(screen.getByText('Goal of s1')).toBeTruthy();
});

test('no sessions yet says where they come from; none under a filter offers to clear it', async () => {
  answering((url) => (/^\/api\/sessions(\?|$)/.test(url) ? Response.json({ sessions: [], next: null }) : null));
  render(<Sessions />);
  expect(await screen.findByText('No sessions yet')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  fireEvent.change(screen.getByLabelText('state'), { target: { value: 'idle' } });
  expect(await screen.findByText('No sessions match these filters')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByText('No sessions yet')).toBeTruthy();
  expect((screen.getByLabelText('state') as HTMLSelectElement).value).toBe('');
});

/** The list and detail answers for one test, in front of the default fake. */
function serving(list: SessionListItem[], details: Record<string, SessionDetail>) {
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const m = /^\/api\/sessions\/([^/?]+)$/.exec(url);
    if (m && details[m[1]]) return Response.json(details[m[1]]);
    if (url === '/api/sessions' || url.startsWith('/api/sessions?')) return Response.json({ sessions: list, next: null });
    return inner(url, init);
  }));
}

test('a Codex session with newer turns waiting says so in the list and the detail; times it does not have read unknown', async () => {
  const codex: SessionDetail = {
    ...s1, ...item('s9', { source: 'codex', pendingTurns: 2, lastActivityAt: null, startedAt: null as never, gitBranch: null }),
    summaryUpdatedAt: null, summaryError: 'model down', summaryRetryAt: null, summary: { ...s1.summary!, pushback: [] },
    inbox: [{ id: 's9-t1', status: 'pending', label: null, summary: '', lessonId: null, lessonStatus: null }],
    history: [{ version: 1, from: null, to: { index: 7, ts: 't7' }, deltaTurns: 8, model: 'ollama:gemma4', at: '2026-10-22T09:30:00.000Z', rebuild: true }],
  };
  serving([codex], { s9: codex });
  render(<Sessions />);
  expect(await screen.findByText('2 new')).toBeTruthy();
  expect(screen.getByText('no activity time')).toBeTruthy();
  expect(await screen.findByText('Codex')).toBeTruthy();
  expect(screen.getByText(/through turn 7 of 8 · 2 newer turns waiting/)).toBeTruthy();
  expect(screen.getByText('ollama:gemma4', { selector: 'span' }).parentElement!.textContent).toBe('ollama:gemma4');
  expect((screen.getByText('started').nextElementSibling as HTMLElement).textContent).toBe('unknown');
  expect(screen.getByText(/The last update failed: model down\. The summary below/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 's9-t1' }).getAttribute('href')).toBe('#inbox/s9-t1');
  expect(screen.getByText('rebuild')).toBeTruthy();
  // An empty part of the summary is left out, not shown with no items.
  expect(screen.queryByText('Pushback')).toBeNull();
});

test('a session in a state this release does not know shows the state as stored', async () => {
  const served = vi.mocked(fetch).getMockImplementation()!;
  const archived = item('s9', { state: 'archived' as never });
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === '/api/sessions/s9') return Response.json({ ...s1, ...archived });
    if (String(url).startsWith('/api/sessions')) return Response.json({ sessions: [archived], next: null });
    return served(url, init);
  });
  render(<Sessions />);
  const list = await screen.findByRole('complementary', { name: 'sessions' });
  expect(await within(list).findByText('archived')).toBeTruthy();
  expect(within(list).getByText('archived').getAttribute('title')).toBe('');
});

test('Rebuild summary says Requesting… while the request is in flight and takes no second press', async () => {
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === 'POST') await gate; return inner(url, init); }));
  render(<Sessions />);
  fireEvent.click(await screen.findByRole('button', { name: 'Rebuild summary' }));
  const requesting = await screen.findByRole('button', { name: 'Requesting…' });
  expect(requesting.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(requesting);
  release();
  expect(await screen.findByText(/Queued: the worker rebuilds this summary/)).toBeTruthy();
  expect(posts).toEqual(['/api/sessions/s1/resummarize']);
});
