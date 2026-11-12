import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectDocs } from './ProjectDocs.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const ID = 'doc:demo-shop:upload:big.md';
const doc = (o: object = {}) => ({ id: ID, projectKey: 'demo-shop', source: 'upload', ref: 'big.md', title: 'big.md', url: null, addedAt: 't', addedBy: 'you', chunks: 3, kind: 'text', mediaType: null, read: null, ...o });

/** The docs API: `list` is the first page, `byId` answers GET /api/docs/:id in turn (the last repeats); counts the GETs by id. */
function api(list: () => object[], ...byId: (object | null)[]) {
  const asked = { byId: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects/demo-shop/docs' && init?.method === 'POST') return Response.json({ id: ID, chunks: 1400, pending: true }, { status: 202 });
    if (url === '/api/projects/demo-shop/docs') return Response.json(list());
    if (url === `/api/docs/${encodeURIComponent(ID)}`) {
      const r = byId[Math.min(asked.byId++, byId.length - 1)];
      return r ? Response.json(r) : Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json([]);
  }));
  return asked;
}
const upload = () => fireEvent.change(screen.getByLabelText('upload document'), { target: { files: [new File(['x'], 'big.md', { type: 'text/markdown' })] } });
/** How many more checks the page makes over a long stretch of (fake) time: none once it has stopped checking. */
const settle = async (asked: { byId: number }) => {
  const at = asked.byId;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  return asked.byId - at;
};

test('a large upload whose embedding fails says why on the page, and stops checking', async () => {
  // Polling runs on fake timers that also follow the clock, so the check for no further polls can step well past it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const asked = api(() => [], doc({ chunks: 0, embed: { status: 'pending', chunks: 1400 } }), doc({ chunks: 0, embed: { status: 'failed', error: 'ollama embed 500: model not loaded', chunks: 1400 } }));
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={10} />);
  upload();
  expect(await screen.findByText(/big\.md \(1,400 chunks\) is being embedded/)).toBeTruthy();
  expect(await screen.findByText(/big\.md could not be stored: ollama embed 500: model not loaded/)).toBeTruthy();
  expect(screen.queryByText(/is being embedded/)).toBeNull();
  expect(await settle(asked)).toBe(0);
});

test('re-uploading a file of the same name shows the listed document as pending, then the new version', async () => {
  let version = 1;
  const listed = () => [version === 1 ? doc({ title: 'big.md v1' }) : doc({ title: 'big.md v2', chunks: 1400 })];
  const asked = api(listed, doc({ title: 'big.md v1', embed: { status: 'pending', chunks: 1400 } }));
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={10} />);
  expect(await screen.findByText('big.md v1')).toBeTruthy();
  upload();
  // The note shows even though a document of that id is already listed (0.6.3 hid it, and kept showing the old one as current).
  expect(await screen.findByText(/big\.md \(1,400 chunks\) is being embedded/)).toBeTruthy();
  await waitFor(() => expect(asked.byId).toBeGreaterThan(1));
  version = 2;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects/demo-shop/docs') return Response.json(listed());
    if (url === `/api/docs/${encodeURIComponent(ID)}`) return Response.json(doc({ title: 'big.md v2', chunks: 1400 }));
    return Response.json([]);
  }));
  expect(await screen.findByText('big.md v2')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText(/is being embedded/)).toBeNull());
});

test('a listed document whose new version is being embedded, or failed to be, says so in its row', async () => {
  api(() => [doc({ title: 'a.md', embed: { status: 'pending', chunks: 900 } }), doc({ id: 'doc:demo-shop:upload:b.md', ref: 'b.md', title: 'b.md', embed: { status: 'failed', error: 'timed out', chunks: 900 } })]);
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={10} />);
  expect(await screen.findByText('embedding a new version…')).toBeTruthy();
  expect(screen.getByText('new version not stored: timed out')).toBeTruthy();
});

