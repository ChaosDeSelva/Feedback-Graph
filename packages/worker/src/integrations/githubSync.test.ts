import { prBacklogKey, type ActivityInput, type PrContext } from '@fb/core';
import { expect, test } from 'vitest';
import { reposInScope, syncGithub, ticketsCursor, type GithubSyncDeps } from './githubSync.ts';

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
  await s.deps.docs.setCursor(ticketsCursor('shop'), '2026-10-22T11:00:00Z');
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

test('a PR names the Linear tickets in its title, body and branch, so it links to them', async () => {
  const opts: unknown[] = [];
  const s = setup({
    fetchPrs: async () => [{ ...pr(1, 'Fixes ENG-12.'), title: 'Keep cents (ENG-12)', headBranch: 'jo/eng-45-totals' }, pr(2, 'no ticket here')],
  });
  s.deps.docs = { ...s.deps.docs, upsertDoc: async (_doc, _chunks, o) => { opts.push(o); return 'x'; } };
  await syncGithub(s.deps);
  expect(opts).toEqual([{ tickets: ['ENG-12', 'ENG-45'] }, { tickets: [] }]);
});

test('PRs synced before tickets were read are read again once, for the last 14 days, so they link too', async () => {
  const s = setup();
  await s.deps.docs.setCursor('github:shop', '2026-10-22T11:00:00Z');
  await syncGithub({ ...s.deps, minIntervalMs: 0 });
  expect(s.sinces).toEqual(['2026-10-08T12:00:00.000Z']);
  expect(s.cursors.get(ticketsCursor('shop'))).toBe('2026-10-22T12:00:00Z');
  await syncGithub({ ...s.deps, minIntervalMs: 0 });
  expect(s.sinces[1]).toBe('2026-10-22T12:00:00Z');
  // A first sync reads them with tickets already: no second pass.
  const fresh = setup();
  await syncGithub(fresh.deps);
  expect(fresh.cursors.get(ticketsCursor('shop'))).toBe('2026-10-22T12:00:00Z');
});

test('a sync stopped by its PR cap keeps what it did not read as a backlog, reads it on the next syncs, and says so', async () => {
  const calls: { since?: string; until?: string }[] = [];
  // first call: capped at 10-21; second (the backlog, until 10-21): capped again at 10-15; then done
  const capAt = ['2026-10-21T00:00:00Z', null, '2026-10-15T00:00:00Z', null, null];
  const s = setup({
    fetchPrs: async (o) => {
      calls.push({ since: o.since, until: o.until });
      const cap = capAt[calls.length - 1];
      if (cap) o.onCap?.(cap);
      return [pr(calls.length)];
    },
  });
  await s.deps.docs.setCursor('github:shop', '2026-10-01T00:00:00Z');
  await s.deps.docs.setCursor(ticketsCursor('shop'), '2026-10-01T00:00:00Z');
  await syncGithub({ ...s.deps, minIntervalMs: 0 });
  // the newest PRs were read, so the cursor moves on; what lies between the old cursor and 10-21 is the backlog
  expect(s.cursors.get('github:shop')).toBe('2026-10-22T12:00:00Z');
  expect(JSON.parse(s.cursors.get(prBacklogKey('shop'))!)).toEqual({ since: '2026-10-01T00:00:00Z', until: '2026-10-21T00:00:00Z' });
  expect(s.activity.at(-1)).toMatchObject({ kind: 'doc_added', details: { backlog: { since: '2026-10-01T00:00:00Z', until: '2026-10-21T00:00:00Z' } } });
  expect(s.activity.at(-1)!.why).toMatch(/more than 1000 .*updated between 2026-10-01 and 2026-10-21 .*next syncs/i);

  // next sync: the new PRs since the cursor, then one batch of the backlog, which is capped again
  await syncGithub({ ...s.deps, minIntervalMs: 0 });
  expect(calls.slice(1, 3)).toEqual([{ since: '2026-10-22T12:00:00Z', until: undefined }, { since: '2026-10-01T00:00:00Z', until: '2026-10-21T00:00:00Z' }]);
  expect(JSON.parse(s.cursors.get(prBacklogKey('shop'))!)).toEqual({ since: '2026-10-01T00:00:00Z', until: '2026-10-15T00:00:00Z' });

  // and the one after reads the rest: no backlog left
  await syncGithub({ ...s.deps, minIntervalMs: 0 });
  expect(calls[4]).toEqual({ since: '2026-10-01T00:00:00Z', until: '2026-10-15T00:00:00Z' });
  expect(s.cursors.get(prBacklogKey('shop'))).toBe('');
  expect(s.activity.at(-1)!.why).toMatch(/caught up/i);
  expect(s.upserts).toHaveLength(5);
});


test('source repair re-fetches only existing GitHub docs even when the old redaction cursor is done', async () => {
  const s = setup();
  s.cursors.set('redaction-rules', 'v7');
  s.cursors.set('github:shop', '2026-10-22T11:00:00Z');
  s.deps.docs.listDocs = async () => [{ id: 'doc:old', projectKey: 'shop', source: 'github', ref: 'github:acme/shop#1', title: 'old', url: null, addedAt: 't', addedBy: null, chunks: 1, kind: 'text', mediaType: null, read: null }];
  s.deps.fetchPrs = async opts => opts.since === '1970-01-01T00:00:00.000Z' ? [pr(1, 'Basic concepts remain intact'), pr(2)] : [];
  await syncGithub(s.deps);
  expect(s.upserts.map(item => item.doc.ref)).toEqual(['github:acme/shop#1']);
  expect(s.upserts[0].chunks.map(chunk => chunk.text).join(' ')).toContain('Basic concepts remain intact');
  expect(s.cursors.get('github-redaction-source-repair-v8:shop')).toBe('done');
  expect(s.activity[0].details).toMatchObject({ documentsRefetched: 1 });
  await syncGithub(s.deps);
  expect(s.upserts).toHaveLength(1);
});
