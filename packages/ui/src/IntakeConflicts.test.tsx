import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Intake } from './Intake.tsx';
import { OwnerWrites } from './ownerAccess.tsx';

const side = (kind: 'claim' | 'fact' | 'lesson', id: string, o: Record<string, unknown> = {}) => ({
  kind, id, fingerprint: `fp-${id}`, assertedAt: null, text: `text ${id}`, quote: null, type: null, status: null, speaker: null, origin: null, path: null,
  docId: null, source: null, agentsSee: false, gone: false, ...o,
});
const conflict = (id: string, o: Record<string, unknown> = {}) => ({
  id, kind: 'disagreement', status: 'open', projectKey: 'shop', a: { kind: 'claim', id: 'claim:a' }, b: { kind: 'lesson', id: 'lesson:b' },
  signals: [{ family: 'number', key: 'seconds', a: ['30 s'], b: ['60 s'], why: 'numbers differ: 30 s vs 60 s' }],
  judge: { relation: 'contradicts', aQuote: '30 seconds', bQuote: '60 seconds', explanation: 'The retry timeouts differ.', confidence: 0.9, model: 'ollama:test' },
  resolution: null, decisionId: null, createdAt: '2026-11-11T00:00:00.000Z', resolvedAt: null, resolvedBy: null, run: null, sandbox: false, fingerprint: `kfp-${id}`,
  sides: {
    a: side('claim', 'claim:a', {
      text: 'Retries wait 30 seconds', quote: 'we wait thirty, 30 seconds', type: 'decision', status: 'accepted', assertedAt: '2026-11-10T09:00:00.000Z',
      speaker: { id: 'person:ana', displayName: 'Ana', isOwner: false }, docId: 'doc:call', source: { docId: 'doc:call', kind: 'transcript', occurredAt: '2026-11-10', origin: 'weekly sync' }, agentsSee: true,
    }),
    b: side('lesson', 'lesson:b', { text: 'Retry timeout: Retries wait 60 seconds', type: 'lesson', status: 'approved', origin: 'postmortem', agentsSee: true }),
  },
  ...o,
});
const decision = { id: 'dec:1', type: 'resolve_conflict', status: 'applied', author: 'owner', targets: [], before: [], after: [] };

let writes: { url: string; body: unknown }[];
let resolved: boolean;
beforeEach(() => {
  location.hash = '#intake/conflicts';
  writes = [];
  resolved = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      writes.push({ url, body: JSON.parse(init.body as string) });
      if (url.includes('/resolve')) { resolved = true; return Response.json({ conflict: conflict('conflict:1', { status: 'resolved' }), decision }); }
      if (url.includes('/rollback')) { resolved = false; return Response.json({ ...decision, status: 'rolled_back' }); }
      return Response.json({});
    }
    if (url === '/api/status') return Response.json({ intake: { enabled: true } });
    if (url === '/api/projects') return Response.json([{ key: 'shop' }]);
    if (url.startsWith('/api/people')) return Response.json([]);
    if (url.startsWith('/api/conflicts?status=open')) return Response.json(resolved ? [] : [conflict('conflict:1')]);
    if (url.startsWith('/api/conflicts?status=resolved')) resolved = true;
    if (url.startsWith('/api/conflicts?status=resolved')) return Response.json([conflict('conflict:1', { status: 'resolved', resolution: { choice: 'both', note: 'reads vs writes', reason: null, createdFactId: null }, decisionId: 'dec:1' })]);
    if (url.startsWith('/api/conflicts/')) {
      return Response.json(resolved
        ? { ...conflict('conflict:1', { status: 'resolved', resolution: { choice: 'both', note: 'reads vs writes', reason: null, createdFactId: null }, decisionId: 'dec:1' }), decision }
        : { ...conflict('conflict:1'), decision: null });
    }
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a conflict shows both sides: what each says, who said it and when, the quote, the evidence, and whether agents see it', async () => {
  render(<Intake />);
  const a = await screen.findByRole('region', { name: 'side A' });
  expect(a.textContent).toMatch(/Retries wait 30 seconds/);
  expect(a.textContent).toMatch(/we wait thirty, 30 seconds/);
  expect(a.textContent).toMatch(/Ana, call \(weekly sync\), 2026-11-10/);
  expect(a.textContent).toMatch(/Agents see this: yes/);
  expect(a.querySelector('a')!.getAttribute('href')).toBe('#intake/claims?source=doc%3Acall');
  const b = screen.getByRole('region', { name: 'side B' });
  expect(b.textContent).toMatch(/A lesson \(postmortem\)/);
  expect(screen.getByText('The retry timeouts differ.')).toBeTruthy();
  expect(screen.getByRole('list', { name: 'evidence' }).textContent).toMatch(/numbers differ: 30 s vs 60 s/);
  for (const name of [/A is true/, /B is true/, /Both partly/, /Not a conflict/]) expect(screen.getByRole('button', { name })).toBeTruthy();
});

