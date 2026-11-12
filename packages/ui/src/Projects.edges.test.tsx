import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectSummary } from './api.ts';
import { ordinal, Projects, queuePosition } from './Projects.tsx';

const job = (o: Record<string, unknown> = {}) => ({
  id: 'scan:1', projectKey: 'demo-shop', repoPath: '/examples/demo-shop', provider: 'ollama:gemma4', status: 'done',
  requestedAt: '2026-10-22T10:00:00Z', startedAt: null, finishedAt: null, filesScanned: 4, factsAdded: 12, error: null, ...o,
});
const project = (key: string, o: Record<string, unknown> = {}) => ({
  key, repoPath: `/vibe/${key}`, remote: null, aliases: [], sessions: 0, feedback: 0, lessons: 0, facts: 0, lastScan: null, pinned: false, ...o,
});
const fact = (id: string, path: string, o: Record<string, unknown> = {}) => ({
  id, kind: 'convention', statement: `fact ${id}`, path, lines: '1-10', confidence: 0.9, source: 'ollama:gemma4', createdAt: '2026-10-22T20:33:00Z',
  why: 'agents need it', scanJobId: 'scan:1', fileHash: 'abc1234def', fileSummary: null, relevance: null, relevanceBy: null, ...o,
});

let calls: { url: string; method: string; body?: unknown }[];
let projectList: unknown[];
let facts: unknown[];
beforeEach(() => {
  calls = [];
  projectList = [project('demo-shop', { facts: 2, lastScan: job() }), project('other')];
  facts = [fact('f1', 'src/db.ts')];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/projects') return Response.json(projectList);
    if (url.includes('/facts')) return Response.json(facts);
    if (url.endsWith('/scan')) return Response.json(job({ status: 'queued' }), { status: 202 });
    if (url.endsWith('/pin')) return new Response(null, { status: 204 });
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', location.pathname); });

test('queue places read as ordinals, the teens included', () => {
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
});

test('scans queued at the same moment are taken in id order; a project with no queued scan has no place', () => {
  const at = (key: string, id: string, requestedAt: string) => project(key, { lastScan: job({ id, status: 'queued', requestedAt }) }) as unknown as ProjectSummary;
  const ps = [at('b', 'scan:b', '2026-10-22T10:00:00Z'), at('a', 'scan:a', '2026-10-22T10:00:00Z'), at('c', 'scan:c', '2026-10-22T09:00:00Z'), at('e', 'scan:e', '2026-10-22T10:00:00Z'), at('d', 'scan:d', '2026-10-22T11:00:00Z')];
  expect(['a', 'b', 'c', 'd', 'e'].map((k) => queuePosition(ps, k))).toEqual([2, 3, 1, 5, 4]);
  expect(queuePosition(ps, 'nowhere')).toBeNull();
  expect(queuePosition([project('e') as unknown as ProjectSummary], 'e')).toBeNull();
});

test('with no project holding facts the first one opens; with none at all, nothing does and Jump does nothing', async () => {
  projectList = [project('alpha'), project('beta')];
  const { unmount } = render(<Projects />);
  expect(await screen.findByRole('heading', { name: 'alpha' })).toBeTruthy();
  unmount();
  projectList = [];
  render(<Projects />);
  expect(await screen.findByText('No project folders found under the configured roots.')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Jump to scan controls' }));
  expect(location.hash).toBe('');
});

test('a jump with a modifier key is left to the browser (a new tab); a plain one from a missing project opens the first and scrolls to its controls', async () => {
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  try {
    history.replaceState(null, '', '#projects/gone');
    render(<Projects />);
    expect(await screen.findByText('Project not found')).toBeTruthy();
    const jump = screen.getByRole('link', { name: 'Jump to scan controls' });
    expect(fireEvent.click(jump, { ctrlKey: true })).toBe(true);
    expect(screen.getByText('Project not found')).toBeTruthy();
    expect(fireEvent.click(jump)).toBe(false);
    expect(await screen.findByRole('heading', { name: 'demo-shop' })).toBeTruthy();
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ block: 'start' }));
  } finally {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

test('a project never scanned scans on the provider picked', async () => {
  projectList = [project('other', { facts: 1 })];
  render(<Projects />);
  await screen.findByRole('heading', { name: 'other' });
  fireEvent.change(screen.getByLabelText('provider'), { target: { value: 'codex-cli' } });
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
  await waitFor(() => expect(calls.find((c) => c.url.endsWith('/scan'))).toMatchObject({ url: '/api/projects/other/scan', body: { provider: 'codex-cli' } }));
});

test('keeping the queued scan when asked to cancel it removes nothing', async () => {
  projectList = [project('demo-shop', { facts: 1, lastScan: job({ status: 'queued' }) })];
  render(<Projects />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel queued scan' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep queued scan' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
});

test('an empty search lists the facts of the kind chosen', async () => {
  render(<Projects />);
  await screen.findByText('fact f1');
  let before = calls.length;
  fireEvent.submit(screen.getByLabelText('search facts'));
  await waitFor(() => expect(calls.slice(before).map((c) => c.url)).toEqual(['/api/projects/demo-shop/facts']));
  fireEvent.change(screen.getByLabelText('kind'), { target: { value: 'gotcha' } });
  await waitFor(() => expect(calls.some((c) => c.url === '/api/projects/demo-shop/facts?kind=gotcha')).toBe(true));
  before = calls.length;
  fireEvent.submit(screen.getByLabelText('search facts'));
  await waitFor(() => expect(calls.slice(before).map((c) => c.url)).toEqual(['/api/projects/demo-shop/facts?kind=gotcha']));
});

test('a pinned project says so on its own Pin button, and pressing it unpins', async () => {
  projectList = [project('demo-shop', { facts: 1, pinned: true })];
  render(<Projects />);
  await screen.findByRole('heading', { name: 'demo-shop' });
  const pin = screen.getByRole('button', { name: 'Pinned' });
  expect(pin.getAttribute('title')).toBe('pinned: listed first everywhere');
  fireEvent.click(pin);
  await waitFor(() => expect(calls.find((c) => c.url.endsWith('/pin'))?.body).toEqual({ pinned: false }));
});

test('a failed scan line is marked; one unreached place reads singular; a retry names its attempt', async () => {
  projectList = [project('demo-shop', { facts: 1, lastScan: job({ status: 'failed', error: 'model down', shards: { total: 3, rescanned: 1, failed: 1, unreached: ['packages/api'] } }) })];
  const { unmount } = render(<Projects />);
  const line = (await screen.findByText('model down')).parentElement!;
  expect(line.className).toMatch(/border-bad/);
  expect(within(line).getByText('1 place not reached')).toBeTruthy();
  expect(within(line).getByText(/1 of 3 shards rescanned, 1 failed/)).toBeTruthy();
  unmount();
  projectList = [project('demo-shop', { facts: 1, lastScan: job({ status: 'queued', retryAt: '2999-01-01T10:00:00Z', attempts: 2 }) })];
  const second = render(<Projects />);
  expect(await screen.findByText(/\(attempt 3\)/)).toBeTruthy();
  second.unmount();
  // The first try is waiting: no attempt number yet.
  projectList = [project('demo-shop', { facts: 1, lastScan: job({ status: 'queued', retryAt: '2999-01-01T10:00:00Z', attempts: 0 }) })];
  render(<Projects />);
  expect((await screen.findByText(/^retrying/)).textContent).not.toMatch(/attempt/);
});

test('files read by an older scanner are said to be refreshed by the scan under way', async () => {
  projectList = [project('demo-shop', { facts: 1, olderScanner: 1, lastScan: job({ status: 'running' }) })];
  const { unmount } = render(<Projects />);
  expect(await screen.findByText(/1 file was read by an older scanner: the scan under way refreshes it\./)).toBeTruthy();
  unmount();
  projectList = [project('demo-shop', { facts: 1, olderScanner: 4, lastScan: job({ status: 'running' }) })];
  const second = render(<Projects />);
  expect(await screen.findByText(/4 files were read by an older scanner: the scan under way refreshes them\./)).toBeTruthy();
  second.unmount();
  projectList = [project('demo-shop', { facts: 1, olderScanner: 1, lastScan: job() })];
  render(<Projects />);
  expect(await screen.findByText(/1 file was read by an older scanner: press Scan to refresh it\./)).toBeTruthy();
});

test('sorted by file, groups go A to Z and one can be closed again; 26 files offer one more', async () => {
  facts = Array.from({ length: 26 }, (_, i) => fact(`f${i}`, `src/${String.fromCharCode(122 - i)}.ts`));
  render(<Projects />);
  const groups = () => screen.getAllByRole('button', { name: /^src\/\w\.ts · 1 fact/ });
  await waitFor(() => expect(groups()[0].textContent).toMatch(/^src\/z\.ts/));
  fireEvent.change(screen.getByLabelText('sort facts'), { target: { value: 'file' } });
  await waitFor(() => expect(groups()[0].textContent).toMatch(/^src\/a\.ts/));
  expect(groups()).toHaveLength(25);
  const first = groups()[0];
  expect(first.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(first);
  expect(first.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Show 1 more file' }));
  expect(groups()).toHaveLength(26);
});

test("a fact written through an operator names who wrote it; a document fact you rated is kept until it is uploaded again; a fact with no reason says so", async () => {
  facts = [
    fact('f1', 'src/db.ts', { origin: 'you', source: 'operator:ci', relevance: 0.9, relevanceBy: 'you' }),
    fact('f2', 'spec.md', { docId: 'doc:1', relevance: 0.5, relevanceBy: 'you', why: '' }),
  ];
  render(<Projects />);
  const mine = (await screen.findByText('fact f1')).closest('li')!;
  expect(within(mine).getByText('yours').getAttribute('title')).toMatch(/^written by operator:ci/);
  fireEvent.click(screen.getByRole('button', { name: /document spec\.md/ }));
  const doc = (await screen.findByText('fact f2')).closest('li')!;
  expect(within(doc).getByText(/set by you/).getAttribute('title')).toBe('kept until the document is uploaded again');
  fireEvent.click(within(doc).getByRole('button', { name: 'how was this created?' }));
  expect(await within(doc).findByText('the model gave no reason')).toBeTruthy();
});

test('a fact whose citation check this release does not know shows the check as stored', async () => {
  facts = [fact('f1', 'src/db.ts', { evidence: 'span' })];
  render(<Projects />);
  const label = await screen.findByText('span');
  expect(label.getAttribute('title')).toBe('');
});
