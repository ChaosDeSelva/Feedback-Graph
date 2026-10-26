import { SKIP_RULES_VERSION, type ActivityInput, type ExternalRef, type PendingExternalItem } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { describeStampChange, SKIP_RULES_CURSOR, skipMatchingPending, skipPendingOnRulesChange, skipRulesStamp } from './pendingSkips.ts';

const ext = (o: Partial<ExternalRef> = {}): ExternalRef => ({
  source: 'github', kind: 'review_comment', author: 'lead', url: 'u', thread: 'acme/shop#9', title: 'Keep cents', threadUrl: 'u',
  path: 'src/cart.ts', line: 4, diffHunk: null, branch: 'feat/cart', createdAt: '2026-10-13T10:00:00Z', linkedSessionIds: [],
  authorKind: 'human', authorVerified: false, threadAuthor: 'dev', ...o,
});

const item = (id: string, text: string, external: ExternalRef, projectKey = 'shop'): PendingExternalItem => ({ id, turnUuid: id, projectKey, text, external });

/** A store holding pending items, paged by id like the real ones; skipping one takes it out of the pending list. */
function fakeGraph(items: PendingExternalItem[], o: { decided?: Set<string> } = {}) {
  const skipped: { id: string; rule: string; note: string; by: string }[] = [];
  const pages: (string | null)[] = [];
  const graph = {
    pendingExternalItems: async (q: { limit: number; afterId?: string | null }) => {
      pages.push(q.afterId ?? null);
      return items
        .filter((i) => !skipped.some((s) => s.id === i.id) && (!q.afterId || i.id > q.afterId))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, q.limit);
    },
    skipPendingItem: async (id: string, s: { rule: string; note: string; by: string }) => {
      if (o.decided?.has(id)) return false;
      skipped.push({ id, ...s });
      return true;
    },
  };
  return { graph, skipped, pages };
}

const own = ext({ author: 'dev', kind: 'issue_comment' });