test('checking on an upload stops after a bound, and stops when the server no longer knows it', async () => {
  // Polling runs on fake timers that also follow the clock, so the check for no further polls can step well past it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const asked = api(() => [], doc({ chunks: 0, embed: { status: 'pending', chunks: 1400 } }));
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={5} maxEmbedPolls={4} />);
  upload();
  expect(await screen.findByText(/big\.md is still being embedded; it shows here once stored, and Activity says if it fails/)).toBeTruthy();
  expect(asked.byId).toBeLessThanOrEqual(5);
  expect(await settle(asked)).toBe(0);
  cleanup();

  const gone = api(() => [], null);
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={5} />);
  upload();
  expect(await screen.findByText(/big\.md could not be stored: the server no longer has it/)).toBeTruthy();
  expect(await settle(gone)).toBe(0);
});

test('a check that cannot reach the server leaves the upload pending, and the next check finds it stored', async () => {
  let checks = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects/demo-shop/docs' && init?.method === 'POST') return Response.json({ id: ID, chunks: 1400, pending: true }, { status: 202 });
    if (url === '/api/projects/demo-shop/docs') return Response.json(checks > 1 ? [doc({ chunks: 1400 })] : []);
    if (url === `/api/docs/${encodeURIComponent(ID)}`) {
      if (++checks === 1) throw new TypeError('Failed to fetch');
      return Response.json(doc({ chunks: 1400 }));
    }
    return Response.json([]);
  }));
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={10} />);
  upload();
  expect(await screen.findByText(/big\.md \(1,400 chunks\) is being embedded/)).toBeTruthy();
  expect(await screen.findByText('big.md')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText(/is being embedded/)).toBeNull());
  expect(screen.queryByText(/could not be stored/)).toBeNull();
  expect(checks).toBeGreaterThanOrEqual(2);
});

/** A page of one failed-to-read upload with older ones behind it, where every write and the older page are refused. */
function refusing() {
  const onError = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/projects/demo-shop/docs' && method === 'GET') {
      return Response.json([doc({ read: { status: 'failed', facts: 0, error: 'no model' } })], { headers: { 'x-next-cursor': 'c2' } });
    }
    if (method !== 'GET' || url.includes('cursor=')) return Response.json({ error: `refused ${method}` }, { status: 409 });
    return Response.json([]);
  }));
  render(<ProjectDocs projectKey="demo-shop" onError={onError} pollMs={10} />);
  return onError;
}

test('an upload the server refuses is reported', async () => {
  const onError = refusing();
  await screen.findByText('big.md');
  upload();
  await waitFor(() => expect(onError).toHaveBeenCalledWith('refused POST'));
});

test('a refused re-read, removal or older page is reported, and the document stays listed', async () => {
  const onError = refusing();
  fireEvent.click(await screen.findByRole('button', { name: 'retry reading big.md' }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith('refused POST'));
  fireEvent.click(screen.getByRole('button', { name: 'load older docs' }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith('refused GET'));
  fireEvent.click(screen.getByRole('button', { name: 'remove big.md' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove document' }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith('refused DELETE'));
  expect(screen.getByText('big.md')).toBeTruthy();
});

test('each upload says where its reading stands, in words, without a reason when the worker gave none', async () => {
  const at = '2026-10-22T10:00:00.000Z';
  const d = (id: string, o: object) => doc({ id: `doc:${id}`, title: id, ...o });
  api(() => [
    d('a.md', { embed: { status: 'failed', chunks: 3 } }),
    d('b.md', { read: { status: 'reading', attempts: 0, facts: 0 } }),
    d('c.md', { read: { status: 'pending', attempts: 1, retryAt: at, facts: 0 } }),
    d('d.md', { read: { status: 'pending', attempts: 2, retryAt: null, facts: 0 } }),
    d('e.md', { read: { status: 'failed', attempts: 3, facts: 0 } }),
    d('f.md', { read: { status: 'done', attempts: 1, facts: 2, readAt: null } }),
  ]);
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={60_000} />);
  expect(await screen.findByText('new version not stored: unknown error')).toBeTruthy();
  expect(screen.getByText('reading…')).toBeTruthy();
  expect(screen.getByText(`reading again at ${new Date(at).toLocaleTimeString()}…`)).toBeTruthy();
  expect(screen.getByText('reading again…')).toBeTruthy();
  expect(screen.getByText('not read: unknown error')).toBeTruthy();
  expect(screen.getByText('2 facts').getAttribute('title')).toBeNull();
});

test('removing an upload that was read into facts says the facts go too', async () => {
  api(() => [doc({ read: { status: 'done', attempts: 1, facts: 4, readAt: '2026-10-22T10:00:00.000Z' } })]);
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'remove big.md' }));
  expect((await screen.findByRole('alertdialog')).textContent).toMatch(/Its 3 chunks and 4 facts are deleted from demo-shop/);
});

test('a file whose name has nothing the server accepts is uploaded as document.txt; closing the picker uploads nothing', async () => {
  const posts: unknown[] = [];
  const inner = (api(() => []), fetch) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body as string)); return Response.json({ id: ID, chunks: 1 }, { status: 201 }); }
    return inner(url, init);
  }));
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} />);
  const input = screen.getByLabelText('upload document');
  fireEvent.change(input, { target: { files: [] } });
  fireEvent.change(input, { target: { files: [new File(['notes'], '...', { type: 'text/plain' })] } });
  await waitFor(() => expect(posts).toEqual([{ title: '...', name: 'document.txt', text: 'notes' }]));
});

