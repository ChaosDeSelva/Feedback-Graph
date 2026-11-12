import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { CandidateDetail, SourceBadge } from './CandidateDetail.tsx';

afterEach(cleanup);

type Detail = Parameters<typeof CandidateDetail>[0]['detail'];
const candidate = { id: 'c1', turnUuid: 't1', sessionId: 's1', projectKey: 'shop', classification: { label: 'pushback', confidence: 0.9, summary: '', signals: [] }, status: 'confirmed', createdAt: '2026-10-01T10:00:00Z', decidedAt: null, note: null };
const turn = (o: object = {}) => ({ uuid: 't1', sessionId: 's1', ts: '2026-10-01T10:00:00Z', index: 3, text: 'no, not like that', precedingAssistantText: '', precedingToolCalls: [{ name: 'Bash', ts: 't', command: 'npm test' }, { name: 'Think', ts: 't' }], ...o });
const ext = {
  source: 'linear', kind: 'issue_comment', author: 'ci-bot', authorKind: 'bot', authorVerified: false, url: null, thread: 'WEB-12', title: 'Fix login',
  threadUrl: 'https://linear.app/acme/issue/WEB-12', path: 'src/login.ts', line: null, diffHunk: null, branch: null, createdAt: '2026-10-02T10:00:00Z',
  linkedSessionIds: ['sess-aaaaaaaa', 'sess-bbbbbbbb'], ticket: { state: 'Todo', priority: null, labels: [], assignee: 'pat' },
};

test('a session item with no summary or agent text says so, and lists each tool call by its command or name', () => {
  render(<CandidateDetail detail={{ candidate, turn: turn(), before: [], after: [], commits: [] } as unknown as Detail} />);
  expect(screen.getByRole('heading', { name: '(no summary)' })).toBeTruthy();
  expect(screen.getByText('(no text)')).toBeTruthy();
  const calls = screen.getAllByRole('listitem').map((li) => li.textContent);
  expect(calls).toEqual(['Bash npm test', 'Think ']);
});

test('a Linear comment by a bot named by a marker, on a file without a line, links each work session and leaves out empty ticket facts', () => {
  render(<CandidateDetail detail={{ candidate: { ...candidate, source: 'linear' }, turn: turn({ external: ext }), before: [], after: [], commits: [] } as unknown as Detail} />);
  expect(screen.getAllByTitle('by a marker in the comment').length).toBeGreaterThan(0);
  expect(screen.getByText('src/login.ts')).toBeTruthy();
  const sessions = screen.getByText('Work session').nextElementSibling as HTMLElement;
  expect(sessions.textContent).toBe('sess-aaa, sess-bbb');
  expect(within(sessions).getAllByRole('link')).toHaveLength(2);
  expect(screen.queryByText('Labels')).toBeNull();
  expect(screen.queryByText('Priority')).toBeNull();
  expect(screen.getByText('Assignee')).toBeTruthy();
});

test('a bot known by its login says so', () => {
  render(<CandidateDetail detail={{ candidate: { ...candidate, source: 'linear' }, turn: turn({ external: { ...ext, authorVerified: true } }), before: [], after: [], commits: [] } as unknown as Detail} />);
  expect(screen.getAllByTitle('by its login').length).toBeGreaterThan(0);
});

test('a comment of a kind, an author kind and a source this release does not know shows each as stored, in a neutral badge', () => {
  render(<CandidateDetail detail={{ candidate: { ...candidate, source: 'jira' }, turn: turn({ external: { ...ext, source: 'jira', kind: 'mail_thread', authorKind: 'robot' } }), before: [], after: [], commits: [] } as unknown as Detail} />);
  expect(screen.getByText(/^mail_thread, /)).toBeTruthy();
  expect(screen.getByText('robot')).toBeTruthy();
  render(<SourceBadge source={'jira' as never} />);
  expect(screen.getAllByText('jira').at(-1)!.className).toMatch(/neutral|muted|sunken/);
});
