import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CloudSync } from './CloudSync.tsx';

const counts = { projects: 2, lessons: 7, misses: 3, facts: 40, docs: 2, codeFiles: 120 };
const NEVER = 'Never sent: session transcripts (including the feedback you typed), source code, file excerpts, document text, embeddings.';
const info = (o: Record<string, unknown> = {}) => ({
  enabled: true, host: 'cloud.example.com', intervalMinutes: 60, suggestions: false, projects: ['shop', 'api'],
  preview: { total: counts, projects: [{ key: 'shop', counts }, { key: 'api', counts: null }] }, previewError: null,
  last: null, nextAt: null, neverSent: NEVER, ...o,
});

let state: ReturnType<typeof info>;
let calls: { url: string; method: string; headers?: HeadersInit }[];
let syncAnswer: () => Response;

beforeEach(() => {
  state = info();
  calls = [];
  syncAnswer = () => Response.json({ ok: true, host: 'cloud.example.com', sent: counts, projects: [], error: null });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: init?.headers });
    if (url === '/api/cloud' && method === 'GET') return Response.json(state);
    if (url === '/api/cloud/sync') {
      const r = syncAnswer();
      if (r.ok) state = info({ last: { at: new Date().toISOString(), ok: true, trigger: 'manual', error: null, sent: counts, projects: ['shop', 'api'], failed: [] } });
      return r;
    }
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const card = async () => within(await screen.findByRole('region', { name: 'Cloud sync' }));

test('lessons: approved only by default, and says how to send suggestions; SYNC_SUGGESTIONS=true says proposed ones go too', async () => {
  render(<CloudSync />);
  let c = await card();
  expect(c.getByText(/Approved ones only/)).toBeTruthy();
  expect(c.getByText('SYNC_SUGGESTIONS=true')).toBeTruthy();
  cleanup();
  state = info({ suggestions: true });
  render(<CloudSync />);
  c = await card();
  expect(c.getByText(/also the ones you have not approved/)).toBeTruthy();
});

test('off: says nothing is sent and how to turn it on, with no Sync now button', async () => {
  state = info({ enabled: false, host: null, intervalMinutes: null, projects: [], preview: null });
  render(<CloudSync />);
  const c = await card();
  expect(c.getByText('off')).toBeTruthy();
  expect(c.getByText(/Nothing is sent anywhere/)).toBeTruthy();
  expect(c.getByText('CLOUD_URL')).toBeTruthy();
  expect(c.queryByRole('button', { name: /sync now/i })).toBeNull();
  expect(c.getByText(NEVER)).toBeTruthy();
});

test('configured: shows the host, the schedule, what will be sent and what never is', async () => {
  render(<CloudSync />);
  const c = await card();
  expect(c.getByText('not synced yet')).toBeTruthy();
  expect(c.getByText('cloud.example.com')).toBeTruthy();
  expect(c.getByText(/every 60 minutes/)).toBeTruthy();
  expect(within(c.getByLabelText('lessons')).getByText('7')).toBeTruthy();
  expect(within(c.getByLabelText('misses')).getByText('3')).toBeTruthy();
  expect(within(c.getByLabelText('facts')).getByText('40')).toBeTruthy();
  expect(c.getByText(/shop, api/)).toBeTruthy();
  expect(c.getByText(NEVER)).toBeTruthy();
});

test('without an interval it says it only syncs when you press Sync now', async () => {
  state = info({ intervalMinutes: null });
  render(<CloudSync />);
  expect((await card()).getByText(/only when you press Sync now/i)).toBeTruthy();
});

test('Sync now posts from the UI, then shows the result and the card turns connected', async () => {
  render(<CloudSync />);
  const c = await card();
  fireEvent.click(c.getByRole('button', { name: 'Sync now' }));
  await waitFor(() => expect(c.getByText('connected')).toBeTruthy());
  const post = calls.find((x) => x.url === '/api/cloud/sync')!;
  expect(post.method).toBe('POST');
  expect(new Headers(post.headers).get('content-type')).toBe('application/json');
  expect(c.getByRole('status').textContent).toMatch(/Sent 2 projects to cloud\.example\.com: 7 lessons/);
});

