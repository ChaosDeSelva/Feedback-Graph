import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
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
        convs = [c, ...convs.filter((x) => x.id !== c.id)];
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

/** The conversation rows of the list (its other buttons, Delete ticked, left out). */
const rows = () => within(screen.getByRole('complementary', { name: 'conversations' })).getAllByRole('button').filter((b) => b.textContent !== 'Delete ticked');
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
  // The click's write is awaited inside act (the button awaited it first, so it has said Copied by then): no polling
  // for a label that turns back after 2 seconds, which a slow run could miss.
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: 'Copy' }));
    await writeText.mock.results[0]!.value;
  });
  expect(writeText).toHaveBeenCalledWith('Goal: add a confirm modal.\nRead first: src/ui/Modal.tsx');
  expect(within(card).getByRole('button', { name: 'Copied' })).toBeTruthy();
});

test('a prompt longer than its box can be reached and scrolled by keyboard', async () => {
  const { overflowAll, unreachableScrollers } = await import('./ui/scrollReach.ts');
  onTestFinished(overflowAll());
  location.hash = '#ask/c1';
  const { container } = render(<Chat />);
  const card = await screen.findByRole('region', { name: 'Prompt for your agent' });
  const prompt = card.querySelector('pre')!;
  await waitFor(() => expect(prompt.tabIndex).toBe(0));
  expect(unreachableScrollers(container).map((e) => e.outerHTML.slice(0, 80))).toEqual([]);
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
  // The clock is shown beside the live region, not in it: it ticks every second and would be read out each time.
  expect(answering.textContent).toBe('Answering with Codex…');
  expect(answering.parentElement!.textContent).toMatch(/Answering with Codex… 0:2\d/);
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
  const titles = () => rows().map((b) => b.querySelector('div')?.textContent);
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
  await waitFor(() => expect(rows()[0].textContent).toMatch(/Older chat/));
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

/** Answers matching requests with a server error instead of the fake's own answer. */
function failing(match: (url: string, method: string) => boolean, error = 'the store is down') {
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (match(url, init?.method ?? 'GET')) { calls.push({ url, method: init?.method ?? 'GET' }); return Response.json({ error }, { status: 500 }); }
    return inner(url, init);
  }));
}

test('a new conversation that cannot be created says why and keeps the question to send again', async () => {
  failing((url, method) => url === '/api/chats' && method === 'POST');
  render(<Chat />);
  await screen.findByText('Add a modal');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  const box = screen.getByRole('textbox', { name: 'question' });
  fireEvent.change(box, { target: { value: 'where would feature X go?' } });
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(await screen.findByText('the store is down')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'question' }) as HTMLTextAreaElement).value).toBe('where would feature X go?');
  expect(screen.getByRole('form', { name: 'new chat' })).toBeTruthy();
  expect(location.hash).not.toBe('#ask/c2');
});

test('a follow-up that fails says why, and the question stays in the box', async () => {
  failing((url) => url === '/api/chats/c1/messages');
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  const box = screen.getByRole('textbox', { name: 'question' });
  fireEvent.change(box, { target: { value: 'and the cart page?' } });
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(await screen.findByText('the store is down')).toBeTruthy();
  expect((box as HTMLTextAreaElement).value).toBe('and the cart page?');
});

test('a Retry the server refuses says why and leaves the failed answer in place', async () => {
  threads.c1 = { ...threads.c1, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'failed', answer: null, error: 'claude-cli: not signed in' }] };
  failing((url) => url.includes('/retry'), 'retry refused');
  location.hash = '#ask/c1';
  render(<Chat />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('retry refused')).toBeTruthy();
  expect(screen.getByText(/not signed in/)).toBeTruthy();
});

