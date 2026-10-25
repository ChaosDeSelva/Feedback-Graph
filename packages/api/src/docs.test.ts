import type { ActivityInput } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

function setup() {
  const upserts: { doc: object; chunks: { text: string }[]; opts?: object }[] = [];
  const deleted: string[] = [];
  const recorded: ActivityInput[] = [];
  const app = createApp(repo, {
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: {
      upsertDoc: async (doc, chunks, opts) => { upserts.push({ doc, chunks, opts }); return `doc:shop:upload:${doc.ref}`; },
      listDocs: async () => [],
      deleteDoc: async (id) => { deleted.push(id); return id === 'doc:shop:upload:a.md'; },
      docImage: async (id) => (id === 'doc:shop:upload:flow.png' ? { mediaType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') } : null),
    },
    activity: { record: async (a) => { recorded.push(a); }, list: async () => [] },
  });
  return { app, upserts, deleted, recorded };
}
const post = (body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) });

test('uploading a document chunks, redacts, embeds and logs it', async () => {
  const { app, upserts, recorded } = setup();
  const text = `# Spec\n\nEvery list is paginated.\n\nkey: sk-ant-api03-${'a'.repeat(40)}`;
  const res = await app.request('/api/projects/shop/docs', post({ title: 'Product spec', name: 'spec.md', text }));
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ id: 'doc:shop:upload:spec.md', chunks: 1 });
  expect(upserts[0].doc).toEqual({ projectKey: 'shop', source: 'upload', ref: 'spec.md', title: 'Product spec', url: null });
  expect(upserts[0].chunks[0].text).toContain('Every list is paginated.');
  expect(upserts[0].chunks[0].text).not.toContain('sk-ant-api03');
  // Uploads are queued to be read into facts.
  expect(upserts[0].opts).toEqual({ read: true });
  expect(recorded[0]).toMatchObject({ kind: 'doc_added', actor: 'you', projectKey: 'shop', subject: 'uploaded "Product spec" (1 chunk)', targets: ['doc:shop:upload:spec.md'] });
});

test('uploads are validated: unknown project, empty text, oversized text, bad names', async () => {
  const { app } = setup();
  expect((await app.request('/api/projects/nope/docs', post({ title: 't', name: 'a.md', text: 'x' }))).status).toBe(404);
  expect((await app.request('/api/projects/shop/docs', post({ title: 't', name: 'a.md', text: '' }))).status).toBe(400);
  expect((await app.request('/api/projects/shop/docs', post({ title: 't', name: 'a.md', text: 'x'.repeat(2_000_001) }))).status).toBe(400);
  expect((await app.request('/api/projects/shop/docs', post({ title: 't', name: '../etc/passwd', text: 'x' }))).status).toBe(400);
});

test('DELETE /api/docs/:id removes a doc, 404 when missing', async () => {
  const { app, deleted } = setup();
  expect((await app.request('/api/docs/doc:shop:upload:a.md', { method: 'DELETE', headers: { 'content-type': 'application/json', origin: 'http://localhost' } })).status).toBe(204);
  expect((await app.request('/api/docs/doc:shop:upload:zzz', { method: 'DELETE', headers: { 'content-type': 'application/json', origin: 'http://localhost' } })).status).toBe(404);
  expect(deleted).toEqual(['doc:shop:upload:a.md', 'doc:shop:upload:zzz']);
});

test('uploading a file with the name of an existing upload says it replaced it', async () => {
  const recorded: ActivityInput[] = [];
  // listDocs reports an earlier upload with the same file name.
  const replacing = createApp(repo, {
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: {
      upsertDoc: async (doc) => `doc:shop:upload:${doc.ref}`,
      listDocs: async () => [{ id: 'doc:shop:upload:spec.md', projectKey: 'shop', source: 'upload', ref: 'spec.md', title: 'Old spec', url: null, addedAt: 't', chunks: 3, kind: 'text', mediaType: null, read: null }],
      deleteDoc: async () => true,
    },
    activity: { record: async (a) => { recorded.push(a); }, list: async () => [] },
  });
  await replacing.request('/api/projects/shop/docs', post({ title: 'New spec', name: 'spec.md', text: 'v2' }));
  expect(recorded[0]).toMatchObject({ subject: 'replaced "Old spec" with "New spec" (1 chunk)' });
});

const png = Buffer.from('\x89PNG fake image').toString('base64');

test('uploading an image stores it to be read, with a placeholder excerpt until it is', async () => {
  const { app, upserts, recorded } = setup();
  const res = await app.request('/api/projects/shop/docs', post({ title: 'Checkout flow', name: 'flow.png', image: { mediaType: 'image/png', data: png } }));
  expect(res.status).toBe(201);
  expect(upserts[0].doc).toEqual({ projectKey: 'shop', source: 'upload', ref: 'flow.png', title: 'Checkout flow', url: null });
  expect(upserts[0].opts).toEqual({ read: true, image: { mediaType: 'image/png', data: png } });
  expect(upserts[0].chunks).toEqual([{ text: 'Image "Checkout flow" (flow.png): not read yet.', embedding: [1] }]);
  expect(recorded[0]).toMatchObject({ kind: 'doc_added', subject: 'uploaded image "Checkout flow"' });
});

test('image uploads are validated: type, base64, size, and exactly one of text or image', async () => {
  const { app } = setup();
  const up = (body: object) => app.request('/api/projects/shop/docs', post({ title: 't', name: 'a.png', ...body }));
  expect((await up({ image: { mediaType: 'image/svg+xml', data: png } })).status).toBe(400);
  expect((await up({ image: { mediaType: 'image/png', data: 'not base64!!' } })).status).toBe(400);
  expect((await up({ image: { mediaType: 'image/png', data: 'A'.repeat(12_000_000) } })).status).toBe(413);
  expect((await up({ text: 'x', image: { mediaType: 'image/png', data: png } })).status).toBe(400);
  expect((await up({})).status).toBe(400);
});

test('GET /api/docs/:id/image serves an uploaded image with its type, never as a page', async () => {
  const { app } = setup();
  const res = await app.request('/api/docs/doc%3Ashop%3Aupload%3Aflow.png/image');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  expect(res.headers.get('content-disposition')).toMatch(/^inline/);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA');
  expect((await app.request('/api/docs/doc%3Ashop%3Aupload%3Anope.png/image')).status).toBe(404);
});
