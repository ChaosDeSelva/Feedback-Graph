import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Inbox } from './Inbox.tsx';

const cand = (id: string, summary: string) => ({
  id, turnUuid: id, sessionId: 's', projectKey: 'demo',
  classification: { label: 'pushback', confidence: 0.9, summary, signals: ['x'] },
  status: 'pending', createdAt: '2026-10-01T10:00:00Z', decidedAt: null, note: null,
});
const detail = (id: string) => ({
  candidate: cand(id, `summary ${id}`),
  turn: { uuid: id, sessionId: 's', ts: '2026-10-01T10:00:00Z', index: 2, text: `turn text ${id}`, precedingAssistantText: 'I finished it', precedingToolCalls: [{ name: 'Edit', ts: 't', filePath: '/a.ts' }] },
  before: [], after: [], commits: [{ sha: 'abcdef1234', ts: 't', subject: 'fix thing' }],
});

let posts: { url: string; body: unknown }[];

beforeEach(() => {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body as string) });
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/candidates?')) return Response.json([cand('c1', 'first miss'), cand('c2', 'second miss')]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json(detail(m[1]));
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('renders pending candidates and the first detail', async () => {
  render(<Inbox />);
  expect(await screen.findByText('first miss')).toBeTruthy();
  expect(screen.getByText('second miss')).toBeTruthy();
  expect(await screen.findByText('turn text c1')).toBeTruthy();
  expect(screen.getByText('/a.ts', { exact: false })).toBeTruthy();
});

test('Confirm posts confirmed for the selected id and moves to the next', async () => {
  render(<Inbox />);
  await screen.findByText('turn text c1');
  fireEvent.click(screen.getByRole('button', { name: /^confirm c$/i }));
  await waitFor(() => expect(posts).toEqual([{ url: '/api/candidates/c1/decision', body: { status: 'confirmed' } }]));
  expect(await screen.findByText('turn text c2')).toBeTruthy();
});

test('pressing r rejects the selected candidate', async () => {
  render(<Inbox />);
  await screen.findByText('turn text c1');
  fireEvent.keyDown(window, { key: 'r' });
  await waitFor(() => expect(posts[0]).toEqual({ url: '/api/candidates/c1/decision', body: { status: 'rejected' } }));
});

test('j moves the selection down', async () => {
  render(<Inbox />);
  await screen.findByText('turn text c1');
  fireEvent.keyDown(window, { key: 'j' });
  expect(await screen.findByText('turn text c2')).toBeTruthy();
});

test('Cmd+C and Ctrl+R are left to the browser, never taken as decisions', async () => {
  render(<Inbox />);
  await screen.findByText('turn text c1');
  fireEvent.keyDown(window, { key: 'c', metaKey: true });
  fireEvent.keyDown(window, { key: 'r', ctrlKey: true });
  fireEvent.keyDown(window, { key: 'c', altKey: true });
  await new Promise((r) => setTimeout(r, 20));
  expect(posts).toEqual([]);
});

function slowDetails(delays: Record<string, number>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(init.body as string) }); return new Response(null, { status: 204 }); }
    if (url.startsWith('/api/candidates?')) return Response.json([cand('c1', 'first miss'), cand('c2', 'second miss')]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) { await new Promise((r) => setTimeout(r, delays[m[1]] ?? 0)); return Response.json(detail(m[1])); }
    return Response.json([]);
  }));
}

test('a decision key does nothing until the item you are deciding on has loaded', async () => {
  slowDetails({ c1: 80 });
  render(<Inbox />);
  await screen.findByText('first miss');
  fireEvent.keyDown(window, { key: 'c' });
  await screen.findByText('turn text c1');
  expect(posts).toEqual([]);
});

test('a slow answer for the previous item never replaces the one you moved to', async () => {
  slowDetails({ c1: 120, c2: 0 });
  render(<Inbox />);
  await screen.findByText('first miss');
  fireEvent.keyDown(window, { key: 'j' });
  expect(await screen.findByText('turn text c2')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 160));
  expect(screen.queryByText('turn text c1')).toBeNull();
});