test('a large upload whose embedding fails without a reason says the reason is unknown', async () => {
  api(() => [], doc({ chunks: 0, embed: { status: 'failed', chunks: 1400 } }));
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={10} />);
  upload();
  expect(await screen.findByText(/big\.md could not be stored: unknown error/)).toBeTruthy();
});

test('a check on an upload that answers after the page is gone does nothing', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let answered!: () => void;
  const checked = new Promise<void>((r) => { answered = r; });
  let asking = false;
  const lists: string[] = [];
  const inner = (api(() => [], doc({ chunks: 1400 })), fetch) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/docs/')) { asking = true; await held; const r = await inner(url, init); answered(); return r; }
    if (url === '/api/projects/demo-shop/docs' && !init?.method) lists.push(url);
    return inner(url, init);
  }));
  const { unmount } = render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={10} />);
  upload();
  await screen.findByText(/is being embedded/);
  // The page has asked about the upload; its answer is held until the page is gone.
  await waitFor(() => expect(asking).toBe(true));
  const before = lists.length;
  unmount();
  release();
  // The check answers into a page that is gone; give whatever it would do (a list reload) its turn.
  await act(async () => { await checked; await new Promise((r) => setTimeout(r, 0)); });
  expect(lists.length).toBe(before);
});

test('with more than one page shown, a refresh while a document is read asks for all of them', async () => {
  const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => doc({ id: `doc:${from + i}`, title: `d${from + i}.md`, read: from + i === 0 ? { status: 'reading', attempts: 0, facts: 0 } : null }));
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url === '/api/projects/demo-shop/docs') return Response.json(page(100, 0), { headers: { 'x-next-cursor': 'c2' } });
    if (url === '/api/projects/demo-shop/docs?cursor=c2') return Response.json(page(20, 100));
    return Response.json(page(120, 0));
  }));
  render(<ProjectDocs projectKey="demo-shop" onError={() => {}} pollMs={20} />);
  fireEvent.click(await screen.findByRole('button', { name: 'load older docs' }));
  await screen.findByText('d119.md');
  await waitFor(() => expect(urls).toContain('/api/projects/demo-shop/docs?limit=120'));
});

test('retry reading says retrying… on that document while the request is in flight', async () => {
  refusing();
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === 'POST') await gate; return inner(url, init); }));
  const retry = await screen.findByRole('button', { name: 'retry reading big.md' });
  fireEvent.click(retry);
  await waitFor(() => expect(retry.textContent).toBe('retrying…'));
  expect(retry.getAttribute('aria-disabled')).toBe('true');
  release();
  await waitFor(() => expect(retry.textContent).toBe('retry'));
});
