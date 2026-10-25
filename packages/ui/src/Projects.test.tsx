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
const fact = (id: string, statement: string, kind = 'convention', relevance: number | null = null) => ({
  id, kind, statement, path: 'src/db.ts', lines: '1-10', confidence: 0.9, source: 'ollama:gemma4', createdAt: '2026-10-22T20:33:00Z',
  why: `agents need ${statement}`, scanJobId: 'scan:1', fileHash: 'abc1234def', fileSummary: 'Data access layer',
  relevance, relevanceBy: relevance === null ? null : 'model',
});

let calls: { url: string; body?: unknown }[];
let projectList: unknown[];
beforeEach(() => {
  calls = [];
  projectList = projects;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/projects') return Response.json(projectList);
    if (url.startsWith('/api/projects/demo-shop/facts?q=')) return Response.json([{ fact: fact('f9', 'Routes must use db.scoped(orgId)', 'security'), score: 0.91 }]);
    if (url.includes('/relevance') && init?.method === 'PATCH') return new Response(null, { status: 204 });
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

/** A project's row in the list (its name is also an option in the link picker). */
const row = async (name: string) => (await screen.findAllByText(name)).find((e) => e.closest('button[aria-current], li > button'))!;

test('lists projects with counts and shows facts for the selected one', async () => {
  render(<Projects />);
  expect(await screen.findByText('Use sendError for all errors')).toBeTruthy();
  expect(screen.getByText('Pagination max 50')).toBeTruthy();
  expect(screen.getByText(/3 sessions · 2 lessons · 12 facts/)).toBeTruthy();
  expect(await row('other')).toBeTruthy();
});

test('a queued scan shows its place in the queue (scans waiting out a retry are not counted ahead of it)', async () => {
  const at = (status: string, id: string, requestedAt: string, retryAt: string | null = null) => ({ ...job(status), id, requestedAt, retryAt, attempts: retryAt ? 1 : 0 });
  projectList = [
    { ...projects[0], lastScan: at('queued', 'scan:a', '2026-10-22T10:05:00Z') },
    { ...projects[1], lastScan: at('queued', 'scan:b', '2026-10-22T10:00:00Z') },
    { ...projects[1], key: 'third', lastScan: at('queued', 'scan:c', '2026-10-22T09:00:00Z', '2999-01-01T00:00:00Z') },
    { ...projects[1], key: 'fourth', lastScan: at('running', 'scan:d', '2026-10-22T08:00:00Z') },
  ];
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  expect(screen.getByText(/2nd in the queue/)).toBeTruthy();
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

const removedDoc = () => calls.some((c) => c.url === '/api/docs/doc%3Ademo-shop%3Agithub%3Agithub%3Ame%2Fshop%233');

test('removing a doc asks first, naming it; Cancel or Escape keeps it', async () => {
  render(<Projects />);
  await screen.findByText('me/shop#3: Orders');
  fireEvent.click(screen.getByRole('button', { name: 'remove me/shop#3: Orders' }));
  const ask = await screen.findByRole('alertdialog', { name: /remove this document/i });
  expect(within(ask).getByRole('list', { name: 'will be removed' }).textContent).toBe('me/shop#3: Orders');
  expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Cancel' }));
  fireEvent.keyDown(ask, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'remove me/shop#3: Orders' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(removedDoc()).toBe(false);
  expect(screen.getByText('me/shop#3: Orders')).toBeTruthy();
});

test('a doc can be removed once you confirm', async () => {
  render(<Projects />);
  await screen.findByText('me/shop#3: Orders');
  fireEvent.click(screen.getByRole('button', { name: 'remove me/shop#3: Orders' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove document' }));
  await waitFor(() => expect(removedDoc()).toBe(true));
  await waitFor(() => expect(screen.queryByText('me/shop#3: Orders')).toBeNull());
  expect(screen.queryByRole('alertdialog')).toBeNull();
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

test('deleting a project opens a dialog that says what goes and wants its name typed', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  fireEvent.click(screen.getByRole('button', { name: /delete project data/i }));
  const ask = await screen.findByRole('alertdialog', { name: 'Delete everything learned from demo-shop?' });
  expect(ask.textContent).toMatch(/every session, flag, decision, post-mortem, lesson, fact, document and log entry/);
  expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Cancel' }));
  const confirm = within(ask).getByRole('button', { name: /delete everything learned/i }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(within(ask).getByLabelText('type demo-shop to confirm'), { target: { value: 'demo-shop' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(calls.some((c) => c.url === '/api/projects/demo-shop' && (c.body as { confirm?: string })?.confirm === 'demo-shop')).toBe(true));
});

test('cancelling the project delete removes nothing', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  fireEvent.click(screen.getByRole('button', { name: /delete project data/i }));
  fireEvent.mouseDown(await screen.findByTestId('confirm-backdrop'));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(calls.some((c) => c.url === '/api/projects/demo-shop' && c.body)).toBe(false);
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
  fireEvent.click(await row('other'));
  expect(await screen.findByText('Other project fact')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 120));
  expect(screen.getByText('Other project fact')).toBeTruthy();
  expect(screen.queryByText('Use sendError for all errors')).toBeNull();
  expect(screen.queryByText('Shop spec')).toBeNull();
});

test('each fact shows its everyday relevance, and you can set it; sorting by relevance puts everyday facts first', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/projects') return Response.json(projects);
    if (url.includes('/relevance') && init?.method === 'PATCH') return new Response(null, { status: 204 });
    if (url.startsWith('/api/projects/demo-shop/facts')) return Response.json([fact('f1', 'Install the profiler app', 'config', 0.1), fact('f2', 'Every query is scoped by orgId', 'security', 0.9), fact('f3', 'Unscored one')]);
    return Response.json([]);
  }));
  render(<Projects />);
  const setup = (await screen.findByText('Install the profiler app')).closest('li')!;
  // The badge carries the band's meaning as its title; the buttons beside it share its words.
  expect(within(setup).getByTitle(/rarely needed while coding/).textContent).toBe('rare');
  expect(within(screen.getByText('Unscored one').closest('li')!).getByTitle(/not scored yet/).textContent).toBe('unscored');
  fireEvent.click(within(setup).getByRole('button', { name: 'mark everyday' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/projects/demo-shop/facts/f1/relevance' && (c.body as { relevance: number }).relevance === 0.9)).toBe(true));
  expect((await within(setup).findByTitle(/needed in most changes/)).textContent).toBe('everyday');
  expect(within(setup).getByText(/set by you/)).toBeTruthy();
  // A rescan of the file makes new facts, scored again: said where you set it.
  expect(within(setup).getByText(/set by you/).getAttribute('title')).toMatch(/rescan/);

  fireEvent.change(screen.getByLabelText('sort facts'), { target: { value: 'relevance' } });
  const order = screen.getAllByRole('listitem').map((li) => li.textContent ?? '').filter((t) => /profiler|orgId|Unscored/.test(t));
  expect(order[order.length - 1]).toMatch(/Unscored/);
});

test('pin a project from the list: it moves to the top and stays marked pinned', async () => {
  let pinned = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/projects/other/pin' && init?.method === 'PUT') { pinned = true; return new Response(null, { status: 204 }); }
    if (url === '/api/projects') return Response.json(pinned ? [{ ...projects[1], pinned: true }, projects[0]] : projects);
    return Response.json([]);
  }));
  render(<Projects />);
  fireEvent.click(await screen.findByRole('button', { name: 'pin other' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/projects/other/pin' && (c.body as { pinned: boolean }).pinned === true)).toBe(true));
  const unpin = await screen.findByRole('button', { name: 'unpin other' });
  expect(unpin.getAttribute('aria-pressed')).toBe('true');
  const rows = screen.getAllByRole('button', { name: /^(pin|unpin) / }).map((b) => b.getAttribute('aria-label'));
  expect(rows).toEqual(['unpin other', 'pin demo-shop']);
});

test('uploads an image as context: sent as base64 with its type, never as text', async () => {
  render(<Projects />);
  await screen.findByText('me/shop#3: Orders');
  const input = screen.getByLabelText('upload document') as HTMLInputElement;
  expect(input.accept).toMatch(/image\/png/);
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'flow.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/projects/demo-shop/docs', body: { title: 'flow.png', name: 'flow.png', image: { mediaType: 'image/png', data: 'iVBORw==' } } }));
});

test('each upload shows whether it was read into facts: reading, how many facts, or why it failed; images show a thumbnail', async () => {
  const read = (status: string, over: object = {}) => ({ status, attempts: 0, error: null, retryAt: null, readAt: null, facts: 0, ...over });
  const up = (ref: string, over: object) => ({ id: `doc:demo-shop:upload:${ref}`, projectKey: 'demo-shop', source: 'upload', ref, title: ref, url: null, addedAt: 't', chunks: 1, kind: 'text', mediaType: null, read: read('done'), ...over });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url });
    if (url === '/api/projects') return Response.json(projects);
    if (url === '/api/projects/demo-shop/docs') return Response.json([
      up('flow.png', { kind: 'image', mediaType: 'image/png', read: read('pending') }),
      up('spec.md', { read: read('done', { facts: 3, readAt: '2026-10-24T10:00:00Z' }) }),
      up('mock.png', { kind: 'image', mediaType: 'image/png', read: read('failed', { attempts: 1, error: 'jev cannot read images: set DOCS_LLM to a model with vision' }) }),
    ]);
    return Response.json([]);
  }));
  render(<Projects />);
  const row = async (name: string) => (await screen.findByText(name)).closest('li')!;
  expect(within(await row('flow.png')).getByText(/reading/)).toBeTruthy();
  expect(within(await row('spec.md')).getByText('3 facts')).toBeTruthy();
  expect(within(await row('mock.png')).getByText(/jev cannot read images/)).toBeTruthy();
  const thumb = within(await row('flow.png')).getByRole('img', { name: 'flow.png' }) as HTMLImageElement;
  expect(thumb.getAttribute('src')).toBe('/api/docs/doc%3Ademo-shop%3Aupload%3Aflow.png/image');
});

test('a fact read from a document says so, and its history is the document reading', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url });
    if (url === '/api/projects') return Response.json(projects);
    if (url.startsWith('/api/projects/demo-shop/facts')) return Response.json([{ ...fact('fd', 'Checkout asks for the address first', 'architecture', 0.8), path: 'flow.png', lines: null, docId: 'doc:demo-shop:upload:flow.png', fileHash: null, fileSummary: null, scanJobId: null }]);
    return Response.json([]);
  }));
  render(<Projects />);
  const item = (await screen.findByText('Checkout asks for the address first')).closest('li')!;
  expect(within(item).getByText(/from your document flow\.png/)).toBeTruthy();
  fireEvent.click(within(item).getByRole('button', { name: 'how was this created?' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/activity?target=doc%3Ademo-shop%3Aupload%3Aflow.png&kind=doc_read&limit=10')).toBe(true));
});