test('1 chooses A with the fingerprint it showed; Undo rolls the decision back and the conflict is open again', async () => {
  render(<Intake />);
  await screen.findByRole('region', { name: 'side A' });
  fireEvent.keyDown(window, { key: '1' });
  await waitFor(() => expect(writes[0]).toEqual({ url: '/api/conflicts/conflict%3A1/resolve', body: { choice: 'a', expect: 'kfp-conflict:1' } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(writes[1]).toEqual({ url: '/api/decisions/dec%3A1/rollback', body: { expect: 'applied', cascade: 'apply' } }));
  expect(await screen.findByRole('region', { name: 'side A' })).toBeTruthy();
});

test('both partly needs a note and may carry a reconciled statement; not a conflict needs a reason', async () => {
  render(<Intake />);
  await screen.findByRole('region', { name: 'side A' });
  fireEvent.click(screen.getByRole('button', { name: /Both partly/ }));
  expect(await screen.findByText(/needs a note/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Not a conflict/ }));
  expect(await screen.findByText(/needs a reason/)).toBeTruthy();
  expect(writes).toEqual([]);
  fireEvent.change(screen.getByPlaceholderText('How each is true, or why'), { target: { value: 'reads vs writes' } });
  fireEvent.change(screen.getByPlaceholderText('One statement both are part of'), { target: { value: 'Reads 30 s, writes 60 s' } });
  fireEvent.click(screen.getByRole('button', { name: /Both partly/ }));
  await waitFor(() => expect(writes[0].body).toEqual({ choice: 'both', expect: 'kfp-conflict:1', note: 'reads vs writes', statement: 'Reads 30 s, writes 60 s' }));
});

test('not a conflict sends its reason', async () => {
  render(<Intake />);
  await screen.findByRole('region', { name: 'side A' });
  fireEvent.change(screen.getByRole('combobox', { name: 'reason' }), { target: { value: 'scope' } });
  fireEvent.keyDown(window, { key: '4' });
  await waitFor(() => expect(writes[0].body).toEqual({ choice: 'none', expect: 'kfp-conflict:1', reason: 'scope' }));
});

test('a resolved conflict shows your choice and can be undone from there', async () => {
  render(<Intake />);
  await screen.findByRole('region', { name: 'side A' });
  fireEvent.click(screen.getByRole('button', { name: 'resolved' }));
  expect((await screen.findByRole('region', { name: 'resolution' })).textContent).toMatch(/Both partly: reads vs writes/);
  fireEvent.click(screen.getByRole('button', { name: 'Undo this choice' }));
  await waitFor(() => expect(writes[0]).toMatchObject({ url: '/api/decisions/dec%3A1/rollback' }));
});

test('read-only install: the choices are disabled and the keys do nothing', async () => {
  render(<OwnerWrites.Provider value={false}><Intake /></OwnerWrites.Provider>);
  await screen.findByRole('region', { name: 'side A' });
  expect((screen.getByRole('button', { name: /A is true/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: /Not a conflict/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByPlaceholderText('How each is true, or why') as HTMLTextAreaElement).readOnly).toBe(true);
  fireEvent.keyDown(window, { key: '1' });
  await act(async () => {});
  expect(writes).toEqual([]);
});
