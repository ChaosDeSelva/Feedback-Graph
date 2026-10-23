import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Projects } from './Projects.tsx';

const job = (status: string) => ({
  id: 'scan:1', projectKey: 'demo-shop', repoPath: '/examples/demo-shop', provider: 'ollama:gemma4', status,
  requestedAt: '2026-10-22T10:00:00Z', startedAt: null, finishedAt: null, filesScanned: 4, factsAdded: 12, error: null,
});
const projects = [
  { key: 'demo-shop', repoPath: '/examples/demo-shop', remote: 'github.com/me/shop', aliases: ['shop-copy'], sessions: 3, feedback: 1, lessons: 2, facts: 12, lastScan: job('done') },
  { key: 'other', repoPath: '/vibe/other', remote: null, aliases: [], sessions: 0, feedback: 0, lessons: 0, facts: 0, lastScan: null },
];
const fact = (id: string, statement: string, kind = 'convention') => ({
  id, kind, statement, path: 'src/db.ts', lines: '1-10', confidence: 0.9, source: 'ollama:gemma4', createdAt: '2026-10-22T20:33:00Z',
  why: `agents need ${statement}`, scanJobId: 'scan:1', fileHash: 'abc1234def', fileSummary: 'Data access layer',
});

let calls: { url: string; body?: unknown }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/projects') return Response.json(projects);
    if (url.startsWith('/api/projects/demo-shop/facts?q=')) return Response.json([{ fact: fact('f9', 'Routes must use db.scoped(orgId)', 'security'), score: 0.91 }]);
    if (url.startsWith('/api/projects/demo-shop/facts')) return Response.json([fact('f1', 'Use sendError for all errors'), fact('f2', 'Pagination max 50', 'invariant')]);
    if (url.startsWith('/api/activity?')) return Response.json([{ id: 'a1', ts: '2026-10-22T20:33:00Z', kind: 'facts_extracted', actor: 'ollama:gemma4', projectKey: 'demo-shop', subject: '2 facts from src/db.ts', why: 'new file, never scanned before', details: {}, targets: [] }]);
    if (url === '/api/projects/demo-shop/docs' && init?.method === 'POST') return Response.json({ id: 'doc:demo-shop:upload:spec.md', chunks: 2 }, { status: 201 });
    if (url === '/api/projects/demo-shop/docs') return Response.json([{ id: 'doc:demo-shop:github:github:me/shop#3', projectKey: 'demo-shop', source: 'github', ref: 'github:me/shop#3', title: 'me/shop#3: Orders', url: 'https://github.com/me/shop/pull/3', addedAt: 't', chunks: 4 }]);
    if (url.startsWith('/api/docs/') && init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/scan')) return Response.json(job('queued'), { status: 202 });
    if (url.startsWith('/api/projects/demo-shop/codemap/hotspots')) return Response.json({ meta: { fingerprint: 'x', builtAt: '2026-10-22T12:00:00Z', stats: { files: 40, symbols: 200, imports: 90, tests: 12 } }, hotspots: [{ path: 'src/routes/orders.ts', churn: 5, misses: 1, dependents: 2, score: 8.17 }] });
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('lists projects with counts and shows facts for the selected one', async () => {
  render(<Projects />);
  expect(await screen.findByText('Use sendError for all errors')).toBeTruthy();
  expect(screen.getByText('Pagination max 50')).toBeTruthy();
  expect(screen.getByText(/3 sessions · 2 lessons · 12 facts/)).toBeTruthy();
  expect(screen.getByText('other')).toBeTruthy();
});

test('each project shows its git remote under its name, and the selected one its other clones', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  expect(screen.getByText('github.com/me/shop', { selector: 'li *' })).toBeTruthy();
  expect(screen.getByText(/also cloned in shop-copy/)).toBeTruthy();
});

test('scan button queues a scan with the chosen provider', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  fireEvent.change(screen.getByLabelText('provider'), { target: { value: 'codex-cli' } });
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/projects/demo-shop/scan', body: { provider: 'codex-cli' } }));
  expect(await screen.findByText('queued', { selector: 'span' })).toBeTruthy();
});

test('default provider sends an empty body so the worker default applies', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/projects/demo-shop/scan', body: {} }));
});

test('search shows semantic hits', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  fireEvent.change(screen.getByLabelText('search facts'), { target: { value: 'tenant isolation' } });
  fireEvent.submit(screen.getByLabelText('search facts').closest('form')!);
  expect(await screen.findByText('Routes must use db.scoped(orgId)')).toBeTruthy();
  expect(calls.some((c) => c.url === '/api/projects/demo-shop/facts?q=tenant+isolation')).toBe(true);
});

