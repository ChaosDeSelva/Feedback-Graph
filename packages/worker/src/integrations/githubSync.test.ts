import type { ActivityInput, PrContext } from '@fb/core';
import { expect, test } from 'vitest';
import { reposInScope, syncGithub, type GithubSyncDeps } from './githubSync.ts';

const pr = (n: number, body = 'adds orders'): PrContext => ({
  repo: 'acme/shop', number: n, title: `PR ${n}`, url: `https://github.com/acme/shop/pull/${n}`, author: 'dev', state: 'merged',
  updatedAt: `2026-10-2${n}T10:00:00Z`, headBranch: null, body,
  comments: [{ author: 'lead', body: `scope every list by org; token ghp_${'a'.repeat(36)}`, path: 'src/routes/orders.ts', line: 4, url: `https://github.com/acme/shop/pull/${n}#discussion_r1`, createdAt: 't', kind: 'review_comment', id: '1', diffHunk: null }],
});

function setup(over: Partial<GithubSyncDeps> = {}) {
  const upserts: { doc: { ref: string; title: string; url: string | null }; chunks: { text: string }[] }[] = [];
  const cursors = new Map<string, string>();
  const activity: ActivityInput[] = [];
  const sinces: (string | undefined)[] = [];
  const deps: GithubSyncDeps = {
    repos: new Map([['shop', 'acme/shop']]),
    token: 'tok',
    fetchPrs: async (o) => { sinces.push(o.since); return [pr(1), pr(2)]; },
    docs: {
      upsertDoc: async (doc, chunks) => { upserts.push({ doc, chunks }); return `doc:${doc.ref}`; },
      getCursor: async (k) => cursors.get(k) ?? null,
      setCursor: async (k, v) => { cursors.set(k, v); },
    },
    embed: async (t) => t.map(() => [1]),
    activity: { record: async (a) => { activity.push(a); } },
    now: () => '2026-10-22T12:00:00Z',
    ...over,
  };
  return { deps, upserts, cursors, activity, sinces };
}

test('stores each PR as a doc with redacted, embedded chunks and advances the cursor', async () => {
  const s = setup();
  expect(await syncGithub(s.deps)).toEqual({ prs: 2 });
  expect(s.upserts.map((u) => u.doc)).toEqual([
    { projectKey: 'shop', source: 'github', ref: 'github:acme/shop#1', title: 'acme/shop#1: PR 1', url: 'https://github.com/acme/shop/pull/1' },
    { projectKey: 'shop', source: 'github', ref: 'github:acme/shop#2', title: 'acme/shop#2: PR 2', url: 'https://github.com/acme/shop/pull/2' },
  ]);
  const text = s.upserts[0].chunks.map((c) => c.text).join('\n');
  expect(text).toContain('scope every list by org');
  expect(text).not.toContain('ghp_');
  expect(s.cursors.get('github:shop')).toBe('2026-10-22T12:00:00Z');
  expect(s.activity[0]).toMatchObject({ kind: 'doc_added', actor: 'github', projectKey: 'shop', subject: 'synced 2 pull requests from acme/shop' });
});

test('uses the stored cursor as since, and skips projects synced recently', async () => {
  const s = setup();
  await s.deps.docs.setCursor('github:shop', '2026-10-22T11:00:00Z');
  expect(await syncGithub({ ...s.deps, minIntervalMs: 2 * 3600_000 })).toEqual({ prs: 0 });
  expect(s.sinces).toEqual([]);
  expect(await syncGithub({ ...s.deps, minIntervalMs: 0 })).toEqual({ prs: 2 });
  expect(s.sinces).toEqual(['2026-10-22T11:00:00Z']);
});

test('a failing repo is logged and does not stop the others', async () => {
  const logs: string[] = [];
  const s = setup({
    repos: new Map([['bad', 'acme/bad'], ['shop', 'acme/shop']]),
    fetchPrs: async (o) => { if (o.repo === 'acme/bad') throw new Error('github 404'); return [pr(1)]; },
    log: (m) => { logs.push(m); },
  });
  expect(await syncGithub(s.deps)).toEqual({ prs: 1 });
  expect(logs).toContain('github sync failed');
});

test('only repos of selected projects are synced', () => {
  const repos = new Map([['demo', 'me/demo'], ['client', 'me/client'], ['demo-2', 'me/demo']]);
  expect([...reposInScope(repos, (k) => k !== 'client')]).toEqual([['demo', 'me/demo'], ['demo-2', 'me/demo']]);
});
