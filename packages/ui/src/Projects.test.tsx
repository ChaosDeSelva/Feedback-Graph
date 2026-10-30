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
let scanWarning: string | undefined;
beforeEach(() => {
  calls = [];
  scanWarning = undefined;
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
    if (url.endsWith('/cancel')) { projectList = projects; return new Response(null, { status: 204 }); }
    if (url.endsWith('/scan')) return Response.json({ ...job('queued'), ...(scanWarning ? { blocked: true, warning: scanWarning } : {}) }, { status: 202 });
    if (url.startsWith('/api/projects/demo-shop/codemap/module')) return Response.json({ file: { path: 'src/db.ts', lang: 'typescript', hash: 'h', loc: 10, isTest: false, churn: null }, symbols: [], importers: [], imports: [], tests: [], facts: [], misses: [], lessons: [] });
    if (url.startsWith('/api/projects/demo-shop/codemap/hotspots')) return Response.json({ meta: { fingerprint: 'x', builtAt: '2026-10-22T12:00:00Z', stats: { files: 40, symbols: 200, imports: 90, tests: 12 } }, hotspots: [{ path: 'src/routes/orders.ts', churn: 5, misses: 1, dependents: 2, score: 8.17 }] });
    return Response.json([]);
  }));
});
// Picking a project writes it into the address: each test starts from none.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', location.pathname); });

/** A project's row in the list (its name is also an option in the link picker). */
const row = async (name: string) => (await screen.findAllByText(name)).find((e) => e.closest('button[aria-current], li > button'))!;

test('lists projects with counts and shows facts for the selected one', async () => {
  render(<Projects />);
  expect(await screen.findByText('Use sendError for all errors')).toBeTruthy();
  expect(screen.getByText('Pagination max 50')).toBeTruthy();
  expect(screen.getByText(/3 sessions · 2 lessons · 12 facts/)).toBeTruthy();
  expect(await row('other')).toBeTruthy();
});

test('files an older scanner read are counted, with what to do: no scan starts on its own', async () => {
  projectList = [{ ...projects[0], olderScanner: 12 }, projects[1]];
  render(<Projects />);
  expect(await screen.findByText('12 files were read by an older scanner: press Scan to refresh them.')).toBeTruthy();
  expect(calls.some((c) => c.url.endsWith('/scan'))).toBe(false);
  // While a scan is queued or running it says that scan will refresh them.
  cleanup();
  projectList = [{ ...projects[0], olderScanner: 1, lastScan: job('queued') }, projects[1]];
  render(<Projects />);
  expect(await screen.findByText('1 file was read by an older scanner: the scan under way refreshes it.')).toBeTruthy();
});

test('a project with no file from an older scanner says nothing about it', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  expect(screen.queryByText(/older scanner/)).toBeNull();
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

test("an agentic scan's line says how many of its shards were rescanned (the others had not changed)", async () => {
  projectList = [{ ...projects[0], lastScan: { ...job('done'), shards: { total: 20, rescanned: 12, failed: 1 } } }, projects[1]];
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  expect(screen.getByText('12 of 20 shards rescanned, 1 failed')).toBeTruthy();
  expect(screen.queryByText(/not reached/)).toBeNull();
});

test('the scan line says how many places its agents did not reach, and exposes their list through a keyboard-accessible disclosure', async () => {
  projectList = [{ ...projects[0], lastScan: { ...job('done'), shards: { total: 20, rescanned: 12, failed: 0, unreached: ['src/svc/internal', 'src/svc/cmd'] } } }, projects[1]];
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  const line = screen.getByText('2 places not reached');
  expect(line.tagName).toBe('SUMMARY');
  fireEvent.click(line);
  expect(within(screen.getByRole('list', { name: 'Places not reached' })).getByText('src/svc/internal')).toBeTruthy();
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

test('a large upload the API takes in the background (202) says so until it is in the list', async () => {
  const base = (fetch as unknown as { getMockImplementation(): (u: string, i?: RequestInit) => Promise<Response> }).getMockImplementation();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects/demo-shop/docs' && init?.method === 'POST') return Response.json({ id: 'doc:demo-shop:upload:big.md', chunks: 1400, pending: true }, { status: 202 });
    return base(url, init);
  }));
  render(<Projects />);
  expect(await screen.findByText('me/shop#3: Orders')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('upload document'), { target: { files: [new File(['x'], 'big.md', { type: 'text/markdown' })] } });
  expect(await screen.findByText(/big\.md \(1,400 chunks\) is being embedded; it shows here once stored/)).toBeTruthy();
});

