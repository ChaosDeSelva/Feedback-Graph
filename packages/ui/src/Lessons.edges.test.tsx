import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Lessons } from './Lessons.tsx';

const lesson = (id: string, title: string, o: Record<string, unknown> = {}) => ({
  id, projectKey: 'demo', title, rule: `${title} rule`, appliesWhen: 'search work', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: 'context_available_ignored', missId: 'm', createdAt: '2026-10-01T10:00:00Z', decidedAt: null, ...o,
});
const detail = (l: ReturnType<typeof lesson>, o: Record<string, unknown> = {}) => ({
  lesson: l,
  miss: null,
  feedback: { id: 'f', text: 'not like that', status: 'approved', sessionId: 's1', ts: '2026-10-01T10:00:00Z' },
  contextItems: [],
  fixCommits: [],
  supersedes: [],
  ...o,
});

let listed: ReturnType<typeof lesson>[];
let details: Record<string, unknown>;
let quality: unknown;
let decisions: (items: { id: string; status: string }[]) => unknown;
let sent: { url: string; body: unknown }[];
beforeEach(() => {
  location.hash = '';
  listed = [lesson('l1', 'Server search'), lesson('l2', 'Auth checks')];
  details = {};
  quality = { windows: [], projects: {} };
  decisions = (items) => ({ results: items.map((i) => ({ id: i.id, ok: true, status: i.status })) });
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (init?.method === 'PATCH' || init?.method === 'POST') sent.push({ url, body });
    if (url === '/api/lessons/decisions') return Response.json(decisions(body.items));
    if (init?.method === 'PATCH') return new Response(null, { status: 204 });
    if (url === '/api/lessons/quality') return Response.json(quality);
    if (url.startsWith('/api/lessons?')) return Response.json(listed.filter((l) => url.includes(`status=${l.status}`)));
    const m = /^\/api\/lessons\/([^/?]+)$/.exec(url);
    if (m) {
      const l = listed.find((x) => x.id === m[1]);
      return l ? Response.json(details[l.id] ?? detail(l)) : Response.json({ error: 'not found' }, { status: 404 });
    }
    if (url === '/api/projects') return Response.json([{ key: 'web' }]);
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const row = (title: string) => screen.getByRole('checkbox', { name: `select ${title}` }) as HTMLInputElement;

test('a lesson with more checks than fit shows how many more, naming them in the tooltip', async () => {
  const checks = ['platitude', 'needs-path', 'looks-like-a-fact', 'may-hold-secret'].map((name) => ({ name, why: `why ${name}` }));
  listed = [lesson('l1', 'Server search', { checks })];
  render(<Lessons />);
  const more = await screen.findByText('+1');
  expect(more.getAttribute('title')).toBe('may hold a secret');
});

test('a quality report cut short says it is capped', async () => {
  const q = (days: number) => ({ days, asWritten: 1, edited: 1, rejected: 1, decided: 3 });
  quality = { windows: [q(30), q(90)], projects: {}, capped: true };
  render(<Lessons />);
  expect((await screen.findByLabelText('how your lessons were judged')).textContent).toMatch(/\(capped\)/);
});

test('the status in the address opens that tab', async () => {
  listed = [lesson('l1', 'Server search', { status: 'approved' })];
  location.hash = '#lessons?status=approved';
  render(<Lessons />);
  expect(await screen.findByRole('heading', { name: 'Server search' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'approved' }).getAttribute('aria-pressed')).toBe('true');
});

test('saving an approved global lesson narrowed to a project without picking one says so and sends nothing', async () => {
  listed = [lesson('g1', 'Escape CSV headers', { status: 'approved', scope: 'global', projectKey: null })];
  location.hash = '#lessons?status=approved';
  render(<Lessons />);
  fireEvent.change(await screen.findByLabelText('scope'), { target: { value: 'project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect((await screen.findAllByText(/choose the project/i)).length).toBeGreaterThan(0);
  expect(sent).toEqual([]);
});

test('Select all, then Clear; a tick can be taken back', async () => {
  render(<Lessons />);
  await screen.findByRole('checkbox', { name: 'select Server search' });
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.getByText('none selected')).toBeTruthy();
  fireEvent.click(row('Auth checks'));
  fireEvent.click(row('Auth checks'));
  expect(row('Auth checks').checked).toBe(false);
});

test('a bulk decision that leaves the open lesson keeps it open; failures beyond three are counted, a reason-less one says failed', async () => {
  listed = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => lesson(k, `Lesson ${k}`));
  decisions = (items) => ({ results: items.map((i) => (i.id === 'b' ? { id: 'b', ok: true } : { id: i.id, ok: false, ...(i.id === 'c' ? {} : { error: 'stale' }) })) });
  render(<Lessons />);
  await screen.findByRole('heading', { name: 'Lesson a' });
  fireEvent.click(screen.getByText('Lesson c'));
  await screen.findByRole('heading', { name: 'Lesson c' });
  for (const k of ['b', 'c', 'd', 'e', 'f']) fireEvent.click(row(`Lesson ${k}`));
  // The open lesson is among them, with no unsaved edits: no question first.
  fireEvent.click(screen.getByRole('button', { name: 'Reject selected' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject 5 lessons' }));
  expect((await screen.findAllByText('4 lessons could not be decided (still selected): c: failed; d: stale; e: stale; and 1 more')).length).toBeGreaterThan(0);
  expect(screen.queryByText('Lesson b')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Lesson c' })).toBeTruthy();
  expect(screen.getByText('4 selected')).toBeTruthy();
});

test('a bulk decision with no lesson open (its link was to a deleted one) opens the first row left; one failure is listed in full', async () => {
  decisions = (items) => ({ results: items.map((i) => (i.id === 'l2' ? { id: 'l2', ok: false, error: 'stale' } : { id: i.id, ok: true })) });
  location.hash = '#lessons/gone';
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'Select all' }));
  expect(screen.queryByRole('heading', { name: 'Auth checks' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve 2 lessons' }));
  expect((await screen.findAllByText('1 lesson could not be decided (still selected): l2: stale')).length).toBeGreaterThan(0);
  expect(screen.queryByText('Server search')).toBeNull();
  expect(await screen.findByRole('heading', { name: 'Auth checks' })).toBeTruthy();
});

test('a full list says only the newest are shown', async () => {
  listed = Array.from({ length: 500 }, (_, i) => lesson(`l${i}`, `Lesson ${i}`));
  render(<Lessons />);
  expect(await screen.findByText(/Showing the newest 500/)).toBeTruthy();
});

test('clicking the open lesson again keeps it open', async () => {
  render(<Lessons />);
  await screen.findByRole('heading', { name: 'Server search' });
  fireEvent.click(screen.getByText('Server search', { selector: 'div' }));
  expect(screen.getByRole('heading', { name: 'Server search' })).toBeTruthy();
});

test('a Linear comment links to Linear; an unnamed reviewer or commenter is called that; context not loaded says so', async () => {
  const ext = (source: string) => ({ source, author: '', url: `https://${source}.example.com/1` });
  listed = [lesson('l1', 'Server search'), lesson('l2', 'Auth checks')];
  details = {
    l1: detail(listed[0], { feedback: { id: 'f', text: 'no', status: 'approved', sessionId: 's1', ts: 't', external: ext('linear') }, contextItems: [{ kind: 'doc', ref: 'spec.md', excerpt: 'x', why: 'y', wasAvailable: false }] }),
    l2: detail(listed[1], { feedback: { id: 'f', text: 'no', status: 'approved', sessionId: 's1', ts: 't', external: ext('github') } }),
  };
  render(<Lessons />);
  expect(await screen.findByText('The commenter said')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'on Linear' })).toBeTruthy();
  expect(screen.getByText('not loaded in the session')).toBeTruthy();
  fireEvent.click(screen.getByText('Auth checks', { selector: 'div' }));
  expect(await screen.findByText('The reviewer said')).toBeTruthy();
});

test('a lesson with a source and a check this release does not know shows them as stored, in words', async () => {
  listed = [lesson('l1', 'Server search', { status: 'approved', source: 'legacy-import', checks: [{ name: 'retired-check', why: 'an old check' }] })];
  location.hash = '#lessons?status=approved';
  render(<Lessons />);
  expect(await screen.findByRole('heading', { name: 'Server search' })).toBeTruthy();
  expect(screen.getAllByText('retired check')[0].getAttribute('title')).toBe('an old check');
  expect((await screen.findByText('legacy-import')).getAttribute('title')).toBe('legacy-import');
});