test('kind filter refetches facts by kind', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  fireEvent.change(screen.getByLabelText('kind'), { target: { value: 'invariant' } });
  await waitFor(() => expect(calls.some((c) => c.url === '/api/projects/demo-shop/facts?kind=invariant')).toBe(true));
});

test('each fact can show how it was created: model, why, scan, file version, and the scan log', async () => {
  render(<Projects />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'how was this created?' }))[0]);
  expect(await screen.findByText('agents need Use sendError for all errors')).toBeTruthy();
  expect(screen.getByText(/abc1234/)).toBeTruthy();
  expect(screen.getByText(/Data access layer/)).toBeTruthy();
  expect(await screen.findByText('new file, never scanned before')).toBeTruthy();
  expect(calls.some((c) => c.url === '/api/activity?target=demo-shop%3Asrc%2Fdb.ts&kind=facts_extracted&limit=10')).toBe(true);
});

test('lists the project docs and uploads a text file as context', async () => {
  render(<Projects />);
  expect(await screen.findByText('me/shop#3: Orders')).toBeTruthy();
  const file = new File(['# Spec\n\nLists are paginated.'], 'spec.md', { type: 'text/markdown' });
  fireEvent.change(screen.getByLabelText('upload document'), { target: { files: [file] } });
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/projects/demo-shop/docs', body: { title: 'spec.md', name: 'spec.md', text: '# Spec\n\nLists are paginated.' } }));
});

test('a doc can be removed', async () => {
  render(<Projects />);
  await screen.findByText('me/shop#3: Orders');
  fireEvent.click(screen.getByRole('button', { name: 'remove me/shop#3: Orders' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/docs/doc%3Ademo-shop%3Agithub%3Agithub%3Ame%2Fshop%233')).toBe(true));
});

test('facts reload by themselves when a running scan finishes', async () => {
  let scans = 0;
  let factsCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json([{ ...projects[0], lastScan: job(scans++ < 1 ? 'running' : 'done') }]);
    if (url.startsWith('/api/projects/demo-shop/facts')) {
      factsCalls++;
      return Response.json(factsCalls === 1 ? [] : [fact('f3', 'Fresh fact from the new scan')]);
    }
    return Response.json([]);
  }));
  render(<Projects pollMs={20} />);
  expect(await screen.findByText('Fresh fact from the new scan')).toBeTruthy();
});

test('deleting a project asks you to type its name first', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  fireEvent.click(screen.getByRole('button', { name: /delete project data/i }));
  const confirm = screen.getByRole('button', { name: /delete everything learned/i }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('type the project name to confirm'), { target: { value: 'demo-shop' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(calls.some((c) => c.url === '/api/projects/demo-shop' && (c.body as { confirm?: string })?.confirm === 'demo-shop')).toBe(true));
});

test('export downloads the project bundle', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  expect(screen.getByRole('link', { name: /export/i }).getAttribute('href')).toBe('/api/export?project=demo-shop');
});

test('the selected project shows its code map with hotspots', async () => {
  render(<Projects />);
  const card = await screen.findByRole('region', { name: /code map/i });
  expect(await within(card).findByText('src/routes/orders.ts')).toBeTruthy();
  expect(within(card).getByLabelText('files').textContent).toContain('40');
});

test('slow facts or docs for the project you left never show under the one you picked', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json(projects);
    if (url.startsWith('/api/projects/demo-shop/facts')) { await new Promise((r) => setTimeout(r, 80)); return Response.json([fact('f1', 'Use sendError for all errors')]); }
    if (url.startsWith('/api/projects/other/facts')) return Response.json([fact('f5', 'Other project fact')]);
    if (url === '/api/projects/demo-shop/docs') { await new Promise((r) => setTimeout(r, 80)); return Response.json([{ id: 'doc:d1', projectKey: 'demo-shop', source: 'upload', ref: 'upload:a.md', title: 'Shop spec', url: null, addedAt: 't', chunks: 1 }]); }
    return Response.json([]);
  }));
  render(<Projects />);
  fireEvent.click(await screen.findByText('other'));
  expect(await screen.findByText('Other project fact')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 120));
  expect(screen.getByText('Other project fact')).toBeTruthy();
  expect(screen.queryByText('Use sendError for all errors')).toBeNull();
  expect(screen.queryByText('Shop spec')).toBeNull();
});
