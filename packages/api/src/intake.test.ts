import { OPERATOR_DEFAULT_VERBS, setRedactionArchive, type ActivityInput, type Claim, type DocSummary, type IntakeMeta, type IntakeMetaInput, type RedactionOriginal } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo, type AppOpts } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const OWNER = 'owner-test-token-01234567890123456789';
const API = 'api-test-token-0123456789012345678901';
const OPERATOR = 'operator-test-token-012345678901234567';
const ownerHeaders = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' };
const SECRET = `sk-ant-api03-${'a'.repeat(40)}`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Ana Lima>Retries wait 30 seconds. Mail me at ana@example.org

00:00:05.000 --> 00:00:08.000
<v Bo>Agreed, and the key is ${SECRET}`;

/** In-memory docs and intake stores: what the routes wrote, and enough reads to serve them back. */
function setup(o: { intake?: boolean; archive?: boolean; claims?: Partial<Claim>[]; embed?: AppOpts['embed'] } = {}) {
  const docs = new Map<string, { summary: DocSummary; chunks: string[]; opts: object }>();
  const metas = new Map<string, IntakeMetaInput>();
  const people = new Map<string, string>();
  const calls: string[] = [];
  const recorded: ActivityInput[] = [];
  const embedded: string[][] = [];
  const app = createApp(repo, {
    auth: { ownerToken: OWNER, token: API, operator: { token: OPERATOR, allow: [...OPERATOR_DEFAULT_VERBS] } },
    embed: o.embed ?? (async (t) => { embedded.push(t); return t.map(() => [1]); }),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: {
      upsertDoc: async (doc, chunks, opts) => {
        const id = `doc:${doc.projectKey}:${doc.source}:${doc.ref}`;
        docs.set(id, { summary: { ...doc, id, addedAt: new Date().toISOString(), addedBy: 'you', chunks: chunks.length, kind: 'text', mediaType: null, read: null }, chunks: chunks.map((c) => c.text), opts: opts ?? {} });
        return id;
      },
      listDocs: async (key, f = {}) => [...docs.values()].map((x) => x.summary).filter((x) => x.projectKey === key && (!f.source || x.source === f.source) && (!f.ref || x.ref === f.ref)),
      deleteDoc: async (id) => { calls.push(`deleteDoc ${id}`); return docs.delete(id); },
      docText: async (id) => docs.get(id)?.chunks.join('\n\n') ?? null,
      requeueDocRead: async (id, opt) => { calls.push(`requeueDocRead ${id} ${JSON.stringify(opt ?? {})}`); return docs.has(id); },
    },
    activity: { removeRun: async () => 0, record: async (a) => { recorded.push(a); }, list: async () => [] },
    ...(o.intake !== false && {
      intake: {
        archive: o.archive ?? true,
        // keep=none with facts (a remove_source decision) runs on real stores: intakeRemove.int.test.ts.
        decide: { store: {} as never, exec: { apply: async () => { throw new Error('no decision expected here'); } } },
        store: {
          upsertMeta: async (m) => { metas.set(m.docId, m); return docs.has(m.docId); },
          metas: async (ids) => ids.flatMap((id): IntakeMeta[] => (metas.has(id) ? [{ ...metas.get(id)!, windowsDone: 0, windowsTotal: null }] : [])),
          removeSource: async (id) => { calls.push(`removeSource ${id}`); metas.delete(id); return { claim: 2, question: 1, people: 0 }; },
          resolveAlias: async (name, opt) => {
            const created = !people.has(name);
            if (created && !opt?.create) return null;
            if (created) people.set(name, `person:${people.size + 1}`);
            return { person: { id: people.get(name)!, displayName: name } as never, created };
          },
          listClaims: async (f) => (o.claims ?? []).filter((c) => !f?.status || f.status.includes(c.status!)) as Claim[],
        },
      },
    }),
  });
  return { app, docs, metas, people, calls, recorded, embedded };
}
const send = (method: string, body?: object, headers: Record<string, string> = ownerHeaders) => ({
  method, headers: { 'content-type': 'application/json', ...headers }, ...(body && { body: JSON.stringify(body) }),
});
const source = (over: object = {}) => ({ projectKey: 'shop', title: 'Weekly sync', name: 'sync.vtt', text: VTT, occurredAt: '2026-11-10', participants: ['Ana Lima', 'Cy'], origin: 'video call', ...over });

test('without INTAKE_ENABLED there are no intake routes', async () => {
  const { app } = setup({ intake: false });
  expect((await app.request('/api/intake', send('POST', source()))).status).toBe(404);
  expect((await app.request('/api/intake/sources', send('GET'))).status).toBe(404);
});

test('a source is redacted, stored as an intake Doc whose chunks join back to the text, queued, described and logged', async () => {
  const { app, docs, metas, people, recorded } = setup();
  const res = await app.request('/api/intake', send('POST', source()));
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ id: 'doc:shop:intake:sync.vtt', chunks: 1, format: 'vtt', utterances: 2 });
  const stored = docs.get('doc:shop:intake:sync.vtt')!;
  expect(stored.summary).toMatchObject({ source: 'intake', ref: 'sync.vtt', title: 'Weekly sync' });
  expect(stored.opts).toEqual({ read: true, addedBy: 'you' });
  const text = stored.chunks.join('\n\n');
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('ana@example.org');
  expect(text).toContain('[email]');
  expect(text).toContain('<v Ana Lima>Retries wait 30 seconds.');
  // Participants and speaker labels are people (one each, a new name proposed).
  expect([...people.keys()]).toEqual(['Ana Lima', 'Cy', 'Bo']);
  expect(metas.get('doc:shop:intake:sync.vtt')).toEqual({
    docId: 'doc:shop:intake:sync.vtt', kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'video call', private: true,
    participants: ['person:1', 'person:2', 'person:3'],
  });
  expect(recorded).toEqual([expect.objectContaining({ kind: 'source_added', actor: 'you', projectKey: 'shop', subject: 'added the transcript "Weekly sync" (2 utterances)', targets: ['doc:shop:intake:sync.vtt'] })]);
});

test('long text breaks only at blank lines, so the chunks rejoin to it exactly', async () => {
  const { app, docs } = setup();
  const text = Array.from({ length: 40 }, (_, i) => `Ana: point ${i} ${'detail '.repeat(30)}\nBo: reply ${i}`).join('\n\n');
  expect((await app.request('/api/intake', send('POST', { projectKey: 'shop', title: 'Notes', kind: 'notes', text }))).status).toBe(201);
  const [stored] = [...docs.values()];
  expect(stored.chunks.length).toBeGreaterThan(1);
  expect(stored.chunks.join('\n\n')).toBe(text);
});

test('the original goes to the redaction archive, unless INTAKE_ARCHIVE=off', async () => {
  const archived: RedactionOriginal[] = [];
  setRedactionArchive(async (r) => { archived.push(r); });
  try {
    expect((await setup().app.request('/api/intake', send('POST', source()))).status).toBe(201);
    expect(archived).toEqual([expect.objectContaining({ kind: 'intake-incoming', scope: [{ kind: 'project', id: 'shop' }, { kind: 'doc', id: 'doc:shop:intake:sync.vtt' }] })]);
    archived.length = 0;
    expect((await setup({ archive: false }).app.request('/api/intake', send('POST', source()))).status).toBe(201);
    expect(archived).toEqual([]);
  } finally {
    setRedactionArchive(undefined);
  }
});

test('a paste is named by its text; notes default to not private; the format comes from the text', async () => {
  const { app, metas } = setup();
  const paste = { projectKey: 'shop', title: 'My notes', kind: 'notes', text: 'Ana: ship on Friday\nBo: fine' };
  const a = await (await app.request('/api/intake', send('POST', paste))).json() as { id: string; format: string };
  const b = await (await app.request('/api/intake', send('POST', { ...paste, title: 'Again' }))).json() as { id: string };
  expect(a.id).toMatch(/^doc:shop:intake:paste-[0-9a-f]{12}$/);
  expect(b.id).toBe(a.id);
  expect(a.format).toBe('txt');
  expect(metas.get(a.id)).toMatchObject({ kind: 'notes', private: false, occurredAt: null, origin: null });
});

test('bad input is refused before anything is stored', async () => {
  const { app, docs } = setup();
  const status = async (body: object) => (await app.request('/api/intake', send('POST', body))).status;
  expect(await status(source({ occurredAt: 'last tuesday' }))).toBe(400);
  expect(await status(source({ occurredAt: '2026-02-30T99:00' }))).toBe(400);
  expect(await status(source({ format: 'pdf' }))).toBe(400);
  expect(await status(source({ name: '../etc/passwd' }))).toBe(400);
  expect(await status(source({ projectKey: 'nope' }))).toBe(404);
  expect(await status(source({ text: 'WEBVTT\n\n' }))).toBe(400);
  expect(docs.size).toBe(0);
});

test('a large source is answered 202 and listed as pending until it is stored', async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  const { app, docs } = setup({ embed: async (t) => { await slow; return t.map(() => [1]); } });
  const text = Array.from({ length: 200 }, (_, i) => `Ana: ${i} ${'word '.repeat(300)}`).join('\n\n');
  const res = await app.request('/api/intake', send('POST', { projectKey: 'shop', title: 'Long call', name: 'long.txt', text }));
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ id: 'doc:shop:intake:long.txt', pending: true });
  const listed = await (await app.request('/api/intake/sources?project=shop', send('GET'))).json() as { id: string; embed?: { status: string } }[];
  expect(listed).toEqual([expect.objectContaining({ id: 'doc:shop:intake:long.txt', intake: null, embed: expect.objectContaining({ status: 'pending' }) })]);
  release();
  await expect.poll(() => docs.size).toBe(1);
  expect(docs.get('doc:shop:intake:long.txt')!.chunks.join('\n\n')).toBe(text.trim());
});

test('a source reads back with its details, text, utterances and claim spans', async () => {
  const { app } = setup({ claims: [{ id: 'claim:1', type: 'decision', status: 'proposed', span: { utt: 0, start: 0, end: 10 } }] });
  await app.request('/api/intake', send('POST', source()));
  const list = await (await app.request('/api/intake/sources', send('GET'))).json() as { id: string; intake: object }[];
  expect(list).toEqual([expect.objectContaining({ id: 'doc:shop:intake:sync.vtt', intake: expect.objectContaining({ kind: 'transcript', format: 'vtt' }) })]);
  const one = await (await app.request(`/api/intake/sources/${encodeURIComponent('doc:shop:intake:sync.vtt')}`, send('GET'))).json() as Record<string, any>;
  expect(one.text).toContain('Retries wait 30 seconds');
  expect(one.utterances.map((u: { speaker: string }) => u.speaker)).toEqual(['Ana Lima', 'Bo']);
  expect(one.claims).toEqual([{ id: 'claim:1', type: 'decision', status: 'proposed', span: { utt: 0, start: 0, end: 10 } }]);
  expect((await app.request(`/api/intake/sources/${encodeURIComponent('doc:shop:upload:a.md')}`, send('GET'))).status).toBe(404);
});

test('Read again on a source already read queues a full re-read and says so; on a failed one, a retry', async () => {
  const { app, docs, calls, recorded } = setup();
  await app.request('/api/intake', send('POST', source()));
  const id = 'doc:shop:intake:sync.vtt';
  const reread = () => app.request(`/api/intake/sources/${encodeURIComponent(id)}/reread`, send('POST'));
  docs.get(id)!.summary.read = { status: 'done' } as never;
  expect((await reread()).status).toBe(204);
  expect(calls).toContain(`requeueDocRead ${id} {"again":true}`);
  expect(recorded.at(-1)).toMatchObject({ kind: 'source_read', actor: 'you', details: { full: true }, why: expect.stringContaining('full re-read') });
  docs.get(id)!.summary.read = { status: 'failed' } as never;
  expect((await reread()).status).toBe(204);
  expect(recorded.at(-1)).toMatchObject({ details: { full: false }, why: expect.stringContaining('failed') });
});

test('only the owner, or the operator token with its verb, reaches intake: reads included', async () => {
  const { app } = setup();
  const api = { authorization: `Bearer ${API}` };
  const operator = { authorization: `Bearer ${OPERATOR}`, 'x-fg-operator': 'cli' };
  expect((await app.request('/api/intake', send('POST', source(), api))).status).toBe(403);
  expect((await app.request('/api/intake/sources', send('GET', undefined, api))).status).toBe(403);
  expect((await app.request(`/api/intake/sources/${encodeURIComponent('doc:shop:intake:sync.vtt')}`, send('GET', undefined, api))).status).toBe(403);
  // intake is on for the operator token by default; removing a source (docs_delete) is not.
  expect((await app.request('/api/intake', send('POST', source(), operator))).status).toBe(201);
  expect((await app.request('/api/intake/sources', send('GET', undefined, operator))).status).toBe(200);
  expect((await app.request(`/api/intake/sources/${encodeURIComponent('doc:shop:intake:sync.vtt')}`, send('DELETE', undefined, operator))).status).toBe(403);
});

test('removing a source keeps accepted facts by default, and is not a plain document delete', async () => {
  const id = 'doc:shop:intake:sync.vtt';
  const path = `/api/intake/sources/${encodeURIComponent(id)}`;
  const withFact = setup({ claims: [{ id: 'claim:1', status: 'accepted', factId: 'fact:9' }] });
  await withFact.app.request('/api/intake', send('POST', source()));
  expect((await withFact.app.request(`/api/docs/${encodeURIComponent(id)}`, send('DELETE'))).status).toBe(409);
  const res = await withFact.app.request(path, send('DELETE'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ removed: { claim: 2, question: 1, people: 0, facts: 0, keep: 'facts' }, decision: null });
  expect(withFact.calls).toEqual([`deleteDoc ${id}`, `removeSource ${id}`]);
  expect(withFact.recorded.at(-1)).toMatchObject({ kind: 'doc_removed', targets: [id] });
  expect((await withFact.app.request(path, send('DELETE'))).status).toBe(404);

  const none = setup();
  await none.app.request('/api/intake', send('POST', source()));
  expect((await none.app.request(`${path}?keep=none`, send('DELETE'))).status).toBe(200);
  expect(none.docs.size).toBe(0);
});
