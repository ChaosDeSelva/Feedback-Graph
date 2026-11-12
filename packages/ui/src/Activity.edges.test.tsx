import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Activity, ActivityEntry } from './Activity.tsx';

const entry = (o: Record<string, unknown> = {}) => ({
  id: 'e1', ts: '2026-10-22T20:33:00Z', kind: 'facts_extracted', actor: 'deterministic', projectKey: null,
  subject: 'the subject', why: '', details: {}, targets: [], ...o,
}) as Parameters<typeof ActivityEntry>[0]['a'];

let answer: (url: string) => Response;
beforeEach(() => {
  answer = () => Response.json([]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => answer(url)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); location.hash = ''; });

test('a cloud sync entry is green when it went through and red when it did not', () => {
  render(<ul><ActivityEntry a={entry({ kind: 'cloud_synced', subject: 'sent', details: { ok: true } })} /><ActivityEntry a={entry({ id: 'e2', kind: 'cloud_synced', subject: 'refused', details: { ok: false } })} /></ul>);
  const badge = (subject: string) => within(screen.getByText(subject).closest('button')!).getByText('cloud sync');
  expect(badge('sent').className).toMatch(/\bok\b|text-ok/);
  expect(badge('refused').className).toMatch(/bad/);
});

test('details of every shape read plainly: an empty list, words and ids, items by what names them, objects, and nothing', () => {
  render(<ul><ActivityEntry open a={entry({
    details: {
      skipped: [],
      notes: ['a sentence with spaces', 'abc1234'],
      items: [{ path: 'src/a.ts' }, { ref: 'lesson:1', status: 'approved' }, { other: 1 }],
      config: { model: 'gemma' },
      cleared: null,
    },
  })} /></ul>);
  const dd = (term: string) => screen.getByText(term, { selector: 'dt' }).nextElementSibling as HTMLElement;
  expect(dd('skipped').textContent).toBe('none');
  const notes = within(dd('notes')).getAllByRole('listitem');
  expect(notes[0].className).not.toMatch(/font-mono/);
  expect(notes[1].className).toMatch(/font-mono/);
  expect(within(dd('items')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['src/a.ts', 'approved · lesson:1', '{"other":1}']);
  expect(dd('config').querySelector('pre')?.textContent).toBe('{\n  "model": "gemma"\n}');
  expect(dd('cleared').textContent).toBe('–');
  // With no project the "what" line is the kind alone.
  expect(dd('what').textContent).toBe('facts extracted');
});

test('an entry from a labelled run names the run in its details too', () => {
  render(<ul><ActivityEntry open a={entry({ run: 'run-7' })} /></ul>);
  expect((screen.getByText('run', { selector: 'dt' }).nextElementSibling as HTMLElement).textContent).toBe('run run-7');
});

test('details the list left out that then cannot be loaded say why', async () => {
  answer = () => Response.json({ error: 'entry not found' }, { status: 404 });
  render(<ul><ActivityEntry open a={entry({ detailsOmitted: true })} /></ul>);
  expect(await screen.findByText('could not load them: entry not found')).toBeTruthy();
});

test('a project list that cannot be loaded says why', async () => {
  answer = (url) => (url === '/api/projects' ? Response.json({ error: 'the store is starting' }, { status: 503 }) : Response.json([]));
  render(<Activity />);
  expect(await screen.findByText('the store is starting')).toBeTruthy();
});

test('the classifier backlog is exact when it is not capped', async () => {
  location.hash = '#activity/candidate_flagged';
  answer = (url) => (url === '/api/pipeline' ? Response.json({ classify: { backlog: 7, capped: false } }) : Response.json([]));
  render(<Activity />);
  expect(await screen.findByText(/^7 turns are waiting for the classifier/)).toBeTruthy();
});

test('several hidden entries from labelled runs are counted in the plural', async () => {
  answer = (url) => (url.startsWith('/api/activity') ? Response.json([entry({ id: 'r1', run: 'a' }), entry({ id: 'r2', run: 'b' }), entry({ id: 'o', subject: 'mine' })]) : Response.json([]));
  render(<Activity />);
  expect(await screen.findByText(/2 entries from labelled runs are hidden/)).toBeTruthy();
});

test('clearing the run box shows every run again at once', async () => {
  const urls: string[] = [];
  answer = (url) => { urls.push(url); return Response.json([]); };
  render(<Activity />);
  const box = screen.getByLabelText('run');
  fireEvent.change(box, { target: { value: 'run-1' } });
  fireEvent.submit(box.closest('form')!);
  await waitFor(() => expect(urls).toContain('/api/activity?run=run-1&limit=300'));
  fireEvent.change(box, { target: { value: '' } });
  await waitFor(() => expect(urls.at(-1)).toBe('/api/activity?limit=300'));
});

test('an entry of a kind this release does not know (stored by another one) shows its kind as stored', () => {
  render(<ul><ActivityEntry open a={entry({ kind: 'retired_kind' })} /></ul>);
  expect((screen.getByText('what', { selector: 'dt' }).nextElementSibling as HTMLElement).textContent).toBe('retired_kind');
});
