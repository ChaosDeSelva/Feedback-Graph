import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Intake, sourceState } from './Intake.tsx';
import { OwnerWrites } from './ownerAccess.tsx';
import type { IntakeSource } from './api.ts';

const claim = (id: string, o: Record<string, unknown> = {}) => ({
  id, projectKey: 'shop', docId: 'doc:call', window: 0, span: null, type: 'fact', statement: `statement ${id}`, quote: `quote ${id}`, speakerId: 'person:ana',
  assertedAt: '2026-11-10T09:00:00.000Z', confidence: 0.8, scope: { area: null, files: [] }, about: 'retries', due: null, flags: [], status: 'proposed',
  decidedBy: null, decidedAt: null, factId: null, createdAt: '2026-11-10T10:00:00.000Z', run: null, sandbox: false, conflicts: [], ...o,
});
const people = [{ id: 'person:ana', displayName: 'Ana', isOwner: false, status: 'confirmed', aliases: ['ana'], claims: 2, createdAt: '2026-11-01T00:00:00.000Z' }];
// GET /api/intake/sources: the Doc (read: the per-version read queue) and its intake details.
const source: IntakeSource & { read: NonNullable<IntakeSource['read']>; intake: NonNullable<IntakeSource['intake']> } = {
  id: 'doc:shop:intake:call', projectKey: 'shop', source: 'intake', ref: 'call', title: 'Weekly sync', url: null, addedAt: '2026-11-10T10:00:00.000Z', addedBy: 'you',
  chunks: 1, kind: 'text', mediaType: 'text/vtt', read: { status: 'pending', attempts: 0, error: null, retryAt: null, readAt: null, facts: 0 },
  intake: { docId: 'doc:shop:intake:call', kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'Zoom', private: true, participants: ['person:ana'], windowsDone: 2, windowsTotal: 8 },
};

