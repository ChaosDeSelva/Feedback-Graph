import type { ActivityInput } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

function setup() {
  const upserts: { doc: object; chunks: { text: string }[]; opts?: object }[] = [];
  const deleted: string[] = [];
  const reread: string[] = [];
  const recorded: ActivityInput[] = [];
  const app = createApp(repo, {
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: {
      upsertDoc: async (doc, chunks, opts) => { upserts.push({ doc, chunks, opts }); return `doc:shop:upload:${doc.ref}`; },
      listDocs: async () => [],
      deleteDoc: async (id) => { deleted.push(id); return id === 'doc:shop:upload:a.md'; },
      requeueDocRead: async (id) => { reread.push(id); return id === 'doc:shop:upload:flow.png'; },
      docImage: async (id) => (id === 'doc:shop:upload:flow.png' ? { mediaType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') } : null),
    },
    activity: { record: async (a) => { recorded.push(a); }, list: async () => [] },
  });
  return { app, upserts, deleted, reread, recorded };
}
const post = (body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }, body: JSON.stringify(body) });

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
  expect(upserts[0].opts).toEqual({ read: true, addedBy: 'you' });
  expect(recorded[0]).toMatchObject({ kind: 'doc_added', actor: 'you', projectKey: 'shop', subject: 'uploaded "Product spec" (1 chunk)', targets: ['doc:shop:upload:spec.md'] });
});

