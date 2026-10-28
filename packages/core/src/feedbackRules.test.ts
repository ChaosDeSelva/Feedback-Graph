import { describe, expect, test } from 'vitest';
import { authorKindOf, FEEDBACK_SKIP_RULES, feedbackSkipRule, foldsIntoInline, isNitComment, isSelfReview, parseLogins } from './feedbackRules.ts';
import type { ExternalRef } from './types.ts';

const ext = (extra: Partial<ExternalRef> = {}): ExternalRef => ({
  source: 'github', kind: 'review_comment', author: 'lead', url: 'u', thread: 'acme/shop#7', title: 'Add checkout', threadUrl: 'u',
  path: 'src/cart.ts', line: 3, diffHunk: null, branch: 'feat', createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: [], ...extra,
});

describe('authorKindOf', () => {
  test('a [bot] login or a configured bot login is a bot, verified by login', () => {
    expect(authorKindOf({ source: 'github', login: 'docs-check[bot]', body: 'Docs out of date' })).toEqual({ kind: 'bot', verified: true });
    expect(authorKindOf({ source: 'github', login: 'Acme-CI', body: 'Docs out of date', botLogins: ['acme-ci'] })).toEqual({ kind: 'bot', verified: true });
  });

  test('Linear names are free text: no [bot] suffix and no login list ever make a Linear author a bot or a verified agent', () => {
    expect(authorKindOf({ source: 'linear', login: 'docs-check[bot]', body: 'Docs out of date', botLogins: ['docs-check[bot]'] })).toEqual({ kind: 'human', verified: false });
    expect(authorKindOf({ source: 'linear', login: 'review-agent', body: 'x', agentLogins: ['review-agent'] })).toEqual({ kind: 'human', verified: false });
    expect(authorKindOf({ source: 'linear', login: 'jo', body: '[claude] missing test' })).toEqual({ kind: 'agent', verified: false });
  });

  test.each([
    '[claude] Fixed in 3f2a9c1',
    '[codex] this misses the null case',
    '[P1] Guard against an empty cart',
    '**[P2] Handle the timeout**',
    '  [p3] nit: rename this',
  ])('an AI-authored marker makes it an agent, unverified: %s', (body) => {
    expect(authorKindOf({ source: 'github', login: 'jo', body })).toEqual({ kind: 'agent', verified: false });
  });

  test('a configured agent login is a verified agent; anyone else is human', () => {
    expect(authorKindOf({ source: 'github', login: 'review-agent', body: 'missing a test', agentLogins: ['review-agent'] })).toEqual({ kind: 'agent', verified: true });
    expect(authorKindOf({ source: 'github', login: 'jo', body: 'this should use [P1] priority labels' }).kind).toBe('human');
    expect(authorKindOf({ source: 'github', login: 'jo', body: 'why is this here?' }).kind).toBe('human');
  });
});

test('parseLogins splits a comma list, trimmed and lower-cased', () => {
  expect(parseLogins(' Acme-CI , ,docs-bot ')).toEqual(['acme-ci', 'docs-bot']);
  expect(parseLogins(undefined)).toEqual([]);
});