let writes: { url: string; method: string; body: unknown }[];
let enabled: boolean;
beforeEach(() => {
  location.hash = '#intake/claims';
  writes = [];
  enabled = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      writes.push({ url, method: init.method, body: JSON.parse(init.body as string) });
      if (url.startsWith('/api/claims/decisions')) return Response.json({ results: [{ id: 'claim:1', ok: true }, { id: 'claim:2', ok: true }] });
      return Response.json({ claim: claim('claim:1', { status: 'rejected' }), fact: null });
    }
    if (url === '/api/status') return Response.json({ intake: { enabled } });
    if (url === '/api/projects') return Response.json([{ key: 'shop' }]);
    if (url.startsWith('/api/people')) return Response.json(people);
    if (url.startsWith('/api/claims?')) return Response.json([claim('claim:1', { flags: ['statement-adds'], conflicts: [{ id: 'conflict:1', with: { kind: 'fact', id: 'fact:9' } }] }), claim('claim:2', { type: 'opinion' })]);
    const m = url.match(/^\/api\/claims\/([^?]+)$/);
    if (m) return Response.json({ claim: claim(decodeURIComponent(m[1]), decodeURIComponent(m[1]) === 'claim:1' ? { conflicts: [{ id: 'conflict:1', with: { kind: 'fact', id: 'fact:9' } }] } : { type: 'opinion' }), fingerprint: 'fp1', speaker: people[0], source: { kind: 'transcript', occurredAt: '2026-11-10', origin: 'Zoom' } });
    if (url.startsWith('/api/intake/sources?') || url === '/api/intake/sources') return Response.json([source]);
    if (url.startsWith('/api/intake/sources/')) return Response.json({ ...source, text: 'Ana: retries wait 30 seconds', utterances: [{ idx: 0, speaker: 'Ana', startMs: null, text: 'retries wait 30 seconds', offset: 5 }], claims: [{ id: 'claim:1', type: 'fact', status: 'proposed', span: { utt: 0, start: 5, end: 28 } }] });
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('with INTAKE_ENABLED off the page says how to turn it on', async () => {
  enabled = false;
  render(<Intake />);
  expect(await screen.findByText('Knowledge intake is off')).toBeTruthy();
});

test('claims list with speaker, flags and conflicts; the detail says whether agents see it', async () => {
  render(<Intake />);
  expect(await screen.findByText('statement claim:2')).toBeTruthy();
  expect(screen.getAllByText('statement adds to the quote').length).toBeGreaterThan(0);
  expect(screen.getByText('1 conflict')).toBeTruthy();
  expect(await screen.findByText('quote claim:1')).toBeTruthy();
  expect(screen.getByText(/Agents see this: no, not until you accept it/)).toBeTruthy();
  expect(screen.getByRole('region', { name: 'conflicts' }).textContent).toMatch(/fact:9/);
});

test('a accepts the open claim as a fact with the fingerprint it showed; r rejects and offers undo', async () => {
  render(<Intake />);
  await screen.findByText('quote claim:1');
  fireEvent.keyDown(window, { key: 'a' });
  await waitFor(() => expect(writes[0]).toEqual({ url: '/api/claims/claim%3A1', method: 'PATCH', body: { status: 'accepted', expect: 'fp1' } }));
  await screen.findByText('quote claim:2');
  expect(screen.getByRole('button', { name: /accept as opinion/i })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'r' });
  await waitFor(() => expect(writes[1]).toMatchObject({ url: '/api/claims/claim%3A2', body: { status: 'rejected' } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(writes[2]).toMatchObject({ url: '/api/claims/claim%3A2', body: { status: 'proposed' } }));
});

test('keep as opinion sends asFact false; bulk accept sends the ticked ids', async () => {
  render(<Intake />);
  await screen.findByText('quote claim:1');
  fireEvent.click(screen.getByRole('button', { name: 'Keep as opinion' }));
  await waitFor(() => expect(writes[0].body).toEqual({ status: 'accepted', asFact: false, expect: 'fp1' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /select statement claim:2/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Accept selected' }));
  await waitFor(() => expect(writes[1]).toEqual({ url: '/api/claims/decisions', method: 'POST', body: { items: [{ id: 'claim:2', status: 'accepted' }] } }));
});

test('read-only install: decision buttons are disabled and keys do nothing', async () => {
  render(<OwnerWrites.Provider value={false}><Intake /></OwnerWrites.Provider>);
  await screen.findByText('quote claim:1');
  expect((screen.getByRole('button', { name: /accept as fact/i }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(window, { key: 'a' });
  await act(async () => {});
  expect(writes).toEqual([]);
});

test('the Sources tab shows reading progress and the text with quoted spans marked', async () => {
  location.hash = '#intake/sources';
  render(<Intake />);
  expect((await screen.findAllByText('reading window 3/8')).length).toBeGreaterThan(0);
  expect((await screen.findByText('retries wait 30 seconds')).tagName).toBe('MARK');
  fireEvent.click(screen.getByRole('button', { name: 'Review its claims' }));
  await waitFor(() => expect(location.hash).toBe('#intake/claims?source=doc%3Ashop%3Aintake%3Acall'));
});

test('Add a source posts the pasted text; a transcript is private unless unticked, and the list reloads', async () => {
  location.hash = '#intake/sources';
  render(<Intake />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add a source' }));
  fireEvent.change(screen.getByLabelText('source title'), { target: { value: 'Planning call' } });
  fireEvent.change(screen.getByLabelText('source date'), { target: { value: '2026-11-10' } });
  fireEvent.change(screen.getByLabelText('participants'), { target: { value: 'Ana, Bo ' } });
  fireEvent.change(screen.getByLabelText('text to read'), { target: { value: 'Ana: retries wait 30 seconds' } });
  const listed = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).startsWith('/api/intake/sources?') || u === '/api/intake/sources').length;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });
  expect(writes.find((w) => w.url === '/api/intake')).toEqual({ url: '/api/intake', method: 'POST', body: {
    projectKey: 'shop', kind: 'transcript', title: 'Planning call', text: 'Ana: retries wait 30 seconds', occurredAt: '2026-11-10', participants: ['Ana', 'Bo'], private: true,
  } });
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).startsWith('/api/intake/sources?') || u === '/api/intake/sources').length).toBeGreaterThan(listed));
  expect(screen.queryByLabelText('text to read')).toBeNull();
  // Who was there may be new people: their names are read again.
  expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).startsWith('/api/people')).length).toBeGreaterThan(1);

  fireEvent.click(screen.getByRole('button', { name: 'Add a source' }));
  fireEvent.change(screen.getByLabelText('source kind'), { target: { value: 'notes' } });
  expect((screen.getByRole('checkbox', { name: /Private/ }) as HTMLInputElement).checked).toBe(false);
});

test('a source state comes from its background embedding, then its read queue and windows', () => {
  const read = (status: 'pending' | 'done' | 'failed', error: string | null = null) => ({ ...source.read, status, error });
  expect(sourceState({ ...source, embed: { status: 'pending', chunks: 3 } })).toEqual({ state: 'queued', error: null });
  expect(sourceState({ ...source, embed: { status: 'failed', error: 'embedding failed', chunks: 3 } })).toEqual({ state: 'failed', error: 'embedding failed' });
  expect(sourceState({ ...source, intake: { ...source.intake, windowsDone: 0 } }).state).toBe('queued');
  expect(sourceState(source).state).toBe('reading');
  expect(sourceState({ ...source, read: read('pending', 'model unavailable') })).toEqual({ state: 'reading', error: 'model unavailable' });
  expect(sourceState({ ...source, read: read('done') }).state).toBe('done');
  expect(sourceState({ ...source, read: read('failed', 'gave up') })).toEqual({ state: 'failed', error: 'gave up' });
  expect(sourceState({ ...source, read: null, intake: null }).state).toBe('queued');
});