test('a confirmed item whose post-mortem gave up says why and can be retried', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(init.body as string) }); return new Response(null, { status: 204 }); }
    if (url.startsWith('/api/candidates?')) return Response.json([{ ...cand('c1', 'first miss'), status: 'confirmed' }]);
    if (url === '/api/candidates/c1') return Response.json({ ...detail('c1'), postmortem: { done: false, attempts: 5, lastError: 'ollama timed out', retryAt: null, gaveUp: true } });
    return Response.json([]);
  }));
  render(<Inbox />);
  fireEvent.click(await screen.findByRole('button', { name: 'confirmed' }));
  expect(await screen.findByText(/ollama timed out/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /retry post-mortem/i }));
  await waitFor(() => expect(posts).toEqual([{ url: '/api/feedback/c1/retry', body: {} }]));
});

test('an #inbox/<id> link opens that item, in the tab of its status', async () => {
  location.hash = '#inbox/c2';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/candidates?status=confirmed')) return Response.json([{ ...cand('c1', 'first miss'), status: 'confirmed' }, { ...cand('c2', 'second miss'), status: 'confirmed' }]);
    if (url.startsWith('/api/candidates?')) return Response.json([cand('c9', 'pending one')]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json({ ...detail(m[1]), candidate: { ...detail(m[1]).candidate, status: 'confirmed' } });
    return Response.json([]);
  }));
  try {
    render(<Inbox />);
    expect(await screen.findByText('turn text c2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'confirmed' }).getAttribute('aria-pressed')).toBe('true');
  } finally {
    location.hash = '';
  }
});

function emptyServer(status: object) {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body as string) });
      return Response.json({ requeued: 3 });
    }
    if (url === '/api/status') return Response.json(status);
    return Response.json([]);
  }));
}

test('an empty inbox with nothing selected points to Settings', async () => {
  emptyServer({ selection: { initialized: true, tracked: 0, note: 'No projects are selected yet, so no sessions are being read.' }, givenUpTurns: 0 });
  render(<Inbox />);
  expect(await screen.findByText(/no projects are selected/i)).toBeTruthy();
  expect(screen.getByRole('link', { name: /open settings/i }).getAttribute('href')).toBe('#settings');
});

test('an empty inbox with no project folder at all says to add one in Settings first', async () => {
  emptyServer({ selection: { initialized: true, tracked: 0, roots: 0, note: 'No project folders yet: add a project folder in Settings first.' }, givenUpTurns: 0 });
  render(<Inbox />);
  expect(await screen.findByText('No project folders yet')).toBeTruthy();
  expect(screen.getByText(/add a project folder in Settings first/i)).toBeTruthy();
  expect(screen.getByRole('link', { name: /open settings/i }).getAttribute('href')).toBe('#settings');
});

test('an empty inbox offers to re-queue turns the classifier gave up on', async () => {
  emptyServer({ selection: { initialized: true, tracked: 2, note: null }, givenUpTurns: 3 });
  render(<Inbox />);
  const button = await screen.findByRole('button', { name: /re-queue 3 turns that were given up/i });
  fireEvent.click(button);
  await waitFor(() => expect(posts).toEqual([{ url: '/api/turns/requeue', body: {} }]));
  expect(await screen.findByText(/3 turns re-queued/i)).toBeTruthy();
});

test('an empty inbox with projects selected and nothing given up shows the usual hint', async () => {
  emptyServer({ selection: { initialized: true, tracked: 2, note: null }, givenUpTurns: 0 });
  render(<Inbox />);
  expect(await screen.findByText('No feedback waiting')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /re-queue/i })).toBeNull();
  expect(screen.queryByRole('link', { name: /open settings/i })).toBeNull();
});

