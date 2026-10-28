import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Chat } from './Chat.tsx';
import type { ChatConversation, ChatThread, ChatTurn } from '@fb/core/chat';

const T0 = '2026-10-24T10:00:00Z';
const conv = (id: string, o: Partial<ChatConversation> = {}): ChatConversation => ({
  id, projectKey: 'shop', title: 'Add a modal', provider: 'claude', createdAt: T0, updatedAt: T0, pending: false, ...o,
});
const turn = (o: Partial<ChatTurn> & Pick<ChatTurn, 'id' | 'conversationId' | 'seq' | 'role'>): ChatTurn => ({
  text: '', status: 'done', error: null, answer: null, sources: [], provider: null, createdAt: T0, startedAt: null, finishedAt: null, ...o,
});
const answered = (cid: string, question: string): ChatTurn[] => [
  turn({ id: `${cid}-u`, conversationId: cid, seq: 1, role: 'user', text: question }),
  turn({
    id: `${cid}-a`, conversationId: cid, seq: 2, role: 'assistant', provider: 'claude-cli', finishedAt: T0,
    answer: {
      answer: 'You have **2 modals** doing this [S1].',
      examples: [{ path: 'src/ui/Modal.tsx', lines: '10-42', why: 'the base modal every dialog wraps', usages: ['src/pages/Cart.tsx'] }],
      prompt: 'Goal: add a confirm modal.\nRead first: src/ui/Modal.tsx',
    },
    sources: [{ id: 'S1', kind: 'code', ref: 'src/ui/Modal.tsx:10-42', title: 'Modal component' }, { id: 'S2', kind: 'lesson', ref: 'lesson:7', title: 'Dialogs trap focus' }],
  }),
];

let calls: { url: string; method: string; body?: unknown }[];
let convs: ChatConversation[];
let threads: Record<string, ChatThread>;
let writeText: ReturnType<typeof vi.fn>;
/** What GET /api/chats/c2 answers next, so a test can move a pending turn on. */
let c2Next: ((t: ChatThread) => ChatThread) | null;

beforeEach(() => {
  calls = [];
  c2Next = null;
  convs = [conv('c1')];
  threads = { c1: { ...conv('c1'), turns: answered('c1', 'I want to add a modal') } };
  writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/projects') return Response.json([
      { key: 'blog', repoPath: '/x/blog', sessions: 0, feedback: 0, lessons: 0, facts: 0, lastScan: null, pinned: false },
      { key: 'shop', repoPath: '/x/shop', sessions: 3, feedback: 2, lessons: 1, facts: 4, lastScan: null, pinned: true },
    ]);
    if (url.startsWith('/api/chats?') || url === '/api/chats') {
      if (method === 'POST') {
        const c = conv('c2', { projectKey: body.project, provider: body.provider ?? null, title: body.title ?? '' });
        convs = [c, ...convs];
        threads.c2 = { ...c, turns: [] };
        return Response.json(c, { status: 201 });
      }
      const project = new URL(url, 'http://x').searchParams.get('project');
      return Response.json(convs.filter((c) => !project || c.projectKey === project));
    }
    const m = url.match(/^\/api\/chats\/([^/]+)(\/.*)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const t = threads[id];
      if (!t) return Response.json({ error: 'not found' }, { status: 404 });
      if (m[2] === '/messages') {
        const at = new Date(Date.now() - 23_000).toISOString();
        // As the server does: the conversation's last message is now, though this fake keeps listing it where it was.
        convs = convs.map((c) => (c.id === id ? { ...c, updatedAt: new Date().toISOString(), pending: true } : c));
        threads[id] = { ...t, pending: true, title: t.title || body.text, turns: [...t.turns,
          turn({ id: `${id}-u${t.turns.length}`, conversationId: id, seq: t.turns.length + 1, role: 'user', text: body.text, createdAt: at }),
          turn({ id: `${id}-a${t.turns.length}`, conversationId: id, seq: t.turns.length + 2, role: 'assistant', status: 'pending', createdAt: at }),
        ] };
        return Response.json(threads[id], { status: 202 });
      }
      if (m[2]?.includes('/retry')) {
        threads[id] = { ...t, pending: true, turns: t.turns.map((x) => (x.status === 'failed' ? { ...x, status: 'pending' as const, error: null } : x)) };
        return Response.json(threads[id], { status: 202 });
      }
      if (method === 'DELETE') {
        convs = convs.filter((c) => c.id !== id);
        delete threads[id];
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        threads[id] = { ...t, ...body };
        return Response.json(threads[id]);
      }
      if (id === 'c2' && c2Next) threads.c2 = c2Next(threads.c2);
      return Response.json(threads[id]);
    }
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); location.hash = ''; });

