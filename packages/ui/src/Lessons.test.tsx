import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Lessons } from './Lessons.tsx';

const lesson = (id: string, title: string) => ({
  id, projectKey: 'demo', title, rule: `${title} rule`, appliesWhen: 'search work', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: 'context_available_ignored', missId: 'm', createdAt: '2026-10-01T10:00:00Z', decidedAt: null,
});
const detail = (id: string, title: string) => ({
  lesson: lesson(id, title),
  miss: { id: 'm', missed: 'filtered on the client', cause: 'context_available_ignored', causeExplanation: 'CLAUDE.md said server' },
  feedback: { id: 'f', text: "this isn't good enough", status: 'approved', sessionId: 's1', ts: '2026-10-01T10:00:00Z' },
  contextItems: [{ kind: 'claude_md', ref: 'CLAUDE.md', excerpt: 'filter on the server', why: 'stated rule', wasAvailable: true }],
  fixCommits: [{ sha: 'abc1234def', ts: 't', subject: 'move filter to API' }],
  supersedes: [],
});

let patches: { url: string; body: unknown }[];
beforeEach(() => {
  patches = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { patches.push({ url, body: JSON.parse(init.body as string) }); return new Response(null, { status: 204 }); }
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search'), lesson('l2', 'Auth checks')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    if (url === '/api/lessons/l2') return Response.json(detail('l2', 'Auth checks'));
    if (url.startsWith('/api/activity?target=l1')) return Response.json([{ id: 'a', ts: '2026-10-22T20:00:00Z', kind: 'postmortem_done', actor: 'claude-cli', projectKey: 'demo', subject: 'missed: filtered on the client', why: 'the CLAUDE.md rule was never read', details: {}, targets: [] }]);
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('shows the evidence chain for the selected lesson', async () => {
  render(<Lessons />);
  expect(await screen.findByText('filtered on the client')).toBeTruthy();
  expect(screen.getByText(/isn't good enough/)).toBeTruthy();
  expect(screen.getByText('filter on the server')).toBeTruthy();
  expect(screen.getByText(/was available/i)).toBeTruthy();
  expect(screen.getByText(/move filter to API/)).toBeTruthy();
});

test('approve sends edited fields with the status', async () => {
  render(<Lessons />);
  const rule = (await screen.findByLabelText('rule')) as HTMLTextAreaElement;
  await waitFor(() => expect(rule.value).toBe('Server search rule'));
  fireEvent.change(rule, { target: { value: 'Always filter on the server' } });
  fireEvent.change(screen.getByLabelText('scope'), { target: { value: 'global' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { status: 'approved', rule: 'Always filter on the server', scope: 'global' } }]));
  expect(await screen.findByText('Auth checks', { selector: 'h2' })).toBeTruthy();
});

test('reject sends only the status', async () => {
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { status: 'rejected' } }]));
});

test('lesson history shows how the lesson was produced', async () => {
  render(<Lessons />);
  expect(await screen.findByText('the CLAUDE.md rule was never read')).toBeTruthy();
  expect(screen.getByText(/claude-cli/)).toBeTruthy();
});

test('an approved lesson can be revoked, so agents stop getting it', async () => {
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'approved' }));
  fireEvent.click(await screen.findByRole('button', { name: /revoke/i }));
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { status: 'rejected' } }]));
});

test('a rejected lesson can be put back up for review', async () => {
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'rejected' }));
  fireEvent.click(await screen.findByRole('button', { name: /back to proposed/i }));
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { status: 'proposed' } }]));
});

test('the server\'s reason is shown when a change is refused', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Response.json({ error: 'this lesson has no known project, so it cannot be narrowed' }, { status: 409 });
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    return Response.json([]);
  }));
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/cannot be narrowed/)).toBeTruthy();
});

test('a slow answer for the previous lesson never replaces the one you moved to', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search'), lesson('l2', 'Auth checks')]);
    if (url === '/api/lessons/l1') { await new Promise((r) => setTimeout(r, 120)); return Response.json(detail('l1', 'Server search')); }
    if (url === '/api/lessons/l2') return Response.json(detail('l2', 'Auth checks'));
    return Response.json([]);
  }));
  render(<Lessons />);
  fireEvent.click(await screen.findByText('Auth checks'));
  await waitFor(() => expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Auth checks'));
  await new Promise((r) => setTimeout(r, 160));
  expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Auth checks');
});

test('a #lessons/<id> link opens that lesson, in the tab of its status', async () => {
  location.hash = '#lessons/l2';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?status=approved')) return Response.json([{ ...lesson('l1', 'Server search'), status: 'approved' }, { ...lesson('l2', 'Auth checks'), status: 'approved' }]);
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l9', 'Something proposed')]);
    if (url === '/api/lessons/l9') return Response.json(detail('l9', 'Something proposed'));
    if (url === '/api/lessons/l1') return Response.json({ ...detail('l1', 'Server search'), lesson: { ...lesson('l1', 'Server search'), status: 'approved' } });
    if (url === '/api/lessons/l2') return Response.json({ ...detail('l2', 'Auth checks'), lesson: { ...lesson('l2', 'Auth checks'), status: 'approved' } });
    return Response.json([]);
  }));
  try {
    render(<Lessons />);
    expect(await screen.findByRole('heading', { name: 'Auth checks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'approved' }).getAttribute('aria-pressed')).toBe('true');
  } finally {
    location.hash = '';
  }
});

test('moving to another lesson or tab with unsaved edits asks first, and keeps them if you stay', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    render(<Lessons />);
    const rule = (await screen.findByLabelText('rule')) as HTMLTextAreaElement;
    await waitFor(() => expect(rule.value).toBe('Server search rule'));
    fireEvent.change(rule, { target: { value: 'Always filter on the server' } });
    fireEvent.click(screen.getByText('Auth checks'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('rule') as HTMLTextAreaElement).value).toBe('Always filter on the server');
    fireEvent.click(screen.getByRole('button', { name: 'approved' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'proposed' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('rule') as HTMLTextAreaElement).value).toBe('Always filter on the server');

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('Auth checks'));
    await waitFor(() => expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Auth checks'));
    // No edits now: moving on does not ask.
    fireEvent.click(screen.getByText('Server search'));
    await waitFor(() => expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Server search'));
    expect(confirm).toHaveBeenCalledTimes(3);
  } finally {
    confirm.mockRestore();
  }
});

test('an error goes away once the next change succeeds', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (fail) { fail = false; return Response.json({ error: 'graph unreachable' }, { status: 503 }); }
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search'), lesson('l2', 'Auth checks')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    if (url === '/api/lessons/l2') return Response.json(detail('l2', 'Auth checks'));
    return Response.json([]);
  }));
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
  expect((await screen.findAllByText(/graph unreachable/)).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(screen.queryByText(/graph unreachable/)).toBeNull());
});