test('the largest upload is accepted at once (202) and embedded in the background in batches, never one call for all', async () => {
  const batches: number[] = [];
  const upserts: number[] = [];
  const recorded: ActivityInput[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  const app = createApp(repo, {
    embed: async (t) => { batches.push(t.length); await slow; return t.map(() => [1]); },
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: { upsertDoc: async (doc, chunks) => { upserts.push(chunks.length); return `doc:shop:upload:${doc.ref}`; }, listDocs: async () => [], deleteDoc: async () => false },
    activity: { record: async (a) => { recorded.push(a); }, list: async () => [] },
  });
  const text = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i}. ${'word '.repeat(198)}`).join('\n\n').slice(0, 2_000_000);
  const res = await app.request('/api/projects/shop/docs', post({ title: 'Big', name: 'big.md', text }));
  expect(res.status).toBe(202);
  const body = (await res.json()) as { id: string; chunks: number; pending: boolean };
  expect(body).toMatchObject({ id: 'doc:shop:upload:big.md', pending: true });
  expect(body.chunks).toBeGreaterThan(1000);
  release();
  for (let i = 0; i < 100 && !upserts.length; i++) await new Promise((r) => setTimeout(r, 10));
  expect(upserts).toEqual([body.chunks]);
  expect(Math.max(...batches)).toBeLessThanOrEqual(64);
  expect(batches.reduce((a, b) => a + b, 0)).toBe(body.chunks);
  expect(recorded[0]).toMatchObject({ kind: 'doc_added', subject: `uploaded "Big" (${body.chunks} chunks)` });
});

test('a background upload that fails is logged in Activity with why, never a crash', async () => {
  const recorded: ActivityInput[] = [];
  const app = createApp(repo, {
    embed: async () => { throw new Error('ollama embed 500: model not loaded'); },
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: { upsertDoc: async () => 'x', listDocs: async () => [], deleteDoc: async () => false },
    activity: { record: async (a) => { recorded.push(a); }, list: async () => [] },
  });
  const res = await app.request('/api/projects/shop/docs', post({ title: 'Big', name: 'big.md', text: 'word '.repeat(200_000) }));
  expect(res.status).toBe(202);
  for (let i = 0; i < 100 && !recorded.length; i++) await new Promise((r) => setTimeout(r, 10));
  expect(recorded[0]).toMatchObject({ kind: 'doc_added', subject: 'could not add "Big": ollama embed 500: model not loaded', details: { name: 'big.md', failed: true } });
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
  expect((await app.request('/api/docs/doc:shop:upload:a.md', { method: 'DELETE', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' } })).status).toBe(204);
  expect((await app.request('/api/docs/doc:shop:upload:zzz', { method: 'DELETE', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' } })).status).toBe(404);
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
      listDocs: async () => [{ id: 'doc:shop:upload:spec.md', projectKey: 'shop', source: 'upload', ref: 'spec.md', title: 'Old spec', url: null, addedAt: 't', addedBy: 'you', chunks: 3, kind: 'text', mediaType: null, read: null }],
      deleteDoc: async () => true,
    },
    activity: { record: async (a) => { recorded.push(a); }, list: async () => [] },
  });
  await replacing.request('/api/projects/shop/docs', post({ title: 'New spec', name: 'spec.md', text: 'v2' }));
  expect(recorded[0]).toMatchObject({ subject: 'replaced "Old spec" with "New spec" (1 chunk)' });
});

test('the docs list comes a page at a time, newest first, with x-next-cursor while more follow', async () => {
  const all = Array.from({ length: 5 }, (_, i) => ({
    id: `doc:shop:github:github:acme/shop#${i}`, projectKey: 'shop', source: 'github' as const, ref: `github:acme/shop#${i}`, title: `PR ${i}`, url: null,
    addedAt: `2026-10-2${5 - i}T00:00:00.000Z`, addedBy: null, chunks: 1, kind: 'text' as const, mediaType: null, read: null,
  }));
  const asked: object[] = [];
  const app = createApp(repo, {
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: {
      upsertDoc: async () => 'x',
      deleteDoc: async () => true,
      listDocs: async (_k, o = {}) => {
        asked.push(o);
        const from = o.after ? all.findIndex((d) => d.id === o.after!.id) + 1 : 0;
        return all.slice(from, o.limit === undefined ? undefined : from + o.limit);
      },
    },
  });
  const first = await app.request('/api/projects/shop/docs?limit=2');
  expect((await first.json()).map((d: { ref: string }) => d.ref)).toEqual(['github:acme/shop#0', 'github:acme/shop#1']);
  // one more than the page is asked for, to know whether another follows
  expect(asked[0]).toMatchObject({ limit: 3, after: null });
  const cursor = first.headers.get('x-next-cursor');
  expect(cursor).toBeTruthy();
  const second = await app.request(`/api/projects/shop/docs?limit=2&cursor=${encodeURIComponent(cursor!)}`);
  expect((await second.json()).map((d: { ref: string }) => d.ref)).toEqual(['github:acme/shop#2', 'github:acme/shop#3']);
  const third = await app.request(`/api/projects/shop/docs?limit=2&cursor=${encodeURIComponent(second.headers.get('x-next-cursor')!)}`);
  expect((await third.json()).map((d: { ref: string }) => d.ref)).toEqual(['github:acme/shop#4']);
  expect(third.headers.get('x-next-cursor')).toBeNull();
  // no limit: a page of the default size, never every document at once
  await app.request('/api/projects/shop/docs');
  expect(asked.at(-1)).toMatchObject({ limit: 101 });
  expect((await app.request('/api/projects/shop/docs?cursor=nonsense')).status).toBe(400);
  expect((await app.request('/api/projects/shop/docs?limit=100000')).status).toBe(400);
});

test('an upload looks up an earlier one with its name, not by listing every document', async () => {
  const asked: object[] = [];
  const app = createApp(repo, {
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: { upsertDoc: async () => 'doc:shop:upload:spec.md', deleteDoc: async () => true, listDocs: async (_k, o) => { asked.push(o ?? {}); return []; } },
  });
  await app.request('/api/projects/shop/docs', post({ title: 'Spec', name: 'spec.md', text: 'v1' }));
  // Two at most: the shared one of that name, and a sandbox run's own beside it.
  expect(asked).toEqual([{ source: 'upload', ref: 'spec.md', limit: 2, run: null }]);
});

const png = Buffer.from('\x89PNG fake image').toString('base64');

