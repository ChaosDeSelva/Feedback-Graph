import { describe, expect, test } from 'vitest';
import { authorKindOf, FEEDBACK_SKIP_RULES, feedbackSkipRule, parseLogins } from './feedbackRules.ts';
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
