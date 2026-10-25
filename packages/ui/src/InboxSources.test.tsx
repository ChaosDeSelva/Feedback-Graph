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

test('a long PR description is clamped in place (no scroll box of its own) with "show more"', () => {
  const description = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the description`).join('\n\n');
  render(<CandidateDetail detail={detailOf({ ...external, description })} />);
  const body = screen.getByTestId('description');
  // Clipped, never scrolled: a scroll box here trapped the wheel above the comments.
  expect(body.className).not.toMatch(/overflow-(auto|scroll|y-auto)/);
  expect(body.className).toMatch(/overflow-hidden/);
  fireEvent.click(screen.getByRole('button', { name: 'show more' }));
  expect(screen.getByTestId('description').className).not.toMatch(/overflow-hidden/);
});

test('a bot comment is collapsed, and long URL-encoded links are shortened', () => {
  const url = `https://vercel.live/open-feedback/shop-git-feat-acme.vercel.app?via=pr-comment-visit-preview-link&passThrough=${'%2F'.repeat(80)}`;
  const bot = { ...external, author: 'vercel[bot]', authorKind: 'bot', kind: 'issue_comment', path: null, line: null };
  const detail = detailOf(external) as unknown as { after: object[] };
  detail.after = [{ uuid: 'b1', sessionId: 'x', ts: '2026-10-02T11:00:00Z', index: 2, text: `Preview Deployment\n\n| Name | Status |\n| shop | Ready | [Visit Preview](${url}) |`, precedingAssistantText: '', precedingToolCalls: [], external: bot }];
  render(<CandidateDetail detail={detail as never} />);
  const text = screen.getByText(/Preview Deployment/);
  expect(text.className).toMatch(/line-clamp/);
  expect(text.textContent).not.toContain('%2F%2F');
  expect(text.textContent).toContain('vercel.live/…');
  fireEvent.click(screen.getByRole('button', { name: 'show the bot comment' }));
  expect(screen.getByText(/Preview Deployment/).className).not.toMatch(/line-clamp/);
});

test('each comment author is labelled with their role: PR author, reviewer, bot or agent', () => {
  const at = (author: string, o: object = {}) => ({ uuid: author, sessionId: 'x', ts: '2026-10-02T11:00:00Z', index: 2, text: `words of ${author}`, precedingAssistantText: '', precedingToolCalls: [], external: { ...external, author, threadAuthor: 'dev', ...o } });
  const detail = { ...(detailOf({ ...external, threadAuthor: 'dev' }) as object), before: [at('dev'), at('ci-helper[bot]', { authorKind: 'bot' }), at('coder-agent', { authorKind: 'agent' })] };
  render(<CandidateDetail detail={detail as never} />);
  const roleOf = (who: string) => screen.getByText(who).parentElement!.textContent;
  expect(roleOf('dev')).toMatch(/PR author/);
  expect(roleOf('lead')).toMatch(/reviewer/);
  expect(roleOf('ci-helper[bot]')).toMatch(/bot/);
  expect(roleOf('coder-agent')).toMatch(/agent/);
});

test('a card without a description shows no description section', () => {
  render(<CandidateDetail detail={detailOf(external)} />);
  expect(screen.queryByText('Description')).toBeNull();
});

test("an agent reviewing its own pull request is labelled self-review, in the detail and in the list", async () => {
  const self = { ...external, author: 'dev', threadAuthor: 'dev', authorKind: 'agent' };
  render(<CandidateDetail detail={detailOf(self)} />);
  expect(screen.getByText('self-review').closest('[title]')?.getAttribute('title')).toMatch(/own pull request/);
  expect(screen.getByText('AI agent')).toBeTruthy();
  cleanup();
  list[1] = cand('g1', 'from the review', 'github', self);
  try {
    render(<Inbox />);
    const items = await screen.findByRole('list');
    expect(await within(items).findByText('self-review')).toBeTruthy();
  } finally {
    list[1] = cand('g1', 'from the review', 'github', external);
  }
});

test('a pending item a skip rule now matches (synced before its author was known) says so, and leaves the decision to you', () => {
  const reply = { ...external, author: 'dev', threadAuthor: 'dev', isReply: true, repliesTo: 'lead' };
  const d = detailOf(reply) as { turn: { text: string } };
  d.turn.text = 'Fixed in ada836b. The cart now keeps cents.';
  render(<CandidateDetail detail={d as never} />);
  const note = screen.getByRole('note');
  expect(note.textContent).toMatch(/pr-author-reply/);
  expect(note.textContent).toMatch(/would not reach the Inbox/);
  // A reviewer's comment matches no rule: no note.
  cleanup();
  render(<CandidateDetail detail={detailOf(external)} />);
  expect(screen.queryByRole('note')).toBeNull();
});

test('a comment with no work session found links none, and says the post-mortem works from the comment', () => {
  const ext = { ...external, linkedSessionIds: [] };
  const turn = { uuid: 'g1', sessionId: 'github:acme/shop#7', ts: '2026-10-02T10:00:00Z', index: 1, text: 'prices must be integers in cents', precedingAssistantText: '', precedingToolCalls: [], external: ext };
  render(<CandidateDetail detail={{ candidate: { ...list[1], external: ext }, turn, before: [], after: [], commits: [], postmortem: null } as never} />);
  expect(screen.getByText('Work session')).toBeTruthy();
  expect(screen.getByText(/none found yet/)).toBeTruthy();
  expect(screen.queryAllByRole('link').map((a) => a.getAttribute('href')).filter((h) => h?.startsWith('#sessions/'))).toEqual([]);
});
