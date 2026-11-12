import { expect, test } from 'vitest';
import { prContextToChunks, redactSecrets, type PrContext } from '@fb/core';
import { githubRepairCursor, repairGithubDocs } from './githubRepair.ts';

const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const pr = (number: number, body = 'Basic concepts'): PrContext => ({ repo: 'acme/shop', number, title: 'T', body, author: 'a', state: 'closed', updatedAt: '2026-10-01T00:00:00Z', url: `https://github.com/acme/shop/pull/${number}`, headBranch: null, comments: [] });
type Doc = { id: string; ref: string; chunks: string[] };

/** A store of damaged GitHub documents (pages of five) that a repair rewrites from the PRs it fetches. */
function world(docs: Doc[], bodies: Record<number, string> = {}) {
  const values = new Map<string, string>();
  const byId = new Map(docs.map((d) => [d.id, d]));
  const fetched: number[] = [];
  const failing = new Set<number>();
  const d = {
    projectKey: 'shop', repo: 'acme/shop', token: 't', now: '2026-10-29T00:00:00Z',
    docs: {
      getCursor: async (k: string) => values.get(k) ?? null,
      setCursor: async (k: string, v: string) => void values.set(k, v),
      // As the stores answer: only documents with a mask left, and only their masked chunks.
      githubRepairDocs: async (_p: string, after: string, limit: number) => [...byId.values()]
        .map((x) => ({ ...x, chunks: x.chunks.filter((c) => c.includes('[REDACTED]')) }))
        .filter((x) => x.id > after && x.chunks.length).slice(0, limit),
      githubDocChunks: async (id: string) => byId.get(id)!.chunks,
    },
    fetchPrs: async (o: { numbers?: number[] }) => {
      const n = o.numbers![0];
      fetched.push(n);
      if (failing.has(n)) throw new Error('transient');
      return n === 404 ? [] : [pr(n, bodies[n])];
    },
    store: async (p: PrContext) => {
      const id = [...byId.values()].find((x) => x.ref.endsWith(`#${p.number}`))!.id;
      byId.set(id, { ...byId.get(id)!, chunks: prContextToChunks(p).map((c) => redactSecrets(c.text)) });
    },
  };
  return { d, values, fetched, failing, byId };
}
const doc = (n: number, ref = `github:acme/shop#${n}`): Doc => ({ id: `d${String(n).padStart(2, '0')}`, ref, chunks: ['Basic [REDACTED]'] });

test('a pass longer than one turn resumes where it stopped, and a later document that failed is retried in place after its backoff', async () => {
  const w = world([1, 2, 3, 4, 5, 6, 7].map((n) => doc(n)));
  w.failing.add(7);
  const first = await repairGithubDocs(w.d);
  expect(first.progress).toMatchObject({ after: 'd05', checked: 5, repaired: 5, status: 'scanning' });
  const second = await repairGithubDocs(w.d);
  expect(second.progress).toMatchObject({ after: 'd06', checked: 6, repaired: 6, pending: 1, blockedDoc: 'd07', status: 'waiting' });
  // Its retry: a second failure backs off longer.
  w.d.now = '2026-10-29T00:01:00Z';
  await repairGithubDocs(w.d);
  const outcome = JSON.parse([...w.values].find(([k]) => k.startsWith(`${githubRepairCursor('shop')}:doc:`) && w.values.get(k)!.includes('"attempts":2'))![1]);
  expect(outcome).toMatchObject({ status: 'retry', attempts: 2, nextRetryAt: '2026-10-29T00:03:00.000Z' });
  w.failing.clear();
  w.d.now = '2026-10-29T00:03:00Z';
  const done = await repairGithubDocs(w.d);
  expect(done.progress).toMatchObject({ checked: 7, repaired: 7, pending: 0, status: 'verified', after: '' });
  expect(done.progress.blockedDoc).toBeUndefined();
});

test('a document already found protected (the source holds a real secret) is counted again without a fetch; a repaired one is gone', async () => {
  const w = world([doc(1), doc(2)], { 1: `the token is ${TOKEN}` });
  await repairGithubDocs(w.d);
  expect(w.fetched).toEqual([1, 2]);
  // The next pass sees them as stored now.
  const again = await repairGithubDocs(w.d);
  expect(w.fetched).toEqual([1, 2]);
  expect(again.progress).toMatchObject({ checked: 1, protected: 1, repaired: 0, status: 'verified' });
});

test('a stored document with no PR number, or a PR GitHub no longer returns, waits for a retry instead of being marked done', async () => {
  for (const bad of [doc(1, 'github:acme/shop'), doc(404)]) {
    const w = world([bad]);
    const r = await repairGithubDocs(w.d);
    expect(r.progress).toMatchObject({ status: 'waiting', pending: 1, errorKind: 'other' });
  }
});

test('an unreadable progress record starts the pass over', async () => {
  const w = world([doc(1)]);
  w.values.set(githubRepairCursor('shop'), '{oops');
  expect((await repairGithubDocs(w.d)).progress).toMatchObject({ checked: 1, repaired: 1, status: 'verified' });
});
