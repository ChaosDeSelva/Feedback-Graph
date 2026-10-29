import { expect, test } from 'vitest';
import { IntegrationError, prContextToChunks, redactSecrets, type PrContext } from '@fb/core';
import { githubRepairCursor, repairGithubDocs } from './githubRepair.ts';
const pr = (number: number, body = 'Basic concepts'): PrContext => ({ repo: 'acme/shop', number, title: 'T', body, author: 'a', state: 'closed', updatedAt: '2026-10-01T00:00:00Z', url: 'https://github.com/acme/shop/pull/1', headBranch: null, comments: [] });
function setup() {
  const values = new Map<string, string>(); const stored: number[] = []; let current: string[] | null = null; const fetched: number[][] = [];
  const docs = { githubDocChunks: async (_id: string) => current, getCursor: async (key: string) => values.get(key) ?? null, setCursor: async (key: string, value: string) => { values.set(key, value); }, githubRepairDocs: async (_key: string, after: string) => after ? [] : [{ id: 'd1', ref: 'github:acme/shop#1', chunks: ['Basic [REDACTED]'] }] };
  return { values, stored, fetched, d: { projectKey: 'shop', repo: 'acme/shop', token: 'private', docs, now: '2026-10-29T00:00:00Z', fetchPrs: async (opts: { numbers?: number[] }) => { fetched.push(opts.numbers!); return [pr(opts.numbers![0])]; }, store: async (value: PrContext) => { stored.push(value.number); current = prContextToChunks(value).map(chunk => redactSecrets(chunk.text)); } } };
}
test('old false done does not suppress targeted repair, and literal source masks are not claimed as repairs', async () => {
  const s = setup(); s.values.set('github-redaction-source-repair-v8:shop', 'done');
  expect((await repairGithubDocs(s.d)).repairedMasks).toBe(1);
  expect(s.fetched).toEqual([[1]]);
  const literal = setup(); literal.d.fetchPrs = async () => [pr(1, 'literal [REDACTED]')];
  const result = await repairGithubDocs(literal.d);
  expect(result.progress.literal).toBe(1);
  expect(result.repairedMasks).toBe(0);
});
test('rate-limited target is pending with durable retry instead of marked done or retried immediately', async () => {
  const s = setup(); let attempts = 0;
  s.d.fetchPrs = async () => { attempts++; throw new IntegrationError('limited', 'rate_limit', '2026-10-29T01:00:00Z'); };
  expect((await repairGithubDocs(s.d)).rateLimited).toBe(true);
  expect(JSON.parse(s.values.get(githubRepairCursor('shop'))!)).toMatchObject({ status: 'waiting', pending: 1, nextRetryAt: '2026-10-29T01:00:00Z' });
  await repairGithubDocs(s.d);
  expect(attempts).toBe(1);
  s.d.now = '2026-10-29T01:01:00Z'; s.d.fetchPrs = async () => [pr(1)];
  const repaired = await repairGithubDocs(s.d);
  expect(repaired.repairedMasks).toBe(1);
  expect(repaired.progress.pending).toBe(0);
});
test('partial progress survives a later target failure', async () => {
  const s = setup();
  s.d.docs.githubRepairDocs = async (_key, after) => [{ id: 'd1', ref: 'github:acme/shop#1', chunks: ['Basic [REDACTED]'] }, { id: 'd2', ref: 'github:acme/shop#2', chunks: ['Basic [REDACTED]'] }].filter(doc => doc.id > after);
  s.d.fetchPrs = async opts => { if (opts.numbers![0] === 2) throw new Error('transient'); return [pr(1)]; };
  const result = await repairGithubDocs(s.d);
  expect(result.progress).toMatchObject({ after: 'd1', repaired: 1, status: 'waiting' });
  expect(s.stored).toEqual([1]);
});


test('literal source masks are fingerprinted and do not cause repeated source fetches', async () => {
  const s = setup(); const original = pr(1, 'This documentation intentionally says [REDACTED].');
  s.d.docs.githubRepairDocs = async () => [{ id: 'd1', ref: 'github:acme/shop#1', chunks: prContextToChunks(original).map(chunk => chunk.text).filter(text => text.includes('[REDACTED]')) }];
  let fetches = 0;
  s.d.fetchPrs = async () => { fetches++; return [original]; };
  expect((await repairGithubDocs(s.d)).progress.literal).toBe(1);
  const second = await repairGithubDocs(s.d);
  expect(fetches).toBe(1);
  expect(second.fetchedDocs).toBe(0);
  expect(second.repairedMasks).toBe(0);
});


test('a successful write call that leaves old chunks cannot mark repair verified', async () => {
  const s = setup(); s.d.docs.githubDocChunks = async () => ['still [REDACTED]'];
  const result = await repairGithubDocs(s.d);
  expect(result.progress.status).toBe('waiting');
  expect(result.progress.pending).toBe(1);
  expect(result.fetchedDocs).toBe(0);
});