test('a long Inbox comes a page at a time: it says more are waiting, and Load more appends the next page', async () => {
  const urls: string[] = [];
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ ...cand(`c${from + i}`, `miss number ${from + i}`), createdAt: `2026-10-01T10:${String(from + i).padStart(2, '0')}:00Z` }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/candidates?status=pending&limit=200') return Response.json(page(0, 3), { headers: { 'x-next-offset': '200' } });
    if (url === '/api/candidates?status=pending&limit=200&offset=200') return Response.json(page(3, 2));
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json(detail(m[1]));
    return Response.json([]);
  }));
  render(<Inbox />);
  await screen.findByText('miss number 0');
  expect(screen.getByText(/3 items, more waiting/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('miss number 4')).toBeTruthy();
  expect(screen.getByText('5 items')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

test('pending filtered to a project with nothing waiting shows that project\'s pipeline counts', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/projects') return Response.json([{ key: 'demo' }, { key: 'other' }]);
    if (url === '/api/candidates?status=pending&limit=200') return Response.json([cand('c1', 'first miss')]);
    if (url.startsWith('/api/candidates?')) return Response.json([]);
    if (url.startsWith('/api/pipeline')) return Response.json({ stage: null, progress: null, sessions: 4, classify: null, inbox: { pending: 0, confirmed: 0 }, postmortems: null, lessons: null, scans: null });
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json(detail(m[1]));
    return Response.json([]);
  }));
  render(<Inbox />);
  await screen.findByText('turn text c1');
  expect(screen.queryByRole('region', { name: 'pipeline' })).toBeNull();
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'other' } });
  const panel = await screen.findByRole('region', { name: 'pipeline' });
  expect(urls).toContain('/api/pipeline?project=other');
  expect(panel.textContent).toMatch(/other: nothing to show here yet/);
});

test('the project filter lists every project, and keeps showing the one picked when its list is empty', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([{ key: 'demo' }, { key: 'other' }]);
    if (url.startsWith('/api/candidates?status=pending')) return Response.json([cand('c1', 'first miss')]);
    if (url.startsWith('/api/candidates?')) return Response.json([]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json(detail(m[1]));
    return Response.json([]);
  }));
  render(<Inbox />);
  await screen.findByText('turn text c1');
  const select = screen.getByLabelText('project') as HTMLSelectElement;
  await waitFor(() => expect([...select.options].map((o) => o.value)).toEqual(['', 'demo', 'other']));
  fireEvent.change(select, { target: { value: 'demo' } });
  fireEvent.click(screen.getByRole('button', { name: 'rejected' }));
  expect(await screen.findByText('Nothing rejected')).toBeTruthy();
  expect(select.value).toBe('demo');
  expect([...select.options].map((o) => o.value)).toEqual(['', 'demo', 'other']);
});

test('while a decision is being saved, the buttons are disabled and further keys are ignored', async () => {
  let release!: () => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body as string) });
      await new Promise<void>((r) => { release = r; });
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/candidates?')) return Response.json([cand('c1', 'first miss'), cand('c2', 'second miss')]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json(detail(m[1]));
    return Response.json([]);
  }));
  render(<Inbox />);
  await screen.findByText('turn text c1');
  fireEvent.keyDown(window, { key: 'c' });
  await waitFor(() => expect((screen.getByRole('button', { name: /^confirm c$/i }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole('button', { name: /^reject r$/i }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(window, { key: 'r' });
  fireEvent.keyDown(window, { key: 'c' });
  fireEvent.click(screen.getByRole('button', { name: /^reject r$/i }));
  release();
  expect(await screen.findByText('turn text c2')).toBeTruthy();
  expect(posts).toEqual([{ url: '/api/candidates/c1/decision', body: { status: 'confirmed' } }]);
});

test('an error goes away after the next decision succeeds, and when you change tab', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body as string) });
      if (fail) { fail = false; return Response.json({ error: 'graph unreachable' }, { status: 503 }); }
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/candidates?')) return Response.json([cand('c1', 'first miss'), cand('c2', 'second miss')]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json(detail(m[1]));
    return Response.json([]);
  }));
  render(<Inbox />);
  await screen.findByText('turn text c1');
  fireEvent.keyDown(window, { key: 'c' });
  expect((await screen.findAllByText(/graph unreachable/)).length).toBeGreaterThan(0);
  fireEvent.keyDown(window, { key: 'c' });
  expect(await screen.findByText('turn text c2')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText(/graph unreachable/)).toBeNull());

  fail = true;
  fireEvent.keyDown(window, { key: 'r' });
  expect((await screen.findAllByText(/graph unreachable/)).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'rejected' }));
  await waitFor(() => expect(screen.queryByText(/graph unreachable/)).toBeNull());
});