const gets = (id: string) => calls.filter((c) => c.method === 'GET' && c.url === `/api/chats/${id}`).length;

test('opens the linked conversation: the answer, its examples linked to their module panels, sources folded away', async () => {
  location.hash = '#ask/c1';
  render(<Chat />);
  expect(await screen.findByText('I want to add a modal', { selector: 'p, div' })).toBeTruthy();
  expect(screen.getByText('2 modals')).toBeTruthy();
  const examples = screen.getByRole('list', { name: 'examples' });
  const link = within(examples).getByRole('link', { name: 'src/ui/Modal.tsx:10-42' });
  expect(link.getAttribute('href')).toBe('#projects/shop/src%2Fui%2FModal.tsx');
  expect(within(examples).getByText('the base modal every dialog wraps')).toBeTruthy();
  expect(within(examples).getByRole('link', { name: 'src/pages/Cart.tsx' }).getAttribute('href')).toBe('#projects/shop/src%2Fpages%2FCart.tsx');
  const sources = screen.getByText(/Sources \(2\)/).closest('details')!;
  expect(sources.open).toBe(false);
  expect(within(sources).getByText('Dialogs trap focus')).toBeTruthy();
  expect(within(sources).getByText('lesson')).toBeTruthy();
  expect(within(sources).getByText('S1')).toBeTruthy();
});

test('a citation [S1] and each Sources row link to what they cite: code to its module panel, a lesson to the lesson, a document to its project', async () => {
  threads.c1.turns[1] = {
    ...threads.c1.turns[1],
    sources: [
      { id: 'S1', kind: 'code', ref: 'src/ui/Modal.tsx:10-42', title: 'Modal component' },
      { id: 'S2', kind: 'lesson', ref: 'lesson:7', title: 'Dialogs trap focus' },
      { id: 'S3', kind: 'doc', ref: 'spec.md', title: 'The checkout spec' },
      { id: 'S4', kind: 'fact', ref: 'src/db.ts:3-9', title: 'Scope every query' },
    ],
  };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  expect(screen.getByRole('link', { name: '[S1]' }).getAttribute('href')).toBe('#projects/shop/src%2Fui%2FModal.tsx');
  const sources = screen.getByText(/Sources \(4\)/).closest('details')!;
  const href = (name: string) => within(sources).getByRole('link', { name: new RegExp(name) }).getAttribute('href');
  expect(href('Modal component')).toBe('#projects/shop/src%2Fui%2FModal.tsx');
  expect(href('Dialogs trap focus')).toBe('#lessons/lesson%3A7');
  expect(href('The checkout spec')).toBe('#projects/shop');
  expect(href('Scope every query')).toBe('#projects/shop/src%2Fdb.ts');
});

test('the agent prompt is copied with its Copy button', async () => {
  location.hash = '#ask/c1';
  render(<Chat />);
  const card = await screen.findByRole('region', { name: 'Prompt for your agent' });
  expect(card.textContent).toContain('Goal: add a confirm modal.');
  await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Copy' })); });
  expect(writeText).toHaveBeenCalledWith('Goal: add a confirm modal.\nRead first: src/ui/Modal.tsx');
  expect(within(card).getByRole('button', { name: 'Copied' })).toBeTruthy();
});