describe('skipMatchingPending', () => {
  test('pending items a rule now matches are skipped with the rule as the reason; feedback stays pending', async () => {
    const g = fakeGraph([
      item('a', 'Fixed: moved the null check ahead of the loop.', own),
      item('b', 'Closing in favour of #812', own),
      item('c', 'Fixed? No, the empty-list case still throws.', own),
      item('d', 'this drops the discount for members', ext()),
      item('e', 'Superseded by #455.', own, 'web'),
    ]);
    const activity: ActivityInput[] = [];
    const r = await skipMatchingPending({ graph: g.graph, activity: { record: async (a) => void activity.push(a) }, why: 'the skip rules changed' });
    expect(r).toEqual({ skipped: 3, byProject: { shop: { 'status-note': 2 }, web: { 'status-note': 1 } } });
    expect(g.skipped.map((s) => s.id)).toEqual(['a', 'b', 'e']);
    expect(g.skipped[0]).toMatchObject({ rule: 'status-note', by: 'skip-rules', note: expect.stringContaining('status-note') });
    // One comments_skipped entry per project, so Settings counts them per rule beside the comments skipped at sync.
    const shop = activity.find((a) => a.projectKey === 'shop');
    expect(shop).toMatchObject({ kind: 'comments_skipped', actor: 'skip-rules', targets: ['a', 'b'], details: { rules: { 'status-note': 2 }, pending: 2, rulesVersion: SKIP_RULES_VERSION } });
    expect(shop?.subject).toBe('2 pending Inbox items skipped: a skip rule matches them now');
    expect(shop?.why).toMatch(/^the skip rules changed; status-note: 2$/);
    expect(activity).toHaveLength(2);
  });

  test('a decision made in the meantime stands and is not counted', async () => {
    const g = fakeGraph([item('a', 'Done.', own), item('b', 'Done.', own)], { decided: new Set(['a']) });
    const r = await skipMatchingPending({ graph: g.graph, why: 'x' });
    expect(r.skipped).toBe(1);
  });

  test('the configured bot and agent logins apply to what was stored before they were set', async () => {
    // Stored as a person's comment; GITHUB_BOT_LOGINS now lists the account.
    const g = fakeGraph([item('a', 'Coverage dropped 0.2%', ext({ author: 'acme-ci' })), item('b', 'Resolved', ext({ author: 'review-agent' }))]);
    const r = await skipMatchingPending({ graph: g.graph, why: 'x', botLogins: ['acme-ci'], agentLogins: ['review-agent'] });
    expect(g.skipped.map((s) => [s.id, s.rule])).toEqual([['a', 'bot-author'], ['b', 'status-note']]);
    expect(r.skipped).toBe(2);
  });

  test('the noise rules of v3 clear what was pending before them: an AI review, an approval, a status table, a branch-timing note', async () => {
    const review = ext({ kind: 'review', path: null, line: null, thread: 'acme/data-pipeline#12' });
    const g = fakeGraph([
      item('a', 'Claude Code here. I reviewed the loader: `loadBatches` reads the whole table into memory.', review),
      item('b', 'LGTM, nice work on the retry handling!', { ...review, reviewState: 'APPROVED' }),
      item('c', '| # | Finding | Status |\n|---|---|---|\n| 1 | Batch size | Fixed |\n| 2 | Retry | Addressed |', ext({ kind: 'issue_comment', path: null })),
      item('d', '@sam hold off merging until your schema branch lands, then rebase.', ext({ kind: 'issue_comment', path: null })),
      item('e', 'nit: rename `tmp` to `batch`', ext()),
      item('f', 'The loader swallows the timeout error; surface it.', review),
    ]);
    await skipMatchingPending({ graph: g.graph, why: 'x' });
    expect(g.skipped.map((s) => [s.id, s.rule])).toEqual([['a', 'ai-review'], ['b', 'approval-summary'], ['c', 'status-table'], ['d', 'branch-timing']]);
  });

  test("a pending review summary that repeats the same reviewer's pending inline comments folds into them", async () => {
    const on = (o: Partial<ExternalRef>) => ext({ thread: 'acme/data-pipeline#12', author: 'lead', createdAt: '2026-10-22T10:00:00Z', ...o });
    const g = fakeGraph([
      item('i1', 'The batch size is hard-coded to 500; read it from `PIPELINE_BATCH_SIZE`.', on({ path: 'pipeline/load.py' })),
      item('i2', 'This retry loop never backs off, so a down warehouse gets hammered.', on({ path: 'pipeline/retry.py' })),
      item('r1', 'Batch size is hard-coded to 500, read it from PIPELINE_BATCH_SIZE. The retry loop never backs off, so a down warehouse gets hammered.', on({ kind: 'review', path: null, createdAt: '2026-10-22T10:00:03Z' })),
      // The same words from another reviewer, and on another PR: not a summary of these.
      item('r2', 'Batch size is hard-coded to 500, read it from PIPELINE_BATCH_SIZE. The retry loop never backs off, so a down warehouse gets hammered.', on({ kind: 'review', path: null, author: 'sam' })),
      item('r3', 'Batch size is hard-coded to 500, read it from PIPELINE_BATCH_SIZE. The retry loop never backs off, so a down warehouse gets hammered.', on({ kind: 'review', path: null, thread: 'acme/web#3' })),
    ]);
    await skipMatchingPending({ graph: g.graph, why: 'x' });
    expect(g.skipped.map((s) => [s.id, s.rule])).toEqual([['r1', 'review-folded']]);
  });

  test('only the named project, when one is named; every page is read', async () => {
    const many = Array.from({ length: 1203 }, (_, i) => item(`k${String(i).padStart(5, '0')}`, i % 2 ? 'Done.' : 'the totals are wrong', own, i % 3 ? 'shop' : 'web'));
    const g = fakeGraph(many);
    const r = await skipMatchingPending({ graph: g.graph, why: 'x', projectKey: 'shop' });
    expect(r.skipped).toBe(many.filter((m, i) => i % 2 && m.projectKey === 'shop').length);
    expect(Object.keys(r.byProject)).toEqual(['shop']);
    expect(g.pages.length).toBeGreaterThan(2);
  });
});

