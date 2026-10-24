import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CandidateDetail } from './CandidateDetail.tsx';
import { Inbox } from './Inbox.tsx';

const external = {
  source: 'github', kind: 'review_comment', author: 'lead', url: 'https://github.com/acme/shop/pull/7#discussion_r1', thread: 'acme/shop#7',
  title: 'Add checkout', threadUrl: 'https://github.com/acme/shop/pull/7', path: 'src/cart.ts', line: 12, diffHunk: '@@ -1 +1 @@\n+  total += price',
  branch: 'feat/checkout', createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: ['sess-1234abcd'],
};
const cand = (id: string, summary: string, source: string, ext?: object) => ({
  id, turnUuid: id, sessionId: 's', projectKey: 'shop', source, ...(ext ? { external: ext } : {}),
  classification: { label: 'pushback', confidence: 0.9, summary, signals: [] },
  status: 'pending', createdAt: '2026-10-01T10:00:00Z', decidedAt: null, note: null,
});
const list = [cand('c1', 'from the session', 'claude'), cand('g1', 'from the review', 'github', external)];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/candidates?')) return Response.json(list);
    if (url === '/api/candidates/g1') {
      return Response.json({
        candidate: list[1],
        turn: { uuid: 'g1', sessionId: 'github:acme/shop#7', ts: '2026-10-02T10:00:00Z', index: 1, text: 'prices must be integers in cents', precedingAssistantText: 'PR acme/shop#7', precedingToolCalls: [], external },
        before: [], after: [{ uuid: 'g2', sessionId: 'github:acme/shop#7', ts: '2026-10-02T11:00:00Z', index: 2, text: 'fixed', precedingAssistantText: '', precedingToolCalls: [], external: { ...external, author: 'dev', kind: 'issue_comment', path: null, line: null } }],
        commits: [], postmortem: null,
      });
    }
    if (url === '/api/candidates/c1') {
      return Response.json({ candidate: list[0], turn: { uuid: 'c1', sessionId: 's', ts: '2026-10-01T10:00:00Z', index: 2, text: 'session words', precedingAssistantText: 'done', precedingToolCalls: [] }, before: [], after: [], commits: [], postmortem: null });
    }
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('each item names its source, and the list can be filtered by source', async () => {
  render(<Inbox />);
  const list = await screen.findByRole('list');
  await within(list).findByText('from the review');
  expect(within(list).getByText('Claude')).toBeTruthy();
  expect(within(list).getByText('GitHub')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('source'), { target: { value: 'github' } });
  await waitFor(() => expect(within(screen.getByRole('list')).queryByText('from the session')).toBeNull());
  expect(within(screen.getByRole('list')).getByText('from the review')).toBeTruthy();
});

test('a review comment shows the reviewer, the file and diff, links out, and links the work session', async () => {
  render(<Inbox />);
  await screen.findByText('session words');
  fireEvent.change(screen.getByLabelText('source'), { target: { value: 'github' } });
  expect(await screen.findByText('prices must be integers in cents')).toBeTruthy();
  expect(screen.getByText('lead')).toBeTruthy();
  expect(screen.getByText('src/cart.ts:12')).toBeTruthy();
  expect(screen.getByText(/total \+= price/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open on GitHub' }).getAttribute('href')).toBe('https://github.com/acme/shop/pull/7');
  expect(screen.getByRole('link', { name: 'sess-123' }).getAttribute('href')).toBe('#sessions/sess-1234abcd');
  expect(screen.getByText('fixed')).toBeTruthy();
  expect(screen.queryByText('right before')).toBeNull();
});

const detailOf = (ext: object) => ({
  candidate: { ...list[1], external: ext },
  turn: { uuid: 'g1', sessionId: 'x', ts: '2026-10-02T10:00:00Z', index: 1, text: 'prices must be integers in cents', precedingAssistantText: '', precedingToolCalls: [], external: ext },
  before: [], after: [], commits: [], postmortem: null,
}) as never;

test('a PR comment card shows the PR description', () => {
  render(<CandidateDetail detail={detailOf({ ...external, description: '## Why\nCheckout must keep **cents**.' })} />);
  expect(screen.getByText('Description')).toBeTruthy();
  expect(screen.getByText('Why')).toBeTruthy();
  expect(screen.getByText(/Checkout must keep/)).toBeTruthy();
});

test('a Linear comment card shows the ticket: state, priority, labels, assignee and description', () => {
  const linear = {
    ...external, source: 'linear', kind: 'linear_comment', thread: 'ENG-42', title: 'Cents everywhere', threadUrl: 'https://linear.app/acme/issue/ENG-42', path: null, line: null, diffHunk: null,
    description: 'Store every price as integer cents.', ticket: { state: 'In Review', priority: 'Urgent', labels: ['billing', 'bug'], assignee: 'jo' },
  };
  render(<CandidateDetail detail={detailOf(linear)} />);
  expect(screen.getByText('Linear issue ENG-42')).toBeTruthy();
  expect(screen.getByText('In Review')).toBeTruthy();
  expect(screen.getByText('Urgent')).toBeTruthy();
  expect(screen.getByText('billing, bug')).toBeTruthy();
  expect(screen.getByText('jo')).toBeTruthy();
  expect(screen.getByText('Store every price as integer cents.')).toBeTruthy();
});

test('a card without a description shows no description section', () => {
  render(<CandidateDetail detail={detailOf(external)} />);
  expect(screen.queryByText('Description')).toBeNull();
});

test('a comment with no work session found links none, and says the post-mortem works from the comment', () => {
  const ext = { ...external, linkedSessionIds: [] };
  const turn = { uuid: 'g1', sessionId: 'github:acme/shop#7', ts: '2026-10-02T10:00:00Z', index: 1, text: 'prices must be integers in cents', precedingAssistantText: '', precedingToolCalls: [], external: ext };
  render(<CandidateDetail detail={{ candidate: { ...list[1], external: ext }, turn, before: [], after: [], commits: [], postmortem: null } as never} />);
  expect(screen.getByText('Work session')).toBeTruthy();
  expect(screen.getByText(/none found yet/)).toBeTruthy();
  expect(screen.queryAllByRole('link').map((a) => a.getAttribute('href')).filter((h) => h?.startsWith('#sessions/'))).toEqual([]);
});