test('uploading an image stores it to be read, with a placeholder excerpt until it is', async () => {
  const { app, upserts, recorded } = setup();
  const res = await app.request('/api/projects/shop/docs', post({ title: 'Checkout flow', name: 'flow.png', image: { mediaType: 'image/png', data: png } }));
  expect(res.status).toBe(201);
  expect(upserts[0].doc).toEqual({ projectKey: 'shop', source: 'upload', ref: 'flow.png', title: 'Checkout flow', url: null });
  expect(upserts[0].opts).toEqual({ read: true, addedBy: 'you', image: { mediaType: 'image/png', data: png } });
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

test('POST /api/docs/:id/reread queues a failed reading again (say, after DOCS_LLM changed); 404 when there is none', async () => {
  const { app, reread, recorded } = setup();
  const res = await app.request('/api/docs/doc%3Ashop%3Aupload%3Aflow.png/reread', post({}));
  expect(res.status).toBe(204);
  expect(reread).toEqual(['doc:shop:upload:flow.png']);
  expect(recorded[0]).toMatchObject({ kind: 'doc_added', actor: 'you', projectKey: 'shop', subject: 'asked for flow.png to be read again', targets: ['doc:shop:upload:flow.png'] });
  expect((await app.request('/api/docs/doc%3Ashop%3Aupload%3Anope.md/reread', post({}))).status).toBe(404);
});

test('a background upload carries its embed status: pending, then failed with why, read by id (GET /api/docs/:id), not from the first page', async () => {
  let fail!: (e: Error) => void;
  const app = createApp(repo, {
    embed: () => new Promise((_, reject) => { fail = reject; }),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: { upsertDoc: async () => 'x', listDocs: async () => [], deleteDoc: async () => false },
    activity: { record: async () => {}, list: async () => [] },
  });
  const res = await app.request('/api/projects/shop/docs', post({ title: 'Big', name: 'big.md', text: 'word '.repeat(200_000) }));
  expect(res.status).toBe(202);
  const { id, chunks } = (await res.json()) as { id: string; chunks: number };
  const pending = await app.request(`/api/docs/${encodeURIComponent(id)}`);
  expect(pending.status).toBe(200);
  expect(await pending.json()).toMatchObject({ id, title: 'Big', embed: { status: 'pending', chunks } });
  fail(new Error('ollama embed 500: model not loaded'));
  let failed: { embed?: { status: string; error?: string } } = {};
  for (let i = 0; i < 100 && failed.embed?.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    failed = await (await app.request(`/api/docs/${encodeURIComponent(id)}`)).json();
  }
  expect(failed.embed).toEqual({ status: 'failed', error: 'ollama embed 500: model not loaded', chunks });
  // A document nobody uploaded, stored or not, is not found.
  expect((await app.request('/api/docs/doc:shop:upload:none.md')).status).toBe(404);
  expect((await app.request('/api/docs/doc:other:upload:big.md')).status).toBe(404);
});

test('re-uploading a large file of the same name marks the listed document pending until the new version is stored', async () => {
  const old = { id: 'doc:shop:upload:big.md', projectKey: 'shop', source: 'upload' as const, ref: 'big.md', title: 'Big v1', url: null, addedAt: 't', addedBy: 'you', chunks: 3, kind: 'text' as const, mediaType: null, read: null };
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  let stored = false;
  const app = createApp(repo, {
    embed: async (t) => { await slow; return t.map(() => [1]); },
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: {
      upsertDoc: async (doc) => { stored = true; return `doc:shop:upload:${doc.ref}`; },
      listDocs: async (_k, o = {}) => (!o.ref || o.ref === 'big.md' ? [stored ? { ...old, title: 'Big v2', chunks: 999 } : old] : []),
      deleteDoc: async () => false,
    },
    activity: { record: async () => {}, list: async () => [] },
  });
  const res = await app.request('/api/projects/shop/docs', post({ title: 'Big v2', name: 'big.md', text: 'word '.repeat(200_000) }));
  expect(res.status).toBe(202);
  const listed = (await (await app.request('/api/projects/shop/docs')).json()) as { id: string; embed?: { status: string } }[];
  expect(listed[0]).toMatchObject({ id: old.id, title: 'Big v1', embed: { status: 'pending' } });
  expect(await (await app.request(`/api/docs/${encodeURIComponent(old.id)}`)).json()).toMatchObject({ title: 'Big v1', embed: { status: 'pending' } });
  release();
  for (let i = 0; i < 100 && !stored; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10));
  const done = (await (await app.request(`/api/docs/${encodeURIComponent(old.id)}`)).json()) as { title: string; embed?: object };
  expect(done.title).toBe('Big v2');
  expect(done.embed).toBeUndefined();
  expect(((await (await app.request('/api/projects/shop/docs')).json()) as { embed?: object }[])[0].embed).toBeUndefined();
});