describe('skipPendingOnRulesChange', () => {
  function kv() {
    const m = new Map<string, string>();
    return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) };
  }

  test('runs once per rules version: at the first start, then again only when the rules or the logins change', async () => {
    const cursors = kv();
    const g = fakeGraph([item('a', 'Done.', own)]);
    expect(await skipPendingOnRulesChange({ graph: g.graph, cursors })).toBe(1);
    expect(cursors.m.get(SKIP_RULES_CURSOR)).toBe(skipRulesStamp({}));
    expect(await skipPendingOnRulesChange({ graph: g.graph, cursors })).toBeNull();
    expect(g.pages).toHaveLength(1);
    // A new bot login is a rule change too.
    expect(await skipPendingOnRulesChange({ graph: g.graph, cursors, botLogins: ['acme-ci'] })).toBe(0);
    expect(cursors.m.get(SKIP_RULES_CURSOR)).toBe(skipRulesStamp({ botLogins: ['acme-ci'] }));
  });

  test('the stamp names the rules version and does not depend on the order of the logins', () => {
    expect(skipRulesStamp({})).toMatch(new RegExp(`^v${SKIP_RULES_VERSION}\\b`));
    expect(skipRulesStamp({ botLogins: ['b', 'a'] })).toBe(skipRulesStamp({ botLogins: ['a', 'b'] }));
    expect(skipRulesStamp({ botLogins: ['a'] })).not.toBe(skipRulesStamp({ agentLogins: ['a'] }));
  });

  test('Activity says what changed: the rules version, the login lists, or both, never the same hash as old and new', async () => {
    const now = skipRulesStamp({});
    const hash = now.split(' ')[1];
    const older = `v${SKIP_RULES_VERSION - 1} ${hash}`;
    const why = describeStampChange(older, now);
    expect(why).toBe(`the skip rules changed from version ${SKIP_RULES_VERSION - 1} to ${SKIP_RULES_VERSION} (the bot and agent login lists are unchanged)`);
    expect(why.split(hash).length - 1).toBeLessThan(2);
    const logins = skipRulesStamp({ botLogins: ['acme-ci'] });
    expect(describeStampChange(now, logins)).toBe(`the bot or agent login lists changed (${hash} to ${logins.split(' ')[1]}; skip rules version ${SKIP_RULES_VERSION})`);
    expect(describeStampChange(older, logins)).toMatch(/^the skip rules changed from version \d+ to \d+ and the bot or agent login lists changed/);
    expect(describeStampChange(null, now)).toBe(`the skip rules (version ${SKIP_RULES_VERSION}) had not been run over the Inbox yet`);
    // An older cursor of another shape is quoted as it is.
    expect(describeStampChange('3', now)).toBe(`the skip rules changed (3 to ${now})`);
    // Recorded with the entry.
    const cursors = kv();
    cursors.m.set(SKIP_RULES_CURSOR, older);
    const activity: ActivityInput[] = [];
    await skipPendingOnRulesChange({ graph: fakeGraph([item('a', 'Done.', own)]).graph, cursors, activity: { record: async (a) => void activity.push(a) } });
    expect(activity[0]?.why).toMatch(/^the skip rules changed from version \d+ to \d+ \(the bot and agent login lists are unchanged\);/);
  });

  test('a failure leaves the version unrecorded, so the next start tries again', async () => {
    const cursors = kv();
    const graph = { pendingExternalItems: async () => { throw new Error('db down'); }, skipPendingItem: async () => true };
    await expect(skipPendingOnRulesChange({ graph, cursors })).rejects.toThrow('db down');
    expect(cursors.m.has(SKIP_RULES_CURSOR)).toBe(false);
  });
});
