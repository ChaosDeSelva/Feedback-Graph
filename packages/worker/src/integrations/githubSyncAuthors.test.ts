import { IntegrationError, type ActivityInput, type FetchPrOpts, type PrContext } from '@fb/core';
import { expect, test } from 'vitest';
import { syncGithub, type GithubSyncDeps } from './githubSync.ts';

const pr = (n: number, author: string): PrContext => ({
  repo: 'acme/shop', number: n, title: `PR ${n}`, url: `https://github.com/acme/shop/pull/${n}`, author, state: 'merged',
  updatedAt: '2026-10-21T10:00:00Z', headBranch: null, body: 'b', comments: [],
});

function setup(over: Partial<GithubSyncDeps> = {}) {
  const refs: string[] = [];
  const asked: FetchPrOpts[] = [];
  const activity: ActivityInput[] = [];
  const cursors = new Map<string, string>();
  const deps: GithubSyncDeps = {
    repos: new Map([['shop', 'acme/shop']]),
    token: 'tok',
    fetchPrs: async (o) => { asked.push(o); return [pr(1, 'Alex'), pr(2, 'someone-else')]; },
    docs: {
      upsertDoc: async (doc) => { refs.push(doc.ref); return `doc:${doc.ref}`; },
      getCursor: async (k) => cursors.get(k) ?? null,
      setCursor: async (k, v) => { cursors.set(k, v); },
      githubRepairDocs: async () => [],
      githubDocChunks: async () => null,
    },
    embed: async (t) => t.map(() => [1]),
    activity: { record: async (a) => { activity.push(a); } },
    now: () => '2026-10-22T12:00:00Z',
    minIntervalMs: 0,
    ...over,
  };
  return { deps, refs, asked, activity };
}

test('a project limited to one author asks GitHub for their PRs and keeps only theirs, whatever the case of the login', async () => {
  const s = setup({ authors: new Map([['shop', 'alex']]) });
  expect(await syncGithub(s.deps)).toEqual({ prs: 2 });
  expect(s.asked[0].author).toBe('alex');
  expect(s.refs).toEqual(['github:acme/shop#1']);
  // The Activity names what was listed; one pull request reads in the singular.
  const one = setup({ fetchPrs: async () => [pr(3, 'dev')] });
  await syncGithub(one.deps);
  expect(one.activity[0].subject).toBe('synced 1 pull request from acme/shop');
  expect(one.asked).toEqual([]);
});

test('a shared rate limit stops the sync of the remaining repositories; another failure does not', async () => {
  const synced: string[] = [];
  const logs: string[] = [];
  const s = setup({
    repos: new Map([['a', 'acme/a'], ['b', 'acme/b'], ['c', 'acme/c']]),
    fetchPrs: async (o) => {
      synced.push(o.repo);
      if (o.repo === 'acme/a') throw new Error('github 500');
      if (o.repo === 'acme/b') throw new IntegrationError('rate limited', 'rate_limit', '2026-10-22T13:00:00Z');
      return [];
    },
    log: (m) => { logs.push(m); },
  });
  expect(await syncGithub(s.deps)).toEqual({ prs: 0 });
  expect(synced).toEqual(['acme/a', 'acme/b']);
  expect(logs.filter((m) => m === 'github sync failed')).toHaveLength(2);
});
