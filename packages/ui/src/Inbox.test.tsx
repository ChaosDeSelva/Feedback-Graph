import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi, onTestFinished } from 'vitest';
import { Inbox } from './Inbox.tsx';
import { heldAnswer } from './testing/heldAnswer.ts';

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
  location.hash = '';
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
  // A decision would be posted from the key handler: settle what it queued.
  await act(async () => {});
  expect(posts).toEqual([]);
});

/** Candidate details answer at once, except those held back here until the test delivers them. */
function slowDetails(held: Record<string, ReturnType<typeof heldAnswer>>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(init.body as string) }); return new Response(null, { status: 204 }); }
    if (url.startsWith('/api/candidates?')) return Response.json([cand('c1', 'first miss'), cand('c2', 'second miss')]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    if (m) return held[m[1]] ? held[m[1]].answer() : Response.json(detail(m[1]));
    return Response.json([]);
  }));
}

test('a decision key does nothing until the item you are deciding on has loaded', async () => {
  const c1 = heldAnswer(detail('c1'));
  slowDetails({ c1 });
  render(<Inbox />);
  await screen.findByText('first miss');
  fireEvent.keyDown(window, { key: 'c' });
  await c1.deliver();
  await screen.findByText('turn text c1');
  expect(posts).toEqual([]);
});

test('a slow answer for the previous item never replaces the one you moved to', async () => {
  const c1 = heldAnswer(detail('c1'));
  slowDetails({ c1 });
  render(<Inbox />);
  await screen.findByText('first miss');
  fireEvent.keyDown(window, { key: 'j' });
  expect(await screen.findByText('turn text c2')).toBeTruthy();
  await c1.deliver();
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
  expect(panel.textContent).toMatch(/other: Nothing in the Inbox yet\./);
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
  expect(await screen.findByText('No feedback matches these filters')).toBeTruthy();
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
  // The list scores only what the classifier read: an agent's own report is labelled, not "100% sure".
  expect(screen.getAllByText('agent report')).toHaveLength(2);
  expect(screen.getAllByText(/% sure$/)).toHaveLength(1);
  // The open detail says so too, and gives no confidence; the merged one (the detector read it) keeps its score.
  expect(screen.queryByText(/% confident$/)).toBeNull();
  fireEvent.keyDown(window, { key: 'k' });
  await screen.findByText('turn text c1');
  expect(screen.getByText('90% confident')).toBeTruthy();
  expect(screen.getAllByText('agent report')).toHaveLength(1);
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


test('a deleted deep link never opens the first unrelated feedback item', async () => {
  location.hash = '#inbox/deleted';
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url) === '/api/candidates/deleted' ? new Response(null, { status: 404 }) : original(url, init));
  render(<Inbox />);
  expect(await screen.findByText('Linked feedback is unavailable')).toBeTruthy();
  expect(screen.queryByText('turn text c1')).toBeNull();
});

test('Inbox filters restore from and persist to the URL without changing the linked item', async () => {
  location.hash = '#inbox?pr=42&author=andy&status=confirmed';
  render(<Inbox />);
  expect((screen.getByLabelText('PR number') as HTMLInputElement).value).toBe('42');
  expect((screen.getByLabelText('feedback author') as HTMLInputElement).value).toBe('andy');
  fireEvent.change(screen.getByLabelText('PR number'), { target: { value: '43' } });
  await waitFor(() => expect(location.hash).toContain('pr=43'));
  expect(location.hash).toContain('author=andy');
});

test('an Inbox decision offers audited Undo and reports a refusal after processing starts', async () => {
  let decided = false;
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/undo')) return Response.json({ error: 'post-mortem has started' }, { status: 409 });
    if (String(url).endsWith('/decision')) decided = true;
    if (url === '/api/candidates/c1' && decided) return Response.json({ ...detail('c1'), candidate: { ...cand('c1', 'first miss'), status: 'confirmed', decidedAt: '2026-10-01T10:01:00.000Z' } });
    return original(url, init);
  });
  render(<Inbox />); await screen.findByText('turn text c1');
  fireEvent.keyDown(window, { key: 'c' });
  fireEvent.click(await screen.findByRole('button', { name: 'Undo decision' }));
  expect(await screen.findByText(/post-mortem has started/)).toBeTruthy();
});