test('a project with many docs shows the newest page and loads older ones on request', async () => {
  const pr = (n: number) => ({ id: `doc:demo-shop:github:github:me/shop#${n}`, projectKey: 'demo-shop', source: 'github', ref: `github:me/shop#${n}`, title: `me/shop#${n}: change ${n}`, url: null, addedAt: 't', chunks: 1, kind: 'text', mediaType: null, read: null });
  const base = (fetch as unknown as { getMockImplementation(): (u: string, i?: RequestInit) => Promise<Response> }).getMockImplementation();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects/demo-shop/docs') return Response.json([pr(9), pr(8)], { headers: { 'x-next-cursor': 'c1' } });
    if (url === '/api/projects/demo-shop/docs?cursor=c1') { calls.push({ url }); return Response.json([pr(7)]); }
    return base(url, init);
  }));
  render(<Projects />);
  expect(await screen.findByText('me/shop#9: change 9')).toBeTruthy();
  expect(screen.getByText('Docs and discussions (2+)')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'load older docs' }));
  expect(await screen.findByText('me/shop#7: change 7')).toBeTruthy();
  expect(screen.getByText('Docs and discussions (3)')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'load older docs' })).toBeNull();
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

test('selecting or pinning a project never scrolls the page: the list scrolls only itself', async () => {
  const into = vi.fn();
  const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
  const before = proto.scrollIntoView;
  proto.scrollIntoView = into;
  try {
    render(<Projects />);
    await screen.findByText('Use sendError for all errors');
    fireEvent.click(screen.getByRole('button', { name: 'pin other' }));
    fireEvent.click(await row('other'));
    await screen.findByText(/No facts yet/);
    // scrollIntoView scrolls every scrolling ancestor, the page included; that clipped the header by ~30px.
    expect(into).not.toHaveBeenCalled();
  } finally {
    proto.scrollIntoView = before;
  }
});

test('a fact shows how well its citation was checked and, for a manifest fact, where it came from; never a confidence percentage', async () => {
  projectList = [{ ...projects[0], facts: 12, factsByOrigin: { model: 7, manifest: 4, document: 1 } }, projects[1]];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json(projectList);
    if (url.startsWith('/api/projects/demo-shop/facts')) return Response.json([
      { ...fact('f1', 'createPool returns a pg Pool'), evidence: 'line', origin: 'model' },
      { ...fact('f2', 'Pools are per process'), lines: null, evidence: 'file', origin: 'model' },
      { ...fact('f3', '`dev` script runs: vite'), path: 'package.json', lines: null, evidence: 'file', origin: 'manifest' },
      { ...fact('f4', 'An older fact') },
      { ...fact('f5', 'Uses pnpm workspaces'), lines: null, evidence: 'none', origin: 'model' },
    ]);
    return Response.json([]);
  }));
  render(<Projects />);
  const li = async (text: string) => (await screen.findByText(text)).closest('li')!;
  expect(within(await li('createPool returns a pg Pool')).getByText('line checked')).toBeTruthy();
  expect(within(await li('Pools are per process')).getByText('file only')).toBeTruthy();
  // No file to check reads as just that, never as a scope.
  expect(within(await li('Uses pnpm workspaces')).getByText('not checkable (no file)')).toBeTruthy();
  expect(screen.queryByText('project-wide')).toBeNull();
  // facts are grouped by file, the rest collapsed: open package.json's group
  fireEvent.click(screen.getByRole('button', { name: /package\.json · 1 fact/ }));
  expect(within(await li('`dev` script runs: vite')).getByText('manifest')).toBeTruthy();
  expect(within(await li('An older fact')).queryByText(/checked|file only/)).toBeNull();
  expect(screen.queryByText('90%')).toBeNull();
  // the headline is the model's facts; manifest and document facts are counted beside them
  expect(screen.getByText(/4 from manifests, 1 from documents/)).toBeTruthy();
});

