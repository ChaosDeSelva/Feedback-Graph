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
  expect((screen.getByRole('button', { name: 'Rebuild summary' }) as HTMLButtonElement).disabled).toBe(true);

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