test('New chat: picks a project and a provider, sends with Cmd+Enter, then polls only while the answer is pending', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<Chat />);
  await screen.findByText('Add a modal');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  const form = screen.getByRole('form', { name: 'new chat' });
  expect((within(form).getByLabelText('chat project') as HTMLSelectElement).value).toBe('shop'); // pinned first
  fireEvent.change(within(form).getByLabelText('chat project'), { target: { value: 'blog' } });
  fireEvent.change(within(form).getByLabelText('chat provider'), { target: { value: 'codex' } });
  const box = screen.getByRole('textbox', { name: 'question' });
  fireEvent.change(box, { target: { value: 'where would feature X go?' } });
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  await waitFor(() => expect(calls.find((c) => c.url.endsWith('/messages'))?.body).toEqual({ text: 'where would feature X go?' }));
  expect(calls.find((c) => c.method === 'POST' && c.url === '/api/chats')?.body).toEqual({ project: 'blog', provider: 'codex', title: 'where would feature X go?' });
  const answering = (await screen.findByText(/Answering with Codex/)).closest('[role="status"]')!;
  expect(answering.textContent).toMatch(/Answering with Codex… 0:2\d/);
  expect(location.hash).toBe('#ask/c2');

  c2Next = (t) => ({ ...t, pending: false, turns: [...answered('c2', 'where would feature X go?').slice(0, 1).map((u) => ({ ...u, id: 'c2-u0' })), { ...answered('c2', '')[1], id: 'c2-a0', provider: 'codex-cli' }] });
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(await screen.findByText('2 modals')).toBeTruthy();
  const polled = gets('c2');
  expect(polled).toBeGreaterThan(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(gets('c2')).toBe(polled);
});

test('a question waiting behind others for its model says how many are ahead of it', async () => {
  threads.c1 = { ...threads.c1, pending: true, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'pending', answer: null, provider: null, queueAhead: 2 }] };
  location.hash = '#ask/c1';
  render(<Chat />);
  const status = (await screen.findByText(/Waiting for Claude: 2 questions ahead of this one/)).closest('[role="status"]')!;
  expect(status).toBeTruthy();
});

test('a failed answer shows its error and Retry puts it back in the queue', async () => {
  threads.c1 = { ...threads.c1, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'failed', answer: null, error: 'claude-cli: not signed in' }] };
  location.hash = '#ask/c1';
  render(<Chat />);
  expect(await screen.findByText(/claude-cli: not signed in/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/chats/c1/turns/c1-a/retry')).toBe(true));
  expect(await screen.findByText(/Answering with Claude/)).toBeTruthy();
  expect(screen.queryByText(/not signed in/)).toBeNull();
});

test('deleting a conversation asks first, then removes it from the list', async () => {
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  fireEvent.click(screen.getByRole('button', { name: 'delete conversation' }));
  const ask = await screen.findByRole('alertdialog', { name: 'Delete the conversation "Add a modal"?' });
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  fireEvent.click(within(ask).getByRole('button', { name: 'Delete conversation' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/chats/c1')).toBe(true));
  await waitFor(() => expect(screen.queryByText('Add a modal')).toBeNull());
});

test('#ask/new?project=…&q=… starts a conversation on that project and asks the question', async () => {
  location.hash = `#ask/new?project=shop&q=${encodeURIComponent('I want to add a modal')}`;
  render(<Chat />);
  await waitFor(() => expect(calls.find((c) => c.url === '/api/chats/c2/messages')?.body).toEqual({ text: 'I want to add a modal' }));
  expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/chats').map((c) => c.body)).toEqual([{ project: 'shop', title: 'I want to add a modal' }]);
  expect(location.hash).toBe('#ask/c2');
  expect(await screen.findByText(/Answering with the default model/)).toBeTruthy();
});

test('the project filter rescopes the list, and an empty list says what to ask', async () => {
  render(<Chat />);
  await screen.findByText('Add a modal');
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'blog' } });
  await waitFor(() => expect(calls.some((c) => c.url === '/api/chats?project=blog')).toBe(true));
  expect(await screen.findByText(/I want to add a modal' or 'where would feature X go\?'/)).toBeTruthy();
});

test('a conversation deleted elsewhere while an answer is pending stops the polling after a few tries and says so', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<Chat />);
  await screen.findByText('Add a modal');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'question' }), { target: { value: 'q?' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'question' }), { key: 'Enter', metaKey: true });
  await screen.findByText(/Answering with/);
  delete threads.c2;
  for (let i = 0; i < 15; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
  const tries = gets('c2');
  expect(await screen.findByText(/stopped checking/i)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(gets('c2')).toBe(tries);
});

test('an answer says how big the context pack it was answered from was', async () => {
  threads.c1.turns[1] = { ...threads.c1.turns[1], pack: { chars: 12_345, sources: 2 } };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  expect(screen.getByText(/answered from a context pack of 12,345 characters, 2 sources/)).toBeTruthy();
});

