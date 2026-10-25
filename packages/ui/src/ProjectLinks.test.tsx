import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectLinks } from './ProjectLinks.tsx';

const link = (a: string, b: string, status: string, over: object = {}) => ({
  id: `link:${a}|${b}`, a, b, relation: 'depends_on', note: '', status, source: 'detected', score: 0.9,
  evidence: [{ signal: 'manifest', detail: `${b} depends on @me/${a}, a package of ${a}`, path: 'package.json', from: b }], createdAt: 't', updatedAt: 't', ...over,
});

let calls: { url: string; method?: string; body?: unknown }[];
let links: ReturnType<typeof link>[];
beforeEach(() => {
  calls = [];
  links = [link('api', 'game', 'suggested'), link('game', 'site', 'confirmed', { relation: 'same_product', note: 'the site sells the game', source: 'you', evidence: [] }), link('game', 'tools', 'dismissed')];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method, body });
    if (url === '/api/projects/game/links') return Response.json(links);
    if (url === '/api/links' && init?.method === 'PUT') {
      const [a, b] = [body.a, body.b].sort();
      const id = `link:${a}|${b}`;
      const existing = links.find((l) => l.id === id);
      const next = { ...(existing ?? link(a, b, 'confirmed', { source: 'you', evidence: [] })), ...body, a, b };
      links = [...links.filter((l) => l.id !== id), next];
      return Response.json(next);
    }
    if (url.startsWith('/api/links/') && init?.method === 'DELETE') { links = links.filter((l) => `/api/links/${encodeURIComponent(l.id)}` !== url); return new Response(null, { status: 204 }); }
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const others = ['api', 'site', 'tools', 'web'];

test('shows confirmed links with their note, and suggestions with their evidence', async () => {
  render(<ProjectLinks projectKey="game" projects={['game', ...others]} onError={() => {}} />);
  // Project names also appear as options in the link picker: take the list item.
  const item = (name: string) => screen.getAllByText(name).map((e) => e.closest('li')).find(Boolean)!;
  await screen.findByRole('button', { name: 'unlink site' });
  const confirmed = item('site');
  expect(within(confirmed).getByText('the site sells the game')).toBeTruthy();
  expect(within(confirmed).getByText('same product')).toBeTruthy();
  const suggestion = item('api');
  expect(within(suggestion).getByText(/game depends on @me\/api/)).toBeTruthy();
  expect(within(suggestion).getByText('package.json')).toBeTruthy();
  expect(screen.getByText(/1 dismissed/)).toBeTruthy();
});

test('confirming a suggestion sends your decision and moves it to the linked list', async () => {
  render(<ProjectLinks projectKey="game" projects={['game', ...others]} onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'confirm link to api' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/links' && (c.body as { status: string }).status === 'confirmed' && (c.body as { b: string }).b === 'api')).toBe(true));
  await waitFor(() => expect(screen.getByRole('button', { name: 'unlink api' })).toBeTruthy());
});

test('dismiss a suggestion; unlink a confirmed link', async () => {
  render(<ProjectLinks projectKey="game" projects={['game', ...others]} onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'dismiss link to api' }));
  await waitFor(() => expect(calls.some((c) => (c.body as { status?: string } | undefined)?.status === 'dismissed')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'unlink site' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/links/link%3Agame%7Csite')).toBe(true));
});

test('link a project by hand with a relation and a note; projects already linked are not offered', async () => {
  render(<ProjectLinks projectKey="game" projects={['game', ...others]} onError={() => {}} />);
  const pick = (await screen.findByLabelText('project to link')) as HTMLSelectElement;
  expect([...pick.options].map((o) => o.value).filter(Boolean)).toEqual(['api', 'tools', 'web']);
  fireEvent.change(pick, { target: { value: 'web' } });
  fireEvent.change(screen.getByLabelText('relation'), { target: { value: 'same_product' } });
  fireEvent.change(screen.getByLabelText('note'), { target: { value: 'the web build of the game' } });
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/links' && JSON.stringify(c.body) === JSON.stringify({ a: 'game', b: 'web', status: 'confirmed', relation: 'same_product', note: 'the web build of the game' }))).toBe(true));
  expect(await screen.findByRole('button', { name: 'unlink web' })).toBeTruthy();
});