test('an empty Inbox list can still be reached by keyboard, so it can be scrolled', async () => {
  const { overflowAll, unreachableScrollers } = await import('./ui/scrollReach.ts');
  onTestFinished(overflowAll());
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  const { container } = render(<Inbox />);
  await waitFor(() => expect(screen.getAllByRole('region').length).toBeGreaterThan(0));
  expect(unreachableScrollers(container).map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
});

test('an empty confirmed tab says nothing is confirmed yet and leads back to pending', async () => {
  emptyServer({ selection: { initialized: true, tracked: 2, note: null }, givenUpTurns: 0 });
  render(<Inbox />);
  await screen.findByText('No feedback waiting');
  fireEvent.click(screen.getByRole('button', { name: 'confirmed' }));
  expect(await screen.findByText('Nothing confirmed yet')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show pending' }));
  expect(await screen.findByText('No feedback waiting')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'rejected' }));
  expect(await screen.findByText('Nothing rejected')).toBeTruthy();
});

test('a re-queue the server refuses says why', async () => {
  emptyServer({ selection: { initialized: true, tracked: 2, note: null }, givenUpTurns: 3 });
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/turns/requeue' ? Response.json({ error: 'the worker is offline' }, { status: 409 }) : inner(url, init))));
  render(<Inbox />);
  fireEvent.click(await screen.findByRole('button', { name: /re-queue 3 turns/i }));
  expect(await screen.findByText('the worker is offline')).toBeTruthy();
});

/** A confirmed item whose detail reports this post-mortem state; Retry answers with `retry`. */
function confirmedWith(postmortem: object, retry: () => Response = () => new Response(null, { status: 204 })) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(init.body as string) }); return retry(); }
    if (url.startsWith('/api/candidates?')) return Response.json([{ ...cand('c1', 'first miss'), status: 'confirmed' }]);
    if (url === '/api/candidates/c1') return Response.json({ ...detail('c1'), postmortem });
    return Response.json([]);
  }));
}

test('a confirmed item says where its post-mortem is: waiting, retrying at a time, or done', async () => {
  const retryAt = '2026-11-10T15:30:00Z';
  for (const [pm, text] of [
    [{ done: false, attempts: 0, lastError: null, retryAt: null, gaveUp: false }, 'Waiting for the worker to run the post-mortem.'],
    [{ done: false, attempts: 1, lastError: 'timeout', retryAt, gaveUp: false }, `The post-mortem failed 1 time; next try ${new Date(retryAt).toLocaleTimeString()}.`],
    [{ done: false, attempts: 2, lastError: 'timeout', retryAt: null, gaveUp: false }, 'The post-mortem failed 2 times; next try soon.'],
    [{ done: true, attempts: 1, lastError: null, retryAt: null, gaveUp: false }, 'Post-mortem done: its lesson is waiting on the Lessons page.'],
  ] as const) {
    confirmedWith(pm);
    render(<Inbox />);
    fireEvent.click(await screen.findByRole('button', { name: 'confirmed' }));
    expect(await screen.findByText(text)).toBeTruthy();
    cleanup();
  }
});

test('a post-mortem retry the server refuses says why and does not claim it was queued', async () => {
  confirmedWith({ done: false, attempts: 5, lastError: 'ollama timed out', retryAt: null, gaveUp: true }, () => Response.json({ error: 'only you can retry this' }, { status: 403 }));
  render(<Inbox />);
  fireEvent.click(await screen.findByRole('button', { name: 'confirmed' }));
  fireEvent.click(await screen.findByRole('button', { name: /retry post-mortem/i }));
  expect(await screen.findByText('only you can retry this')).toBeTruthy();
  expect(screen.queryByText(/Queued: the worker will run the post-mortem again/)).toBeNull();
});

test('k moves the selection up; a key typed in the note is text, not a decision', async () => {
  render(<Inbox />);
  await screen.findByText('turn text c1');
  fireEvent.keyDown(window, { key: 'j' });
  expect(await screen.findByText('turn text c2')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'k' });
  expect(await screen.findByText('turn text c1')).toBeTruthy();
  const note = screen.getByLabelText('note');
  fireEvent.keyDown(note, { key: 'r' });
  expect(posts).toEqual([]);
});