test('a fact you wrote (a converted lesson) says so, keeps its relevance through rescans, and its history is the conversion', async () => {
  projectList = [{ ...projects[0], facts: 3, factsByOrigin: { model: 1, manifest: 0, document: 0, you: 2 } }, projects[1]];
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json(projectList);
    if (url.startsWith('/api/projects/demo-shop/facts')) return Response.json([
      { ...fact('f1', 'Orders are read from the source table', 'convention', 0.8), relevanceBy: 'you', source: 'you', lines: null, origin: 'you', scanJobId: null, fileHash: null, fileSummary: null, why: 'From the lesson "Read orders"' },
    ]);
    if (url.startsWith('/api/activity?')) { asked.push(url); return Response.json([{ id: 'a1', ts: '2026-10-22T20:33:00Z', kind: 'lesson_to_fact', actor: 'you', projectKey: 'demo-shop', subject: 'converted lesson "Read orders" to a convention fact', why: 'you converted it', details: {}, targets: ['lesson:1', 'f1'] }]); }
    return Response.json([]);
  }));
  render(<Projects />);
  const item = (await screen.findByText('Orders are read from the source table')).closest('li')!;
  expect(within(item).getByText('yours').getAttribute('title')).toMatch(/no scan replaces it/);
  expect(within(item).getByText(/set by you/).getAttribute('title')).toMatch(/no scan replaces it/);
  expect(screen.getByText(/2 you wrote/)).toBeTruthy();
  fireEvent.click(within(item).getByRole('button', { name: 'how was this created?' }));
  expect(await screen.findByText('you converted it')).toBeTruthy();
  expect(asked).toEqual(['/api/activity?target=f1&kind=lesson_to_fact&limit=10']);
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

test('a failed upload can be read again with Retry, without uploading it again', async () => {
  const read = (status: string) => ({ status, attempts: 1, error: status === 'failed' ? 'cannot read images: set DOCS_LLM to a model with vision' : null, retryAt: null, readAt: null, facts: 0 });
  let status = 'failed';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.method });
    if (url === '/api/projects') return Response.json(projects);
    if (url === '/api/docs/doc%3Ademo-shop%3Aupload%3Amock.png/reread' && init?.method === 'POST') { status = 'pending'; return new Response(null, { status: 204 }); }
    if (url === '/api/projects/demo-shop/docs') return Response.json([{ id: 'doc:demo-shop:upload:mock.png', projectKey: 'demo-shop', source: 'upload', ref: 'mock.png', title: 'mock.png', url: null, addedAt: 't', chunks: 1, kind: 'image', mediaType: 'image/png', read: read(status) }]);
    return Response.json([]);
  }));
  render(<Projects />);
  const item = (await screen.findByText(/not read: cannot read images/)).closest('li')!;
  fireEvent.click(within(item).getByRole('button', { name: 'retry reading mock.png' }));
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/docs/doc%3Ademo-shop%3Aupload%3Amock.png/reread', body: 'POST' }));
  expect(await screen.findByText(/queued for reading|reading/)).toBeTruthy();
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

test('a module link (#projects/<key>/<path>) opens that project and its module panel', async () => {
  location.hash = `#projects/demo-shop/${encodeURIComponent('src/ui/Modal.tsx')}`;
  projectList = [projects[1], projects[0]];
  try {
    render(<Projects />);
    expect(await screen.findByRole('region', { name: 'module src/ui/Modal.tsx' })).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain('/api/projects/demo-shop/codemap/module?path=src%2Fui%2FModal.tsx');
  } finally {
    location.hash = '';
  }
});

test('facts sort by relevance by default, grouped by file: the first group open, the rest collapsed until clicked', async () => {
  const at = (id: string, path: string, statement: string, relevance: number) => ({ ...fact(id, statement, 'convention', relevance), path });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json(projects);
    if (url.startsWith('/api/projects/demo-shop/facts')) return Response.json([at('a', 'AGENTS.md', 'Read the agents file', 0.2), at('b', 'src/db.ts', 'Scope every query', 0.9), at('c', 'src/db.ts', 'Close the pool', 0.5)]);
    return Response.json([]);
  }));
  render(<Projects />);
  expect(await screen.findByText('Scope every query')).toBeTruthy();
  expect((screen.getByLabelText('sort facts') as HTMLSelectElement).value).toBe('relevance');
  // src/db.ts holds the most relevant fact, so it comes first and open; AGENTS.md waits collapsed.
  expect(screen.getByText('Close the pool')).toBeTruthy();
  expect(screen.queryByText('Read the agents file')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /AGENTS\.md · 1 fact/ }));
  expect(screen.getByText('Read the agents file')).toBeTruthy();
});