test('an item the agent reported says so, with its words, and whether the detector found it too', async () => {
  const report = { text: 'I did not run the migration', whatWasDone: 'added the orders table', reportedAt: '2026-10-01T10:05:00Z', sessionId: 's' };
  const merged = { ...cand('c1', 'first miss'), origins: ['detector', 'agent'], agentReport: report };
  const agentOnly = { ...cand('c2', 'second miss'), origins: ['agent'], agentReport: report };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/candidates?')) return Response.json([merged, agentOnly]);
    if (url === '/api/candidates/c1') return Response.json({ ...detail('c1'), candidate: merged });
    if (url === '/api/candidates/c2') return Response.json({ ...detail('c2'), candidate: agentOnly });
    return Response.json([]);
  }));
  render(<Inbox />);
  await screen.findByText('turn text c1');
  expect(screen.getByText(/reported by the agent and found by the detector/i)).toBeTruthy();
  expect(screen.getByText('I did not run the migration')).toBeTruthy();
  expect(screen.getByText(/added the orders table/)).toBeTruthy();
  fireEvent.keyDown(window, { key: 'j' });
  await screen.findByText('turn text c2');
  expect(screen.getByText(/^reported by the agent$/i)).toBeTruthy();
});

test('pending items are listed in the order they arrived, then by id, whatever order the API sends them in', async () => {
  const at = (id: string, createdAt: string, ts: string) => ({ ...cand(id, `miss ${id}`), createdAt, turnTs: ts });
  // The API orders by the turn's own time; a comment synced later can carry an older time and land mid-list.
  const sent = [at('b2', '2026-10-02T09:00:00Z', '2026-10-01T00:00:00Z'), at('a9', '2026-10-01T09:00:00Z', '2026-10-03T00:00:00Z'), at('b1', '2026-10-02T09:00:00Z', '2026-09-01T00:00:00Z')];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/candidates?')) return Response.json(sent);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json(detail(m[1]));
    return Response.json([]);
  }));
  render(<Inbox />);
  await screen.findByText('miss a9');
  const order = screen.getAllByText(/^miss /).map((e) => e.textContent);
  expect(order).toEqual(['miss a9', 'miss b1', 'miss b2']);
});

test('each list row labels its confidence as the classifier\'s', async () => {
  render(<Inbox />);
  await screen.findByText('first miss');
  const chip = screen.getAllByText('90% sure')[0];
  expect(chip.getAttribute('title')).toMatch(/classifier/);
});

test('a link to a tab (#inbox/confirmed) opens on that tab, not as an item', async () => {
  location.hash = '#inbox/confirmed';
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url.startsWith('/api/candidates?status=confirmed')) return Response.json([{ ...cand('c1', 'first miss'), status: 'confirmed' }]);
    if (url.startsWith('/api/candidates?')) return Response.json([cand('c9', 'pending one')]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return Response.json(detail(m[1]));
    return Response.json([]);
  }));
  try {
    render(<Inbox />);
    expect(await screen.findByText('first miss')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'confirmed' }).getAttribute('aria-pressed')).toBe('true');
    expect(urls).not.toContain('/api/candidates/confirmed');
  } finally {
    location.hash = '';
  }
});

test('an item only the detector flagged has no agent note', async () => {
  render(<Inbox />);
  await screen.findByText('turn text c1');
  expect(screen.queryByText(/reported by the agent/i)).toBeNull();
});


test('PR number and feedback author filters are sent to the API', async () => {
  render(<Inbox />);
  await screen.findByText('first miss');
  fireEvent.change(screen.getByLabelText('PR number'), { target: { value: '42' } });
  fireEvent.change(screen.getByLabelText('feedback author'), { target: { value: 'octo' } });
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('pr=42') && String(url).includes('author=octo'))).toBe(true));
});
