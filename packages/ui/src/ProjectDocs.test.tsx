import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectDocs } from './ProjectDocs.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
const settle = async (asked: { byId: number }) => {
  const at = asked.byId;
  await new Promise((r) => setTimeout(r, 80));
  return asked.byId - at;
};

test('a large upload whose embedding fails says why on the page, and stops checking', async () => {
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