describe('feedbackSkipRule', () => {
  test('every rule has a unique name and a description for the UI', () => {
    const names = FEEDBACK_SKIP_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const r of FEEDBACK_SKIP_RULES) expect(r.description.length).toBeGreaterThan(20);
  });

  test('a bot is skipped', () => {
    expect(feedbackSkipRule('Docs out of date (HIGH)', ext({ authorKind: 'bot' }))?.name).toBe('bot-author');
  });

  test("the PR author's reply in a review thread is skipped; a comment of theirs that starts a thread is not", () => {
    expect(feedbackSkipRule('good catch, see the next commit', ext({ author: 'jo', threadAuthor: 'jo', isReply: true, repliesTo: 'lead' }))?.name).toBe('pr-author-reply');
    // The PR author replying in a thread they opened themselves (a solo developer reviewing their agent's PR), or to a
    // comment whose author is unknown, is not answering a reviewer: it is classified.
    expect(feedbackSkipRule('and the test is missing, again', ext({ author: 'jo', threadAuthor: 'jo', isReply: true, repliesTo: 'jo' }))).toBeNull();
    expect(feedbackSkipRule('and the test is missing, again', ext({ author: 'jo', threadAuthor: 'jo', isReply: true }))).toBeNull();
    expect(feedbackSkipRule('the agent broke the totals here', ext({ author: 'jo', threadAuthor: 'jo', isReply: false }))).toBeNull();
    expect(feedbackSkipRule('good catch', ext({ author: 'lead', threadAuthor: 'jo', isReply: true }))).toBeNull();
  });

  const byAuthor = ext({ author: 'jo', threadAuthor: 'jo', kind: 'issue_comment' });
  test.each([
    'Fixed in 3f2a9c1',
    '[claude] Fixed in 3f2a9c1.',
    'Done in a1b2c3d',
    'Resolved',
    'Acknowledged, known tradeoff',
    'Addressed in #42',
    'Not applicable after 3f2a9c1',
    'Closing: dead end, superseded by #15',
  ])("the PR author's status note is skipped: %s", (text) => {
    expect(feedbackSkipRule(text, byAuthor)?.name).toBe('status-note');
  });

  // Real-looking status notes a PR author (or their agent) posts when a thread is done: no feedback in any of them.
  test.each([
    'Fixed: moved the null check ahead of the loop.',
    'Fixed in the latest commit',
    'Done.',
    'Closing in favour of #812',
    'Closing in favor of acme/web#77.',
    'Superseded by #455.',
    'Addressed in the latest commit.',
    'Good catch, fixed in 9e1d0c4.',
    'Thanks! Done in the last push.',
    '[claude] Fixed: the handler now returns 404 for a missing id.',
    'Updated.',
    'Resolved in the follow-up commit.',
    'Replaced by #90',
    'Done: renamed to `cartTotal` everywhere.',
  ])("the PR author's status note is skipped: %s", (text) => {
    expect(feedbackSkipRule(text, byAuthor)?.name).toBe('status-note');
  });

  // Real corrections that open with the same words: a solo developer reviewing their agent's PR under their own
  // account writes these, so the rule must leave every one of them to the classifier.
  test.each([
    'Fixed? No, the empty-list case still throws.',
    'Fixed in a1b2c3d broke the login redirect, please revert it.',
    'Done is not done: the second call site still uses the old helper.',
    'Fixed: not really, the test only passes because it is skipped.',
    'Addressed in the latest commit? I still see the raw SQL on line 40.',
    'Superseded by #456 is wrong, that PR was closed without merging.',
    'Closing in favour of #123 was a mistake; reopen this and keep the original approach.',
    'Done. But you also deleted the migration, put it back.',
    'Updated the docs but the code path is unchanged, fix the handler too.',
    'Resolved the conflict wrong: the retry loop from main is gone.',
    'Fixed: but now the totals ignore discounts.',
    'Done: you only changed one of the three call sites, do the other two.',
  ])('a correction that opens with status words is kept, even by the PR author: %s', (text) => {
    expect(feedbackSkipRule(text, byAuthor)).toBeNull();
  });

  test('a verified bot or agent may post status notes; an unverified marker may not', () => {
    expect(feedbackSkipRule('Resolved', ext({ authorKind: 'agent', authorVerified: true }))?.name).toBe('status-note');
    expect(feedbackSkipRule('[claude] Resolved', ext({ authorKind: 'agent', authorVerified: false }))).toBeNull();
  });

  test("a reviewer's status words are classified as usual", () => {
    expect(feedbackSkipRule('Resolved', ext())).toBeNull();
    expect(feedbackSkipRule('Closing: this is wrong', ext())).toBeNull();
  });

  test.each([
    'Resolved? No, the totals are still wrong when the cart is empty',
    'Fixed in 3f2a9c1 but you broke the discount path',
    'Acknowledged, but this is wrong and must change',
    'Done in a1b2c3d. The tests do not pass though.',
  ])('a comment that only starts like a status note is not one, even by the PR author: %s', (text) => {
    expect(feedbackSkipRule(text, byAuthor)).toBeNull();
  });

  test.each(['@claude review', '@codex review', '@claude please review this', '@codex re-review', '/review'])('a bare review trigger is skipped: %s', (text) => {
    expect(feedbackSkipRule(text, ext({ kind: 'issue_comment' }))?.name).toBe('review-trigger');
  });

  test('a mention that asks for something specific is kept', () => {
    expect(feedbackSkipRule('@claude review the cart totals, they are wrong', ext({ kind: 'issue_comment' }))).toBeNull();
  });

  test('a reviewer pushing back is kept', () => {
    expect(feedbackSkipRule('this misses the server-side filter', ext())).toBeNull();
    expect(feedbackSkipRule('[P1] the totals ignore discounts', ext({ authorKind: 'agent' }))).toBeNull();
  });
});