test('Undo puts the decided item back in the pending list', async () => {
  let decided = false;
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/undo')) { decided = false; return new Response(null, { status: 204 }); }
    if (String(url).endsWith('/decision')) decided = true;
    if (url === '/api/candidates/c1' && decided) return Response.json({ ...detail('c1'), candidate: { ...cand('c1', 'first miss'), status: 'confirmed', decidedAt: '2026-10-01T10:01:00.000Z' } });
    return original(url, init);
  });
  render(<Inbox />);
  await screen.findByText('turn text c1');
  fireEvent.keyDown(window, { key: 'c' });
  fireEvent.click(await screen.findByRole('button', { name: 'Undo decision' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo decision' })).toBeNull());
  expect(screen.getByText('first miss')).toBeTruthy();
});

test('an item with no summary says so; the session filter keeps items stored before sources were recorded', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/candidates?')) return Response.json([cand('c1', ''), { ...cand('c2', 'from github'), source: 'github' }]);
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    return m ? Response.json(detail(m[1])) : Response.json([]);
  }));
  render(<Inbox />);
  expect(await screen.findByText('(no summary)')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('source'), { target: { value: 'claude' } });
  await waitFor(() => expect(screen.queryByText('from github')).toBeNull());
  expect(screen.getByText('(no summary)')).toBeTruthy();  // Filtered by source to nothing, it shows where the pipeline stands overall.
  fireEvent.change(screen.getByLabelText('source'), { target: { value: 'linear' } });
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.map(([u]) => String(u))).toContain('/api/pipeline'));
});

test('one turn given up is offered in the singular', async () => {
  emptyServer({ selection: { initialized: true, tracked: 2, note: null }, givenUpTurns: 1 });
  render(<Inbox />);
  expect(await screen.findByRole('button', { name: 'Re-queue 1 turn that was given up' })).toBeTruthy();
});

test('a next page that arrives after you changed tab is dropped', async () => {
  const late = heldAnswer([cand('c9', 'late page item')]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/candidates?status=pending&limit=200') return Response.json([cand('c1', 'first miss')], { headers: { 'x-next-offset': '200' } });
    if (url === '/api/candidates?status=pending&limit=200&offset=200') return late.answer();
    const m = url.match(/\/api\/candidates\/(\w+)$/);
    return m ? Response.json(detail(m[1])) : Response.json([]);
  }));
  render(<Inbox />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
  fireEvent.click(screen.getByRole('button', { name: /^confirmed/ }));
  await late.deliver();
  expect(screen.queryByText('late page item')).toBeNull();
});

test('a keyboard post-mortem retry leaves focus on the Post-mortem card heading once the button goes', async () => {
  confirmedWith({ done: false, attempts: 5, lastError: 'ollama timed out', retryAt: null, gaveUp: true });
  render(<Inbox />);
  fireEvent.click(await screen.findByRole('button', { name: 'confirmed' }));
  (await screen.findByRole('button', { name: /retry post-mortem/i })).focus();
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByText(/Queued: the worker will run the post-mortem again/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Post-mortem' }));
});

test('Re-queue and Retry post-mortem now say what they are doing while their request is in flight', async () => {
  emptyServer({ selection: { initialized: true, tracked: 2, note: null }, givenUpTurns: 3 });
  let inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  let release = () => {};
  let gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === 'POST') await gate; return inner(url, init); }));
  render(<Inbox />);
  fireEvent.click(await screen.findByRole('button', { name: /re-queue 3 turns/i }));
  expect((await screen.findByRole('button', { name: 'Re-queueing…' })).getAttribute('aria-disabled')).toBe('true');
  release();
  expect(await screen.findByText(/3 turns re-queued/i)).toBeTruthy();
  cleanup();

  confirmedWith({ done: false, attempts: 5, lastError: 'ollama timed out', retryAt: null, gaveUp: true });
  inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === 'POST') await gate; return inner(url, init); }));
  render(<Inbox />);
  fireEvent.click(await screen.findByRole('button', { name: 'confirmed' }));
  fireEvent.click(await screen.findByRole('button', { name: /retry post-mortem now/i }));
  const retrying = await screen.findByRole('button', { name: 'Retrying…' });
  fireEvent.click(retrying);
  release();
  expect(await screen.findByText(/Queued: the worker will run the post-mortem again/)).toBeTruthy();
  expect(posts.filter((p) => p.url !== '/api/turns/requeue')).toHaveLength(1);
});
