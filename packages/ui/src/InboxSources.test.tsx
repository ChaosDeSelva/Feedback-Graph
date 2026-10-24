import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
