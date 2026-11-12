import { authorizeStoreWrite, LegacyRunClaimError, NotTheRunsError, shownProjects, type RunOwner } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const OWNER = 'owner-test-token-01234567890123456789';
const ownerHeaders = { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' };
const base = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] };
const repo = (over: Partial<ApiRepo> = {}) => ({ ...base, ...over }) as unknown as ApiRepo;

test('a request whose client hung up answers 499 and is not logged as a failure', async () => {
  const logged: string[] = [];
  const client = new AbortController();
  const app = createApp(repo({ listCandidates: async () => { client.abort(); throw new Error('socket closed while reading'); } }), { log: (msg) => logged.push(msg) });
  const res = await app.request('/api/candidates', { signal: client.signal });
  expect(res.status).toBe(499);
  expect(logged).not.toContain('request failed');
});

test('a store at its transaction-memory limit answers 503 with retry-after, not a generic 500', async () => {
  const oom = Object.assign(new Error('allocation exceeded the memory pool'), { code: 'Neo.TransientError.General.MemoryPoolOutOfMemoryError' });
  const app = createApp(repo({ listCandidates: async () => { throw oom; } }));
  const res = await app.request('/api/candidates');
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('2');
  expect(await res.json()).toMatchObject({ retryable: true, error: expect.stringMatching(/transaction-memory limit/) });
});

test('a Postgres statement timeout (57014) answers 504 retryable', async () => {
  const app = createApp(repo({ listCandidates: async () => { throw Object.assign(new Error('canceling statement'), { code: '57014' }); } }));
  const res = await app.request('/api/candidates');
  expect(res.status).toBe(504);
  expect(await res.json()).toMatchObject({ retryable: true });
});

// A labelled run's store refuses to change a record it did not write (NotTheRunsError): the API answers 409 with why.
const refusal = new NotTheRunsError('the record', 'run-1');

test('an Inbox decision the store refuses as not the run\'s is a 409 conflict', async () => {
  const cand = { id: 'c1', projectKey: 'shop', classification: { label: 'pushback', confidence: 0.9 } };
  const app = createApp(repo({
    candidateDetail: async () => ({ candidate: cand, turn: { text: 't' }, before: [], after: [], commits: [], postmortem: null }) as never,
    decide: async () => { throw refusal; },
  }), { auth: { ownerToken: OWNER } });
  const res = await app.request('/api/candidates/c1/decision', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ status: 'confirmed' }) });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe(refusal.message);
});

test('a document upload the store refuses as not the run\'s is a 409 conflict', async () => {
  const app = createApp(repo(), {
    auth: { ownerToken: OWNER },
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: { upsertDoc: async () => { throw refusal; }, listDocs: async () => [], deleteDoc: async () => false },
  });
  const res = await app.request('/api/projects/shop/docs', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ title: 'Spec', name: 'spec.md', text: 'Lists are paginated.' }) });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe(refusal.message);
});

test('a link change the store refuses as not the run\'s is a 409 conflict, and nothing is logged', async () => {
  const recorded: unknown[] = [];
  const app = createApp(repo(), {
    auth: { ownerToken: OWNER },
    links: { listLinks: async () => [], setLink: async () => { throw refusal; }, deleteLink: async () => false },
    shown: () => shownProjects({ tracked: ['api', 'web'], initialized: true }, { excludeProjects: [] }),
    activity: { removeRun: async () => 0, record: async (a) => { recorded.push(a); }, list: async () => [] },
  });
  const res = await app.request('/api/links', { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ a: 'api', b: 'web', status: 'confirmed' }) });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe(refusal.message);
  expect(recorded).toEqual([]);
});

test('a labelled write on a run with legacy unowned records is refused with 409 and the reason, not a 500', async () => {
  const OP = 'operator-token-for-tests';
  const legacy = new LegacyRunClaimError('fresh');
  const decided: string[] = [];
  const cand = { id: 'c1', projectKey: 'shop', classification: { label: 'pushback', confidence: 0.9 }, run: 'fresh' };
  const app = createApp(repo({
    candidateDetail: async () => ({ candidate: cand, turn: { text: 't' }, before: [], after: [], commits: [], postmortem: null }) as never,
    // As the stores do: the first labelled write claims the run before it changes anything.
    decide: async (id) => { await authorizeStoreWrite(); decided.push(id); },
  }), {
    auth: { operator: { token: OP, allow: ['inbox_decide'] } },
    runs: { sandbox: async () => false, owner: async () => null as RunOwner | null, claim: async () => { throw legacy; }, items: async () => [], remove: async () => ({}) as never },
  });
  const res = await app.request('/api/candidates/c1/decision', {
    method: 'POST',
    headers: { authorization: `Bearer ${OP}`, 'x-fg-run': 'fresh', 'x-fg-run-key': 'c2ad856fb97403e18a2e7dc9015b6f438670dcaeb3219a845f0d7c8b6e109234', 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'confirmed' }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe(legacy.message);
  expect(decided).toEqual([]);
});

test('any other store failure on an upload or a link change is a server error, not a conflict', async () => {
  const failure = new Error('disk full');
  const app = createApp(repo(), {
    auth: { ownerToken: OWNER },
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: { upsertDoc: async () => { throw failure; }, listDocs: async () => [], deleteDoc: async () => false },
    links: { listLinks: async () => [], setLink: async () => { throw failure; }, deleteLink: async () => false },
    shown: () => shownProjects({ tracked: ['shop', 'web'], initialized: true }, { excludeProjects: [] }),
  });
  expect((await app.request('/api/projects/shop/docs', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ title: 'Spec', name: 'spec.md', text: 'x' }) })).status).toBe(500);
  expect((await app.request('/api/links', { method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ a: 'shop', b: 'web', status: 'confirmed' }) })).status).toBe(500);
});