test('a Sync now with nothing to send says so instead of claiming a sync', async () => {
  const none = { projects: 0, lessons: 0, misses: 0, facts: 0, docs: 0, codeFiles: 0 };
  syncAnswer = () => Response.json({ ok: true, host: 'cloud.example.com', sent: none, projects: [{ key: 'shop', status: 'empty', counts: null }], error: null });
  render(<CloudSync />);
  const c = await card();
  fireEvent.click(c.getByRole('button', { name: 'Sync now' }));
  expect(await c.findByText(/Nothing to send yet/)).toBeTruthy();
  expect(c.queryByText(/Sent 0 projects/)).toBeNull();
});

test('a Sync now that finds every project unchanged says nothing changed, never "Sent 0 projects"', async () => {
  const none = { projects: 0, lessons: 0, misses: 0, facts: 0, docs: 0, codeFiles: 0 };
  syncAnswer = () => Response.json({ ok: true, host: 'cloud.example.com', sent: none, projects: [{ key: 'shop', status: 'unchanged', counts }, { key: 'api', status: 'unchanged', counts }], error: null });
  render(<CloudSync />);
  const c = await card();
  fireEvent.click(c.getByRole('button', { name: 'Sync now' }));
  expect(await c.findByText(/Nothing changed since the last sync \(2 projects unchanged\)/)).toBeTruthy();
  expect(c.queryByText(/Sent 0 projects/)).toBeNull();
  expect(c.queryByText(/Nothing to send yet/)).toBeNull();
});

test('a Sync now that sent some projects names how many were unchanged', async () => {
  syncAnswer = () => Response.json({ ok: true, host: 'cloud.example.com', sent: counts, projects: [{ key: 'shop', status: 'sent', counts }, { key: 'api', status: 'sent', counts }, { key: 'blog', status: 'unchanged', counts }], error: null });
  render(<CloudSync />);
  const c = await card();
  fireEvent.click(c.getByRole('button', { name: 'Sync now' }));
  expect(await c.findByText(/Sent 2 projects to cloud\.example\.com: .*; 1 project unchanged since the last sync\./)).toBeTruthy();
});

test('a failed last sync shows its error', async () => {
  state = info({ last: { at: '2026-10-23T09:00:00Z', ok: false, trigger: 'schedule', error: 'shop: the cloud refused the token (401)', sent: null, projects: [], failed: ['shop'] }, nextAt: '2026-10-23T11:00:00Z' });
  render(<CloudSync />);
  const c = await card();
  expect(c.getByText('error')).toBeTruthy();
  expect(c.getByRole('alert').textContent).toMatch(/refused the token/);
  expect(c.getByText(/next/i)).toBeTruthy();
});

test('a Sync now the server refuses shows the server reason', async () => {
  syncAnswer = () => Response.json({ error: 'a sync is already running' }, { status: 409 });
  render(<CloudSync />);
  const c = await card();
  fireEvent.click(c.getByRole('button', { name: 'Sync now' }));
  await waitFor(() => expect(c.getByRole('alert').textContent).toMatch(/already running/));
});

test('an API without cloud sync renders nothing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  const { container } = render(<CloudSync />);
  await new Promise((r) => setTimeout(r, 10));
  expect(container.textContent).toBe('');
});


test('eligibility and the cloud admin approval gate are visible beside sync status', async () => {
  state = info({ projects: ['shop', 'cap'], preview: { total: counts, projects: [{ key: 'shop', counts }, { key: 'cap', counts: null, reason: 'No shareable knowledge' }] },
    last: { at: '2026-10-23T10:00:00Z', ok: true, trigger: 'manual', error: null, sent: counts, projects: ['shop'], failed: [],
      teamLessons: [{ message: 'An admin must approve team lessons before the team MCP serves them.' }] } });
  render(<CloudSync />);
  const c = await card();
  expect(c.getByLabelText('Cloud project eligibility').textContent).toContain('cap: not sent: No shareable knowledge');
  expect(c.getByText('An admin must approve team lessons before the team MCP serves them.')).toBeTruthy();
});
