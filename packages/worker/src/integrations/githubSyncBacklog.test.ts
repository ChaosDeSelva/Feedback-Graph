import { IntegrationError, prBacklogKey, type ActivityInput, type FetchPrOpts, type PrContext } from '@fb/core';
import { expect, test } from 'vitest';
import { syncGithub, ticketsCursor, type GithubSyncDeps } from './githubSync.ts';

const pr = (n: number): PrContext => ({
  repo: 'acme/shop', number: n, title: `PR ${n}`, url: `https://github.com/acme/shop/pull/${n}`, author: 'Dev', state: 'merged',
  updatedAt: '2026-10-21T10:00:00Z', headBranch: null, body: 'b', comments: [],
});

function setup(over: Partial<GithubSyncDeps> = {}) {
  const asked: FetchPrOpts[] = [];
  const activity: ActivityInput[] = [];
  const logs: [string, object | undefined][] = [];
  const cursors = new Map<string, string>();
  const deps: GithubSyncDeps = {
    repos: new Map([['shop', 'acme/shop']]),
    token: 'tok',
    fetchPrs: async (o) => { asked.push(o); return []; },
    docs: { upsertDoc: async (doc) => `doc:${doc.ref}`, getCursor: async (k) => cursors.get(k) ?? null, setCursor: async (k, v) => void cursors.set(k, v), githubRepairDocs: async () => [], githubDocChunks: async () => null },
    embed: async (t) => t.map(() => [1]),
    activity: { record: async (a) => void activity.push(a) },
    minIntervalMs: 0,
    log: (m, x) => logs.push([m, x]),
    ...over,
  };
  return { deps, asked, activity, logs, cursors };
}

test('a first sync that finds no pull requests records when it ran, on the wall clock, and logs nothing', async () => {
  const s = setup();
  const before = new Date().toISOString();
  expect(await syncGithub(s.deps)).toEqual({ prs: 0 });
  expect(s.cursors.get('github:shop')! >= before).toBe(true);
  expect(s.activity).toEqual([]);
});

test('capped again while an older backlog waits: the backlog grows back to its own start, and the cap is logged', async () => {
  const s = setup({ now: () => '2026-10-22T12:00:00Z' });
  s.cursors.set('github:shop', '2026-10-10T00:00:00Z');
  s.cursors.set(ticketsCursor('shop'), '2026-10-10T00:00:00Z');
  s.cursors.set(prBacklogKey('shop'), JSON.stringify({ since: '2026-10-01T00:00:00Z', until: '2026-10-05T00:00:00Z' }));
  s.deps.fetchPrs = async (o) => { s.asked.push(o); o.onCap?.('2026-10-20T00:00:00Z'); return [pr(1)]; };
  await syncGithub(s.deps);
  expect(JSON.parse(s.cursors.get(prBacklogKey('shop'))!)).toEqual({ since: '2026-10-01T00:00:00Z', until: '2026-10-20T00:00:00Z' });
  expect(s.asked).toHaveLength(1); // capped: no backlog batch this time
  expect(s.logs.map(([m]) => m)).toContain('github sync hit its cap; the PRs it did not read are read on the next syncs');
});

test("a project limited to one author reads its backlog for that author's pull requests only", async () => {
  const s = setup({ now: () => '2026-10-22T12:00:00Z', authors: new Map([['shop', 'dev']]) });
  s.cursors.set('github:shop', '2026-10-21T00:00:00Z');
  s.cursors.set(ticketsCursor('shop'), '2026-10-21T00:00:00Z');
  s.cursors.set(prBacklogKey('shop'), JSON.stringify({ since: '2026-10-01T00:00:00Z', until: '2026-10-05T00:00:00Z' }));
  await syncGithub(s.deps);
  expect(s.asked.map((o) => [o.author, o.until])).toEqual([['dev', undefined], ['dev', '2026-10-05T00:00:00Z']]);
});

test('a document repair stopped by the shared rate limit says it is waiting and stops the sync of every repository', async () => {
  const s = setup({ now: () => '2026-10-22T12:00:00Z', repos: new Map([['shop', 'acme/shop'], ['web', 'acme/web']]) });
  s.deps.docs.githubRepairDocs = async (key) => (key === 'shop' ? [{ id: 'd1', ref: 'github:acme/shop#1', chunks: ['Basic [REDACTED]'] }] : []);
  s.deps.docs.githubDocChunks = async () => null;
  s.deps.fetchPrs = async (o) => { s.asked.push(o); throw new IntegrationError('limited', 'rate_limit', '2026-10-22T13:00:00Z'); };
  expect(await syncGithub(s.deps)).toEqual({ prs: 0 });
  expect(s.asked).toHaveLength(1); // the repair's fetch; no incremental read, no second repository
  expect(s.activity[0].subject).toBe('GitHub document repair waiting: 1 pending');
  expect(s.logs).toEqual([['github document repair progress', expect.objectContaining({ projectKey: 'shop', status: 'waiting', pending: 1, fetchedDocs: 0 })]]);
});