describe('isSelfReview', () => {
  test("an agent comment under the pull request author's own account is a self-review", () => {
    expect(isSelfReview(ext({ author: 'Dev', threadAuthor: 'dev', authorKind: 'agent' }))).toBe(true);
  });

  test('a person, another account, a bot, Linear, or a comment synced before authors were kept is not', () => {
    expect(isSelfReview(ext({ author: 'dev', threadAuthor: 'dev', authorKind: 'human' }))).toBe(false);
    expect(isSelfReview(ext({ author: 'lead', threadAuthor: 'dev', authorKind: 'agent' }))).toBe(false);
    expect(isSelfReview(ext({ author: 'dev', threadAuthor: 'dev', authorKind: 'bot' }))).toBe(false);
    expect(isSelfReview(ext({ source: 'linear', author: 'dev', threadAuthor: 'dev', authorKind: 'agent' }))).toBe(false);
    expect(isSelfReview(ext({ author: 'dev' }))).toBe(false);
  });
});

describe('noise reviews (skip rules v3): review content that is not pushback', () => {
  const review = (extra: Partial<ExternalRef> = {}) => ext({ kind: 'review', path: null, line: null, ...extra });

  test.each([
    'Claude Code here. I reviewed the changes in this PR:\n\n1. `loadBatches` reads the whole table into memory\n2. The retry loop never backs off',
    '🤖 Automated review\n\nThe migration drops the `orders_idx` index without recreating it.',
    'This is an automated review generated by Codex.\n\n- `pipeline/load.py`: the batch size is hard-coded',
    'The batch loader should stream rows.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ])('a review whose body says an AI or a bot wrote it is skipped: %s', (text) => {
    expect(feedbackSkipRule(text, review())?.name).toBe('ai-review');
  });

  test('a person blaming a bot, or an emoji in a real comment, is kept', () => {
    expect(feedbackSkipRule('Claude Code wrote this loop and it never backs off; please add a delay.', ext())).toBeNull();
    expect(feedbackSkipRule('The 🤖 emoji in the toast is off-brand, use the icon set.', ext())).toBeNull();
  });

  test.each([
    ['LGTM', {}],
    ['LGTM 🚀', {}],
    ['Looks good to me, nice work on the retry handling!', { reviewState: 'APPROVED' as const }],
    ['Approved. Clean split of the loader.\n\nnit (optional): `batchSize` could be a constant.', { reviewState: 'APPROVED' as const }],
    ['Great work, ship it. Minor: the log line has a typo, non-blocking.', { reviewState: 'APPROVED' as const }],
  ])('an approval with nothing asked to change is skipped: %s', (text, extra) => {
    expect(feedbackSkipRule(text, review(extra))?.name).toBe('approval-summary');
  });

  test('an approval that still asks for a change is kept', () => {
    const approved = review({ reviewState: 'APPROVED' });
    expect(feedbackSkipRule('Approving to unblock, but the loader must not swallow the timeout error. Please fix before merging.', approved)).toBeNull();
    expect(feedbackSkipRule('LGTM, but why does `loadBatches` read the whole table?', approved)).toBeNull();
    expect(feedbackSkipRule('Looks good except the retry: it should back off.', review())).toBeNull();
    expect(feedbackSkipRule('LGTM once the timeout is handled.', review())).toBeNull();
  });

  test('a variation selector on an unrelated emoji is not a resolved-review status', () => {
    const table = '| Field | Value |\n|---|---|\n| A | ☀️ |\n| B | ☀️ |';
    expect(feedbackSkipRule(table, review())).toBeNull();
  });

  test('a status table relaying earlier review comments is skipped', () => {
    const table = [
      'Status of the review findings:',
      '',
      '| # | Finding | Status |',
      '|---|---------|--------|',
      '| 1 | Batch size hard-coded | ✅ Fixed in 3f2a9c1 |',
      '| 2 | Retry never backs off | Addressed |',
      '| 3 | Missing index on `orders.created_at` | Open |',
    ].join('\n');
    expect(feedbackSkipRule(table, ext({ kind: 'issue_comment', path: null, line: null }))?.name).toBe('status-table');
  });

  test('a table that is the finding itself (no status column) is kept', () => {
    const table = ['The new totals are wrong:', '', '| cart | expected | got |', '|---|---|---|', '| A | 10.00 | 9.99 |', '| B | 5.00 | 4.99 |'].join('\n');
    expect(feedbackSkipRule(table, ext({ kind: 'issue_comment' }))).toBeNull();
  });

  test.each([
    "@sam let's hold off merging this until your schema branch lands, then rebase.",
    '@alex can you rebase after #412 merges? Then this one can go in.',
    '@jordan your branch touches the same loader; merge yours first and I will rebase.',
  ])('a comment to another author about when branches merge is skipped: %s', (text) => {
    expect(feedbackSkipRule(text, ext({ kind: 'issue_comment', path: null, line: null }))?.name).toBe('branch-timing');
  });

  test('a mention that is about the code is kept', () => {
    expect(feedbackSkipRule('@sam the loader still merges duplicate rows; dedupe on `order_id` before insert.', ext({ kind: 'issue_comment' }))).toBeNull();
  });

  test('a review summary that repeats its inline comments folds into them', () => {
    const folded = review({ foldedInto: 'github:acme/data-pipeline#12/review_comment/9' });
    expect(feedbackSkipRule('Two issues: the batch size is hard-coded, and the retry never backs off.', folded)?.name).toBe('review-folded');
  });

  test('a nit is kept (it may still be an Inbox item), and known as one', () => {
    for (const t of ['nit: rename `tmp` to `batch`', 'Minor: this log line is noisy', 'optional nit: inline this helper', '**nit** trailing comma', '(optional) inline this helper']) {
      expect(feedbackSkipRule(t, ext())).toBeNull();
      expect(isNitComment(t)).toBe(true);
    }
    expect(isNitComment('The loader drops the minor version from the schema id.')).toBe(false);
    expect(isNitComment('this breaks the nightly export')).toBe(false);
  });
});

describe('foldsIntoInline', () => {
  const inline = [
    'The batch size is hard-coded to 500; read it from `PIPELINE_BATCH_SIZE`.',
    'This retry loop never backs off, so a down warehouse gets hammered.',
  ];

  test('a summary made of its inline comments folds', () => {
    expect(foldsIntoInline('Batch size is hard-coded to 500, read it from PIPELINE_BATCH_SIZE. The retry loop never backs off, so a down warehouse gets hammered.', inline)).toBe(true);
  });

  test('a summary that says something the inline comments do not is its own item', () => {
    expect(foldsIntoInline('Besides the inline notes: the whole job should run inside one transaction, otherwise a failed batch leaves half an import behind.', inline)).toBe(false);
    expect(foldsIntoInline('Batch size is hard-coded.', [])).toBe(false);
    expect(foldsIntoInline('', inline)).toBe(false);
  });
});