test('changing a conversation\'s model saves it, names the new model on the next answer, and a refused change says why', async () => {
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  fireEvent.change(screen.getByLabelText('provider'), { target: { value: 'local' } });
  await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ provider: 'local' }));
  await waitFor(() => expect((screen.getByLabelText('provider') as HTMLSelectElement).value).toBe('local'));
  const box = screen.getByRole('textbox', { name: 'question' });
  fireEvent.change(box, { target: { value: 'and the cart page?' } });
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(await screen.findByText(/Answering with the local model/)).toBeTruthy();
  failing((_, method) => method === 'PATCH', 'cannot change the model');
  fireEvent.change(screen.getByLabelText('provider'), { target: { value: '' } });
  expect(await screen.findByText('cannot change the model')).toBeTruthy();
});

test('an answer by a provider the page does not know is named by its id', async () => {
  threads.c1 = { ...threads.c1, pending: true, provider: null, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'answering', answer: null, provider: 'openai:gpt-5' }] };
  location.hash = '#ask/c1';
  render(<Chat />);
  expect(await screen.findByText(/Answering with openai:gpt-5/)).toBeTruthy();
});

test('a delete the server refuses says why and keeps the conversation', async () => {
  failing((_, method) => method === 'DELETE', 'delete refused');
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  fireEvent.click(screen.getByRole('button', { name: 'delete conversation' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete conversation' }));
  expect(await screen.findByText('delete refused')).toBeTruthy();
  expect(screen.getByText('2 modals')).toBeTruthy();
  expect(location.hash).toBe('#ask/c1');
});

test('following a link to another conversation while the page is open switches to it', async () => {
  convs = [conv('c1'), conv('c3', { title: 'Paginate members' })];
  threads.c3 = { ...conv('c3', { title: 'Paginate members' }), turns: answered('c3', 'how do I paginate members?') };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('I want to add a modal', { selector: 'p, div' });
  await act(async () => { location.hash = '#ask/c3'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  expect(await screen.findByText('how do I paginate members?', { selector: 'p, div' })).toBeTruthy();
  expect(screen.queryByText('I want to add a modal', { selector: 'p, div' })).toBeNull();
});

test('with no project selected the list points to Settings instead of offering conversations', async () => {
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/projects' ? Response.json([]) : inner(url, init))));
  render(<Chat />);
  expect(await screen.findByText('No projects selected')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('#settings');
});

test('a source with no page of its own is listed by title without a link', async () => {
  threads.c1.turns[1] = { ...threads.c1.turns[1], sources: [{ id: 'S1', kind: 'note' as never, ref: 'n1', title: 'a loose note' }] };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  const sources = screen.getByText(/Sources \(1\)/).closest('details')!;
  expect(within(sources).getByText('a loose note').tagName).toBe('SPAN');
  expect(within(sources).queryByRole('link')).toBeNull();
});

/** A promise and the function that settles it, for an answer a test releases when it chooses. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Holds back the answers to requests matching `match` until the test releases them. */
function holding(match: (url: string, method: string) => boolean) {
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  const held: { release: () => void }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!match(url, init?.method ?? 'GET')) return inner(url, init);
    const d = deferred<void>();
    held.push({ release: () => d.resolve() });
    await d.promise;
    return inner(url, init);
  }));
  return { release: async () => { await act(async () => { for (const h of held.splice(0)) h.release(); }); } };
}

test('conversations last written at the same moment keep a stable order, and an untitled one reads "New chat"', async () => {
  convs = [conv('c3', { title: '' }), conv('c1')];
  threads.c3 = { ...conv('c3', { title: '' }), turns: answered('c3', 'hello') };
  location.hash = '#ask/c3';
  render(<Chat />);
  const list = await screen.findByRole('region', { name: 'conversations list' });
  await waitFor(() => expect(within(list).getAllByRole('listitem').map((li) => li.textContent?.split('shop')[0])).toEqual(['New chat', 'Add a modal']));
  expect(await screen.findByRole('heading', { name: 'New chat' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'delete conversation' }));
  expect(await screen.findByRole('alertdialog', { name: 'Delete the conversation "New chat"?' })).toBeTruthy();
});

test('with no conversations yet a new chat is open, and nothing else is fetched', async () => {
  convs = [];
  render(<Chat />);
  expect(await screen.findByText('No conversations yet')).toBeTruthy();
  expect(await screen.findByRole('form', { name: 'new chat' })).toBeTruthy();
  expect(calls.some((c) => c.url.startsWith('/api/chats/'))).toBe(false);
});

test('Ask opens on a new chat with its model line, not on the newest old conversation', async () => {
  convs = [conv('c1', { title: 'Two weeks old', updatedAt: '2026-10-10T12:00:00Z' })];
  render(<Chat />);
  const form = await screen.findByRole('form', { name: 'new chat' });
  expect(within(form).getByLabelText('chat provider')).toBeTruthy();
  expect(within(form).getByText(/runs on your own Claude or Codex subscription/)).toBeTruthy();
  expect(gets('c1')).toBe(0);
  fireEvent.change(screen.getByRole('textbox', { name: 'question' }), { target: { value: 'a new topic' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/chats')).toHaveLength(1));
  expect(calls.some((c) => c.url === '/api/chats/c1/messages')).toBe(false);
});

test('ticked conversations are deleted together after one confirm', async () => {
  convs = [conv('c1', { title: 'stress-1' }), conv('c3', { title: 'probe-2' }), conv('c4', { title: 'keep me' })];
  render(<Chat />);
  await screen.findByText('keep me');
  fireEvent.click(screen.getByRole('checkbox', { name: 'tick stress-1' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'tick probe-2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete ticked' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('stress-1')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 conversations' }));
  await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url).sort()).toEqual(['/api/chats/c1', '/api/chats/c3']));
  await waitFor(() => expect(screen.queryByText('stress-1')).toBeNull());
  expect(screen.getByText('keep me')).toBeTruthy();
});

test('a list that answers after the filter changed is dropped for the newer one', async () => {
  const lists = holding((url) => url === '/api/chats');
  render(<Chat />);
  await screen.findByRole('option', { name: 'blog' });
  fireEvent.change(screen.getByLabelText('project'), { target: { value: 'blog' } });
  expect(await screen.findByText('No conversations yet')).toBeTruthy();
  await lists.release();
  expect(screen.queryByText('Add a modal')).toBeNull();
});

test('a link with no project says so; one with no question opens a new chat on that project and model', async () => {
  location.hash = '#ask/new?q=hi';
  render(<Chat />);
  expect((await screen.findAllByText('That link names no project to ask about.')).length).toBeGreaterThan(0);
  expect(location.hash).toBe('#ask');
  cleanup();
  location.hash = '#ask/new?project=blog&provider=codex';
  render(<Chat />);
  const form = await screen.findByRole('form', { name: 'new chat' });
  await waitFor(() => expect((within(form).getByLabelText('chat project') as HTMLSelectElement).value).toBe('blog'));
  expect((within(form).getByLabelText('chat provider') as HTMLSelectElement).value).toBe('codex');
  fireEvent.change(within(form).getByLabelText('chat provider'), { target: { value: '' } });
  expect((within(form).getByLabelText('chat provider') as HTMLSelectElement).value).toBe('');
  cleanup();
  location.hash = '#ask/new?project=blog';
  render(<Chat />);
  expect((within(await screen.findByRole('form', { name: 'new chat' })).getByLabelText('chat provider') as HTMLSelectElement).value).toBe('');
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});

test('a new-chat link followed while the page is open starts that conversation', async () => {
  render(<Chat />);
  await screen.findByText('Add a modal');
  await act(async () => { location.hash = `#ask/new?project=blog&q=${encodeURIComponent('any routes?')}`; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/chats').map((c) => c.body)).toEqual([{ project: 'blog', title: 'any routes?' }]));
});

test('Ctrl+Enter sends too; an empty question, or one while the last is still sending, sends nothing', async () => {
  const sends = holding((url, method) => method === 'POST' && url.endsWith('/messages'));
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  const box = screen.getByRole('textbox', { name: 'question' });
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  fireEvent.change(box, { target: { value: 'and the tests?' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(calls.filter((c) => c.url.endsWith('/messages'))).toEqual([]);
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeTruthy());
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  await sends.release();
  await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/messages')).map((c) => c.body)).toEqual([{ text: 'and the tests?' }]));
});

test('a poll that answers after another conversation was opened leaves the open one alone', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  threads.c1 = { ...threads.c1, pending: true, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'pending', answer: null }] };
  convs = [conv('c1'), conv('c3', { title: 'Paginate members' })];
  threads.c3 = { ...conv('c3', { title: 'Paginate members' }), turns: answered('c3', 'how do I paginate members?') };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText(/Answering with Claude/);
  const polls = holding((url) => url === '/api/chats/c1');
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  fireEvent.click(screen.getByText('Paginate members'));
  expect(await screen.findByText('how do I paginate members?', { selector: 'p, div' })).toBeTruthy();
  threads.c1 = { ...threads.c1, pending: false, turns: answered('c1', 'I want to add a modal') };
  await polls.release();
  expect(screen.getByText('how do I paginate members?', { selector: 'p, div' })).toBeTruthy();
  expect(screen.queryByText('I want to add a modal', { selector: 'p, div' })).toBeNull();
});

test('a failed poll that comes back after another conversation was opened neither retries nor reports', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  threads.c1 = { ...threads.c1, pending: true, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'pending', answer: null }] };
  convs = [conv('c1'), conv('c3', { title: 'Paginate members' })];
  threads.c3 = { ...conv('c3', { title: 'Paginate members' }), turns: answered('c3', 'how do I paginate members?') };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText(/Answering with Claude/);
  const polls = holding((url) => url === '/api/chats/c1');
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  fireEvent.click(screen.getByText('Paginate members'));
  await screen.findByText('how do I paginate members?', { selector: 'p, div' });
  delete threads.c1;
  await polls.release();
  const tries = gets('c1');
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(gets('c1')).toBe(tries);
  expect(screen.queryByText(/stopped checking/i)).toBeNull();
});

test('a model change that lands after another conversation was opened, or before the list loaded, changes only its own conversation', async () => {
  convs = [conv('c1'), conv('c3', { title: 'Paginate members' })];
  threads.c3 = { ...conv('c3', { title: 'Paginate members' }), turns: answered('c3', 'how do I paginate members?') };
  const lists = holding((url) => url === '/api/chats');
  // The list is held back too, so the change lands before the page has one.
  const patches = holding((_, method) => method === 'PATCH');
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  fireEvent.change(screen.getByLabelText('provider'), { target: { value: 'codex' } });
  await act(async () => { location.hash = '#ask/c3'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  await screen.findByText('how do I paginate members?', { selector: 'p, div' });
  await patches.release();
  expect((screen.getByLabelText('provider') as HTMLSelectElement).value).toBe('claude');
  await lists.release();
  const list = screen.getByRole('region', { name: 'conversations list' });
  expect(await within(list).findByText('Paginate members')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('provider'), { target: { value: 'local' } });
  await patches.release();
  await waitFor(() => expect((screen.getByLabelText('provider') as HTMLSelectElement).value).toBe('local'));
  expect(within(list).getByText('Add a modal')).toBeTruthy();
});

test('a conversation deleted before the list loaded is gone once it does', async () => {
  const lists = holding((url) => url === '/api/chats');
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  fireEvent.click(screen.getByRole('button', { name: 'delete conversation' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete conversation' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  await lists.release();
  expect(await screen.findByText('No conversations yet')).toBeTruthy();
});

test('one question ahead says so in the singular; a failure with no reason says it is unknown', async () => {
  threads.c1 = { ...threads.c1, pending: true, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'pending', answer: null, provider: null, queueAhead: 1 }] };
  location.hash = '#ask/c1';
  render(<Chat />);
  expect(await screen.findByText(/1 question ahead of this one/)).toBeTruthy();
  cleanup();
  threads.c1 = { ...threads.c1, pending: false, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'failed', answer: null, provider: null }] };
  render(<Chat />);
  expect(await screen.findByText('Claude could not answer: unknown error')).toBeTruthy();
});

test('an answer with no model or pack named shows no byline; an example without lines and a web document are linked as they are', async () => {
  const a = threads.c1.turns[1];
  threads.c1.turns[1] = {
    ...a, provider: null, pack: null,
    answer: { ...a.answer!, answer: 'See [S1] and [S7].', examples: [{ path: 'src/ui/Modal.tsx', lines: null as never, why: 'the base modal', usages: [] }] },
    sources: [{ id: 'S1', kind: 'doc', ref: 'https://docs.example.com/modals', title: 'Modal guide' }],
  };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText(/See/);
  expect(screen.queryByText(/answered by|context pack/)).toBeNull();
  expect(within(screen.getByRole('list', { name: 'examples' })).getByRole('link').textContent).toBe('src/ui/Modal.tsx');
  const doc = within(screen.getByText(/Sources \(1\)/).closest('details')!).getByRole('link', { name: 'Modal guide' });
  expect(doc.getAttribute('href')).toBe('https://docs.example.com/modals');
  expect(doc.getAttribute('target')).toBe('_blank');
  // A citation the answer has no source for stays plain text.
  expect(screen.getByText(/and \[S7\]\./)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'S7' })).toBeNull();
});

test('a source of a kind this release does not know is listed with its kind as stored, in a neutral badge', async () => {
  threads.c1.turns[1] = { ...threads.c1.turns[1], sources: [{ id: 'S1', kind: 'video' as never, ref: 'clip.mp4', title: 'A recorded demo' }] };
  location.hash = '#ask/c1';
  render(<Chat />);
  await screen.findByText('2 modals');
  const sources = screen.getByText(/Sources \(1\)/).closest('details')!;
  expect(within(sources).getByText('A recorded demo')).toBeTruthy();
  expect(within(sources).getByText('video')).toBeTruthy();
});

test('a keyboard Retry of a failed answer leaves focus in the page, not on its body', async () => {
  threads.c1 = { ...threads.c1, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'failed', answer: null, error: 'claude-cli: not signed in' }] };
  location.hash = '#ask/c1';
  render(<main tabIndex={-1}><Chat /></main>);
  (await screen.findByRole('button', { name: 'Retry' })).focus();
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByText(/Answering with Claude/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('main'));
});