test('an answer from an API without pack sizes says nothing about it', async () => {
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  expect(screen.queryByText(/context pack of/)).toBeNull();
});

test('a miss is cited by the file it happened in, linked to that file; an old one by its id, not linked', async () => {
  threads.c1.turns[1] = {
    ...threads.c1.turns[1],
    sources: [
      { id: 'S1', kind: 'miss', ref: 'src/ui/Dialog.tsx', title: 'built a second modal from scratch' },
      { id: 'S2', kind: 'miss', ref: 'miss:9', title: 'forgot the focus trap' },
    ],
  };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  expect(screen.getByRole('link', { name: '[S1]' }).getAttribute('href')).toBe('#projects/shop/src%2Fui%2FDialog.tsx');
  const sources = screen.getByText(/Sources \(2\)/).closest('details')!;
  expect(within(sources).getByRole('link', { name: /built a second modal/ }).getAttribute('href')).toBe('#projects/shop/src%2Fui%2FDialog.tsx');
  expect(within(sources).getByText('src/ui/Dialog.tsx')).toBeTruthy();
  expect(within(sources).getByRole('link', { name: /forgot the focus trap/ }).getAttribute('href')).toBe('#inbox/9');
});

test('the conversation list re-sorts when a chat gets a new message: the one you asked in moves to the top', async () => {
  convs = [conv('c1', { title: 'Newest chat', updatedAt: '2026-10-24T12:00:00Z' }), conv('c3', { title: 'Older chat', updatedAt: '2026-10-20T10:00:00Z' })];
  threads.c3 = { ...convs[1], turns: answered('c3', 'older question') };
  location.hash = '#ask/c3';
  render(<Chat />);
  await screen.findByText('older question', { selector: 'p, div' });
  const titles = () => within(screen.getByRole('complementary', { name: 'conversations' })).getAllByRole('button').map((b) => b.querySelector('div')?.textContent);
  expect(titles()).toEqual(['Newest chat', 'Older chat']);
  fireEvent.change(screen.getByRole('textbox', { name: 'question' }), { target: { value: 'and the footer?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  // The fake server lists them in their old order: the page sorts by each conversation's last message itself.
  await waitFor(() => expect(titles()).toEqual(['Older chat', 'Newest chat']));
});

test('a conversation answering in the background is checked again until it is done, then moves up', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  convs = [conv('c1', { title: 'Newest chat', updatedAt: '2026-10-24T12:00:00Z' }), conv('c3', { title: 'Older chat', updatedAt: '2026-10-20T10:00:00Z', pending: true })];
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  const lists = () => calls.filter((c) => c.method === 'GET' && (c.url === '/api/chats' || c.url.startsWith('/api/chats?'))).length;
  const before = lists();
  convs = [conv('c3', { title: 'Older chat', updatedAt: '2026-10-24T13:00:00Z', pending: false }), convs[0]];
  await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
  expect(lists()).toBeGreaterThan(before);
  const list = screen.getByRole('complementary', { name: 'conversations' });
  await waitFor(() => expect(within(list).getAllByRole('button')[0].textContent).toMatch(/Older chat/));
  expect(within(list).queryByText('answering')).toBeNull();
  // Nothing pending any more: the list is not asked for again.
  const after = lists();
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(lists()).toBe(after);
});

test('#ask/new?…&provider=codex starts the conversation on the model the Dashboard picked', async () => {
  location.hash = `#ask/new?project=shop&q=${encodeURIComponent('where do routes go?')}&provider=codex`;
  render(<Chat />);
  await waitFor(() => expect(calls.find((c) => c.url === '/api/chats/c2/messages')?.body).toEqual({ text: 'where do routes go?' }));
  expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/chats').map((c) => c.body)).toEqual([{ project: 'shop', provider: 'codex', title: 'where do routes go?' }]);
  // An unknown provider in a link is ignored: the default model answers.
  cleanup();
  calls = [];
  location.hash = `#ask/new?project=shop&q=hi&provider=nope`;
  render(<Chat />);
  await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/chats').map((c) => c.body)).toEqual([{ project: 'shop', title: 'hi' }]));
});