test('facts show 25 files at a time, then more on request', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...fact(`f${i}`, `Fact number ${i}`, 'convention', 0.5), path: `src/f${String(i).padStart(2, '0')}.ts` }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json(projects);
    if (url.startsWith('/api/projects/demo-shop/facts')) return Response.json(many);
    return Response.json([]);
  }));
  render(<Projects />);
  await screen.findByText('Fact number 0');
  expect(screen.getAllByRole('button', { name: /src\/f\d\d\.ts · 1 fact/ })).toHaveLength(25);
  fireEvent.click(screen.getByRole('button', { name: 'Show 5 more files' }));
  expect(screen.getAllByRole('button', { name: /src\/f\d\d\.ts · 1 fact/ })).toHaveLength(30);
});

test('a long fact is cut short with "show all"', async () => {
  const long = `Dependencies: ${'react, '.repeat(80)}end-of-list`;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') return Response.json(projects);
    if (url.startsWith('/api/projects/demo-shop/facts')) return Response.json([fact('f1', long)]);
    return Response.json([]);
  }));
  render(<Projects />);
  expect(await screen.findByText(/^Dependencies: react/)).toBeTruthy();
  expect(screen.queryByText(/end-of-list/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'show all' }));
  expect(screen.getByText(/end-of-list/)).toBeTruthy();
});

test('a fact file name opens that file module panel in the code map', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  fireEvent.click(screen.getAllByRole('button', { name: 'open module src/db.ts' })[0]);
  expect(await screen.findByRole('region', { name: 'module src/db.ts' })).toBeTruthy();
  expect(calls.some((c) => c.url === '/api/projects/demo-shop/codemap/module?path=src%2Fdb.ts')).toBe(true);
});

test('a Projects link followed while the page is open switches to that project (a Rebuild acts on the project shown)', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  expect(screen.getByRole('heading', { name: 'demo-shop' })).toBeTruthy();
  try {
    location.hash = '#projects/other';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { name: 'other' })).toBeTruthy();
    location.hash = `#projects/demo-shop/${encodeURIComponent('src/db.ts')}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('region', { name: 'module src/db.ts' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'demo-shop' })).toBeTruthy();
  } finally {
    location.hash = '';
  }
});

test('picking a project in the list puts it in the address, so the URL names the project shown', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  try {
    fireEvent.click(await row('other'));
    expect(location.hash).toBe('#projects/other');
  } finally {
    location.hash = '';
  }
});

/**
 * An absolutely positioned box (a visually hidden file input, a pin button) with no positioned ancestor inside its
 * scrolling pane is placed against the page, not the pane: it stretches the page, which then scrolls as a whole.
 */
function escapesItsPane(el: Element): boolean {
  const positioned = /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/;
  const scrolls = /(^|\s)(md:)?overflow-(y-)?(auto|scroll)(\s|$)/;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (positioned.test(p.className)) return false;
    if (scrolls.test(p.className)) return true;
  }
  return false;
}

test('only the panes scroll: nothing hidden or floating on the Projects page is placed against the page', async () => {
  render(<Projects />);
  await screen.findByText('Use sendError for all errors');
  await screen.findByLabelText('upload document');
  const floating = [...document.querySelectorAll('.sr-only, .absolute')];
  expect(floating.length).toBeGreaterThan(0);
  expect(floating.filter(escapesItsPane).map((e) => e.outerHTML.slice(0, 120))).toEqual([]);
});


test('Scan displays a parked-runner warning instead of silently accepting the queue', async () => {
  scanWarning = 'Scan queued but parked: sandbox cannot start. No repository will be copied until runner readiness succeeds.';
  render(<Projects />);
  const button = await screen.findByRole('button', { name: /^Scan$/ });
  fireEvent.click(button);
  expect(await screen.findByText(scanWarning)).toBeTruthy();
});


test('parked queued scans show the reason and allow cancellation or changing provider', async () => {
  projectList = [{ ...projects[0], lastScan: { ...job('queued'), error: 'sandbox cannot mount proc' } }];
  render(<Projects />);
  await screen.findByText('sandbox cannot mount proc');
  fireEvent.change(screen.getByLabelText('provider'), { target: { value: 'claude-cli' } });
  fireEvent.click(screen.getByRole('button', { name: 'Switch provider and scan' }));
  await waitFor(() => expect(calls.some(c => c.url.endsWith('/cancel'))).toBe(true));
  await waitFor(() => expect(calls.find(c => c.url.endsWith('/scan'))?.body).toEqual({ provider: 'claude-cli' }));
});