test('Retry and delete say what they are doing while their request is in flight, and take no second press', async () => {
  threads.c1 = { ...threads.c1, turns: [threads.c1.turns[0], { ...threads.c1.turns[1], status: 'failed', answer: null, error: 'claude-cli: not signed in' }] };
  location.hash = '#ask/c1';
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === 'POST' || init?.method === 'DELETE') await gate; return inner(url, init); }));
  render(<Chat />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  const retrying = await screen.findByRole('button', { name: 'Retrying…' });
  expect(screen.getByRole('button', { name: 'delete conversation' }).getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(retrying);
  release();
  expect(await screen.findByText(/Answering with Claude/)).toBeTruthy();
  expect(calls.filter((c) => c.url === '/api/chats/c1/turns/c1-a/retry')).toHaveLength(1);
});

test('deleting a conversation says so on its button while the request is in flight', async () => {
  location.hash = '#ask/c1';
  const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === 'DELETE') await gate; return inner(url, init); }));
  render(<Chat />);
  fireEvent.click(await screen.findByRole('button', { name: 'delete conversation' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete conversation' }));
  const deleting = await screen.findByRole('button', { name: 'deleting conversation' });
  expect(deleting.getAttribute('aria-disabled')).toBe('true');
  release();
  await waitFor(() => expect(location.hash).toBe('#ask'));
});
