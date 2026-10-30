import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Lessons } from './Lessons.tsx';

const lesson = (id: string, title: string) => ({
  id, projectKey: 'demo', title, rule: `${title} rule`, appliesWhen: 'search work', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: 'context_available_ignored', missId: 'm', createdAt: '2026-10-01T10:00:00Z', decidedAt: null,
});
const detail = (id: string, title: string) => ({
  lesson: lesson(id, title),
  miss: { id: 'm', missed: 'filtered on the client', cause: 'context_available_ignored', causeExplanation: 'CLAUDE.md said server' },
  feedback: { id: 'f', text: "this isn't good enough", status: 'approved', sessionId: 's1', ts: '2026-10-01T10:00:00Z' },
  contextItems: [{ kind: 'claude_md', ref: 'CLAUDE.md', excerpt: 'filter on the server', why: 'stated rule', wasAvailable: true }],
  fixCommits: [{ sha: 'abc1234def', ts: 't', subject: 'move filter to API' }],
  supersedes: [],
});

let patches: { url: string; body: unknown }[];
beforeEach(() => {
  location.hash = '';
  patches = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { patches.push({ url, body: JSON.parse(init.body as string) }); return new Response(null, { status: 204 }); }
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search'), lesson('l2', 'Auth checks')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    if (url === '/api/lessons/l2') return Response.json(detail('l2', 'Auth checks'));
    if (url.startsWith('/api/activity?target=l1')) return Response.json([{ id: 'a', ts: '2026-10-22T20:00:00Z', kind: 'postmortem_done', actor: 'claude-cli', projectKey: 'demo', subject: 'missed: filtered on the client', why: 'the CLAUDE.md rule was never read', details: {}, targets: [] }]);
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('shows the evidence chain for the selected lesson', async () => {
  render(<Lessons />);
  expect(await screen.findByText('filtered on the client')).toBeTruthy();
  expect(screen.getByText(/isn't good enough/)).toBeTruthy();
  expect(screen.getByText('filter on the server')).toBeTruthy();
  expect(screen.getByText(/was available/i)).toBeTruthy();
  expect(screen.getByText(/move filter to API/)).toBeTruthy();
});

test('a lesson from a GitHub review names the reviewer, not you, and shows the review verdict neutrally', async () => {
  const ext = { source: 'github', author: 'octo-reviewer', url: 'https://github.com/acme/shop/pull/12#discussion_r1', reviewState: 'APPROVED' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search')]);
    if (url === '/api/lessons/l1') { const d = detail('l1', 'Server search'); return Response.json({ ...d, feedback: { ...d.feedback, external: ext } }); }
    return Response.json([]);
  }));
  render(<Lessons />);
  expect(await screen.findByText(/octo-reviewer said/i)).toBeTruthy();
  expect(screen.queryByText(/^you said$/i)).toBeNull();
  const verdict = screen.getByText('review: approved');
  expect(verdict.className).not.toMatch(/\bok\b|text-ok/);
  expect(screen.getByRole('link', { name: /on GitHub/i }).getAttribute('href')).toBe(ext.url);
});

test('approve sends edited fields with the status', async () => {
  render(<Lessons />);
  const rule = (await screen.findByLabelText('rule')) as HTMLTextAreaElement;
  await waitFor(() => expect(rule.value).toBe('Server search rule'));
  fireEvent.change(rule, { target: { value: 'Always filter on the server' } });
  fireEvent.change(screen.getByLabelText('scope'), { target: { value: 'global' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { status: 'approved', rule: 'Always filter on the server', scope: 'global' } }]));
  expect(await screen.findByText('Auth checks', { selector: 'h2' })).toBeTruthy();
});

test('reject sends only the status', async () => {
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { status: 'rejected' } }]));
});

test('lesson history shows how the lesson was produced', async () => {
  render(<Lessons />);
  expect(await screen.findByText('the CLAUDE.md rule was never read')).toBeTruthy();
  expect(screen.getByText(/claude-cli/)).toBeTruthy();
});

test('revoking an approved lesson asks first, naming the lesson, and Cancel keeps it', async () => {
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'approved' }));
  fireEvent.click(await screen.findByRole('button', { name: /^revoke$/i }));
  const ask = await screen.findByRole('alertdialog', { name: /revoke this lesson/i });
  expect(ask.textContent).toContain('Server search');
  expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(patches).toEqual([]);
});

test('an approved lesson can be revoked, so agents stop getting it', async () => {
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'approved' }));
  fireEvent.click(await screen.findByRole('button', { name: /^revoke$/i }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke lesson' }));
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { status: 'revoked' } }]));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
});

test('a rejected lesson can be put back up for review', async () => {
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'rejected' }));
  fireEvent.click(await screen.findByRole('button', { name: /back to proposed/i }));
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { status: 'proposed' } }]));
});

test('the server\'s reason is shown when a change is refused', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Response.json({ error: 'this lesson has no known project, so it cannot be narrowed' }, { status: 409 });
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    return Response.json([]);
  }));
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/cannot be narrowed/)).toBeTruthy();
});

test('a slow answer for the previous lesson never replaces the one you moved to', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search'), lesson('l2', 'Auth checks')]);
    if (url === '/api/lessons/l1') { await new Promise((r) => setTimeout(r, 120)); return Response.json(detail('l1', 'Server search')); }
    if (url === '/api/lessons/l2') return Response.json(detail('l2', 'Auth checks'));
    return Response.json([]);
  }));
  render(<Lessons />);
  fireEvent.click(await screen.findByText('Auth checks'));
  await waitFor(() => expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Auth checks'));
  await new Promise((r) => setTimeout(r, 160));
  expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Auth checks');
});

test('a #lessons/<id> link opens that lesson, in the tab of its status', async () => {
  location.hash = '#lessons/l2';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?status=approved')) return Response.json([{ ...lesson('l1', 'Server search'), status: 'approved' }, { ...lesson('l2', 'Auth checks'), status: 'approved' }]);
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l9', 'Something proposed')]);
    if (url === '/api/lessons/l9') return Response.json(detail('l9', 'Something proposed'));
    if (url === '/api/lessons/l1') return Response.json({ ...detail('l1', 'Server search'), lesson: { ...lesson('l1', 'Server search'), status: 'approved' } });
    if (url === '/api/lessons/l2') return Response.json({ ...detail('l2', 'Auth checks'), lesson: { ...lesson('l2', 'Auth checks'), status: 'approved' } });
    return Response.json([]);
  }));
  try {
    render(<Lessons />);
    expect(await screen.findByRole('heading', { name: 'Auth checks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'approved' }).getAttribute('aria-pressed')).toBe('true');
  } finally {
    location.hash = '';
  }
});

test('moving to another lesson or tab with unsaved edits asks first in a dialog, and keeps them if you stay', async () => {
  render(<Lessons />);
  const rule = (await screen.findByLabelText('rule')) as HTMLTextAreaElement;
  await waitFor(() => expect(rule.value).toBe('Server search rule'));
  fireEvent.change(rule, { target: { value: 'Always filter on the server' } });
  const stay = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  };
  fireEvent.click(screen.getByText('Auth checks'));
  expect((await screen.findByRole('alertdialog')).textContent).toMatch(/not saved/i);
  await stay();
  expect((screen.getByLabelText('rule') as HTMLTextAreaElement).value).toBe('Always filter on the server');
  fireEvent.click(screen.getByRole('button', { name: 'approved' }));
  await stay();
  expect(screen.getByRole('button', { name: 'proposed' }).getAttribute('aria-pressed')).toBe('true');
  expect((screen.getByLabelText('rule') as HTMLTextAreaElement).value).toBe('Always filter on the server');

  fireEvent.click(screen.getByText('Auth checks'));
  fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
  await waitFor(() => expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Auth checks'));
  // No edits now: moving on does not ask.
  fireEvent.click(screen.getByText('Server search'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await waitFor(() => expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('Server search'));
});

test('an error goes away once the next change succeeds', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (fail) { fail = false; return Response.json({ error: 'graph unreachable' }, { status: 503 }); }
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search'), lesson('l2', 'Auth checks')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    if (url === '/api/lessons/l2') return Response.json(detail('l2', 'Auth checks'));
    return Response.json([]);
  }));
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
  expect((await screen.findAllByText(/graph unreachable/)).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(screen.queryByText(/graph unreachable/)).toBeNull());
});

test('a lesson an agent approved with the operator token says so, in the list and the detail', async () => {
  const byAgent = { ...lesson('l1', 'Server search'), status: 'approved', decidedBy: 'operator:codex' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?')) return Response.json([byAgent, { ...lesson('l2', 'Auth checks'), status: 'approved', decidedBy: 'you' }]);
    if (url === '/api/lessons/l1') return Response.json({ ...detail('l1', 'Server search'), lesson: byAgent });
    return Response.json([]);
  }));
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  const badges = screen.getAllByText('approved by agent');
  expect(badges).toHaveLength(2);
  expect(badges[0].closest('[title]')?.getAttribute('title')).toContain('operator:codex');
});

test("what the lesson check found shows as chips in the list and, with the reasons, on the lesson; the lesson's paths are shown", async () => {
  const checks = [
    { name: 'wrong-session', why: 'the matched session invite did other work; redone from the comment alone' },
    { name: 'meta-lesson', why: 'about how to treat feedback, not about the work' },
  ];
  const flagged = { ...lesson('l1', 'Server search'), checks, paths: ['api/search.ts'] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?')) return Response.json([flagged, { ...lesson('l2', 'Auth checks'), checks: [] }]);
    if (url === '/api/lessons/l1') return Response.json({ ...detail('l1', 'Server search'), lesson: flagged });
    return Response.json([]);
  }));
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  const list = screen.getByRole('complementary', { name: 'lessons' });
  // The chips, not the filter menus that name every check.
  expect(within(list).getByText('wrong session', { ignore: 'option' })).toBeTruthy();
  expect(within(list).getByText('about feedback', { ignore: 'option' })).toBeTruthy();
  const found = screen.getByRole('region', { name: 'what the lesson check found' });
  expect(within(found).getByText(/redone from the comment alone/)).toBeTruthy();
  expect(within(found).getByText(/not about the work/)).toBeTruthy();
  expect(screen.getByText('api/search.ts')).toBeTruthy();
});

test('a proposed lesson can be converted to a project fact: the dialog picks the kind and relevance, and the lesson leaves the list', async () => {
  const factLike = { ...lesson('l1', 'Server search'), checks: [{ name: 'looks-like-a-fact', why: 'states how the code is rather than what to do' }] };
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(init.body as string) }); return Response.json({ id: 'fact:1', origin: 'you' }, { status: 201 }); }
    if (url.startsWith('/api/lessons?')) return Response.json([factLike, lesson('l2', 'Auth checks')]);
    if (url === '/api/lessons/l1') return Response.json({ ...detail('l1', 'Server search'), lesson: factLike });
    if (url === '/api/lessons/l2') return Response.json(detail('l2', 'Auth checks'));
    return Response.json([]);
  }));
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  // The check that flagged it points at the way out.
  expect(within(screen.getByRole('region', { name: 'what the lesson check found' })).getByText(/convert it to a project fact/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Convert to fact' }));
  const ask = await screen.findByRole('dialog', { name: /convert this lesson to a project fact/i });
  expect(ask.textContent).toContain('Server search rule');
  expect((within(ask).getByLabelText('fact kind') as HTMLSelectElement).value).toBe('convention');
  expect((within(ask).getByLabelText('fact relevance') as HTMLSelectElement).value).toBe('0.8');
  fireEvent.change(within(ask).getByLabelText('fact kind'), { target: { value: 'gotcha' } });
  fireEvent.change(within(ask).getByLabelText('fact relevance'), { target: { value: '0.55' } });
  fireEvent.click(within(ask).getByRole('button', { name: 'Convert' }));
  await waitFor(() => expect(posts).toEqual([{ url: '/api/lessons/l1/to-fact', body: { kind: 'gotcha', relevance: 0.55 } }]));
  expect(await screen.findByText('Auth checks', { selector: 'h2' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('Cancel in the convert dialog changes nothing, and a refusal is shown in the dialog', async () => {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(url); return Response.json({ error: 'this lesson has no project, so there is no project to file the fact under' }, { status: 409 }); }
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    return Response.json([]);
  }));
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  fireEvent.click(screen.getByRole('button', { name: 'Convert to fact' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(posts).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Convert to fact' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Convert' }));
  expect(await within(screen.getByRole('dialog')).findByText(/no project to file the fact under/)).toBeTruthy();
  expect(screen.getByText('Server search', { selector: 'h2' })).toBeTruthy();
});

test('a rejected lesson shows the note on its decision (converted to a fact)', async () => {
  const converted = { ...lesson('l1', 'Server search'), status: 'rejected', decidedBy: 'you', decisionNote: 'converted to a fact' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?')) return Response.json([converted]);
    if (url === '/api/lessons/l1') return Response.json({ ...detail('l1', 'Server search'), lesson: converted });
    return Response.json([]);
  }));
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'rejected' }));
  await screen.findByText('filtered on the client');
  expect(screen.getAllByText('converted to a fact').length).toBeGreaterThan(0);
});

test('a lesson with no paths says it applies across the project; one never checked shows no check section', async () => {
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  expect(screen.getByText(/no paths: applies anywhere in its project/i)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'what the lesson check found' })).toBeNull();
});

test('the list names where each lesson came from in words, with the detail in a tooltip', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search'), { ...lesson('l2', 'Imported'), source: 'memory' }, { ...lesson('l3', 'Mine'), source: 'manual' }]);
    if (url.startsWith('/api/lessons/')) return Response.json(detail('l1', 'Server search'));
    return Response.json([]);
  }));
  render(<Lessons />);
  const from = async (label: string) => (await screen.findByText(label, { selector: '[title]' })).getAttribute('title');
  expect(await from('post-mortem')).toBe('from a post-mortem');
  expect(await from('memory file')).toBe('imported from a Claude Code memory file');
  expect(await from('by you')).toBe('written by you');
  expect(screen.queryByText(/· postmortem/)).toBeNull();
});

test('edits to an approved lesson are saved with Save, without changing its status', async () => {
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'approved' }));
  const rule = (await screen.findByLabelText('rule')) as HTMLTextAreaElement;
  await waitFor(() => expect(rule.value).toBe('Server search rule'));
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(rule, { target: { value: 'Always filter on the server' } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(patches).toEqual([{ url: '/api/lessons/l1', body: { rule: 'Always filter on the server' } }]));
  // Still listed and still open: saved edits are no longer unsaved.
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
  expect(screen.getByText('Server search', { selector: 'h2' })).toBeTruthy();
});

// ── Bulk decisions ─────────────────────────────────────────────────────

function bulkFetch(listed: object[]) {
  const posts: { url: string; body: any }[] = [];
  const lists: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/lessons/decisions') {
      const body = JSON.parse(init.body as string);
      posts.push({ url, body });
      return Response.json({ results: body.items.map((i: { id: string; status: string }) => ({ id: i.id, ok: true, status: i.status })) });
    }
    if (url.startsWith('/api/lessons?')) { lists.push(url); return Response.json(listed); }
    const m = /^\/api\/lessons\/(\w+)$/.exec(url);
    if (m) return Response.json(detail(m[1], m[1]));
    return Response.json([]);
  }));
  return { posts, lists };
}

const flagged = (id: string, title: string, names: string[], extra: object = {}) =>
  ({ ...lesson(id, title), checks: names.map((name) => ({ name, why: `why ${name}` })), ...extra });

test('select rows, Reject selected: one confirm with a note, one request, and the decided lessons leave the list', async () => {
  const f = bulkFetch([flagged('l1', 'Server search', ['platitude']), flagged('l2', 'Auth checks', []), flagged('l3', 'Cache keys', ['platitude'])]);
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'select Server search' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'select Cache keys' }));
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reject selected' }));
  const ask = await screen.findByRole('dialog', { name: /reject 2 lessons/i });
  expect(ask.textContent).toContain('Server search');
  expect(ask.textContent).toContain('Cache keys');
  fireEvent.change(within(ask).getByLabelText('note'), { target: { value: 'platitudes' } });
  fireEvent.click(within(ask).getByRole('button', { name: 'Reject 2 lessons' }));
  await waitFor(() => expect(f.posts).toEqual([{ url: '/api/lessons/decisions', body: { items: [{ id: 'l1', status: 'rejected', note: 'platitudes' }, { id: 'l3', status: 'rejected', note: 'platitudes' }] } }]));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'select Server search' })).toBeNull());
  expect(screen.getByRole('checkbox', { name: 'select Auth checks' })).toBeTruthy();
  expect(screen.getByText('none selected')).toBeTruthy();
});

test('"select all with flag" picks exactly the lessons carrying it; Approve selected, and Cancel sends nothing', async () => {
  const f = bulkFetch([flagged('l1', 'Server search', ['looks-like-a-fact', 'needs-path']), flagged('l2', 'Auth checks', ['needs-path']), flagged('l3', 'Cache keys', ['platitude'])]);
  render(<Lessons />);
  await screen.findByRole('checkbox', { name: 'select Server search' });
  fireEvent.change(screen.getByLabelText('select all with flag'), { target: { value: 'needs-path' } });
  expect((screen.getByRole('checkbox', { name: 'select Server search' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('checkbox', { name: 'select Auth checks' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('checkbox', { name: 'select Cache keys' }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
  const ask = await screen.findByRole('dialog', { name: /approve 2 lessons/i });
  expect(ask.textContent).toMatch(/agents/i);
  fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
  expect(f.posts).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: /approve 2 lessons/i })).getByRole('button', { name: 'Approve 2 lessons' }));
  await waitFor(() => expect(f.posts[0]?.body).toEqual({ items: [{ id: 'l1', status: 'approved' }, { id: 'l2', status: 'approved' }] }));
});

test('the list filters by source (GitHub review vs session pushback) and by flag, on the server', async () => {
  const f = bulkFetch([flagged('l1', 'Server search', [], { from: 'github' })]);
  render(<Lessons />);
  await screen.findByRole('checkbox', { name: 'select Server search' });
  fireEvent.change(screen.getByLabelText('source'), { target: { value: 'github' } });
  await waitFor(() => expect(f.lists.at(-1)).toBe('/api/lessons?status=proposed&source=github'));
  fireEvent.change(screen.getByLabelText('flag'), { target: { value: 'duplicate-of' } });
  await waitFor(() => expect(f.lists.at(-1)).toBe('/api/lessons?status=proposed&flag=duplicate-of&source=github'));
  expect(screen.getAllByText('GitHub review').length).toBeGreaterThan(0);
});

test('the header says how the lessons the post-mortem wrote were judged: approved as written, after an edit, rejected', async () => {
  const q = (days: number, asWritten: number, edited: number, rejected: number) => ({ days, asWritten, edited, rejected, decided: asWritten + edited + rejected });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/lessons/quality') return Response.json({ windows: [q(30, 21, 60, 62), q(90, 30, 70, 80)], projects: { acme: [q(30, 20, 50, 60), q(90, 29, 60, 78)], web: [q(30, 1, 10, 2), q(90, 1, 10, 2)] } });
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    return Response.json([]);
  }));
  render(<Lessons />);
  const judged = await screen.findByLabelText('how your lessons were judged');
  expect(judged.textContent).toMatch(/Last 30 days: 143 decided/);
  expect(judged.textContent).toMatch(/21 as written \(15%\)/);
  expect(judged.textContent).toMatch(/60 after an edit \(42%\)/);
  expect(judged.textContent).toMatch(/62 rejected \(43%\)/);
  // By project and over 90 days, one click away.
  const rows = within(judged).getAllByRole('row').map((r) => r.textContent);
  expect(rows).toEqual(expect.arrayContaining([expect.stringMatching(/^acme.*130.*20.*50.*60/), expect.stringMatching(/^web/)]));
  expect(judged.textContent).toMatch(/90 days/);
});

test('the header says how many of the decisions an agent made with the operator token, when any did', async () => {
  const q = (days: number, asWritten: number, rejected: number, byOperator: number) => ({ days, asWritten, edited: 0, rejected, decided: asWritten + rejected, byOperator });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/lessons/quality') return Response.json({ windows: [q(30, 81, 61, 40), q(90, 81, 61, 40)], projects: { acme: [q(30, 81, 61, 40), q(90, 81, 61, 40)] } });
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    return Response.json([]);
  }));
  render(<Lessons />);
  const judged = await screen.findByLabelText('how your lessons were judged');
  expect(judged.textContent).toMatch(/40 by an agent with the operator token \(28%\)/);
  expect(within(judged).getAllByRole('columnheader').map((h) => h.textContent)).toContain('by operator');
  expect(within(judged).getAllByRole('row').map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^acme.*142.*40 \(28%\)$/)]));
});

test('no decided lessons yet, or a server that cannot tell: the header says nothing about it', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/lessons/quality') return Response.json({ error: 'this store cannot count lesson decisions' }, { status: 404 });
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    return Response.json([]);
  }));
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  expect(screen.queryByLabelText('how your lessons were judged')).toBeNull();
});

test('a generic lesson is listed last, with the reason under it', async () => {
  bulkFetch([flagged('l1', 'Verify the sequence', ['generic']), flagged('l2', 'Escape CSV headers', []), flagged('l3', 'Close the pool', ['needs-path'])]);
  render(<Lessons />);
  await screen.findByRole('checkbox', { name: 'select Escape CSV headers' });
  const rows = screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')).filter((n) => n?.startsWith('select '));
  expect(rows).toEqual(['select Escape CSV headers', 'select Close the pool', 'select Verify the sequence']);
  const list = screen.getByRole('complementary', { name: 'lessons' });
  expect(within(list).getByText('why generic')).toBeTruthy();
});

test('narrowing a global lesson asks for its project and sends it with the scope', async () => {
  const global = { ...lesson('g1', 'Escape CSV headers'), projectKey: null, scope: 'global', source: 'manual' };
  const sent: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { sent.push(JSON.parse(init.body as string)); return new Response(null, { status: 204 }); }
    if (url.startsWith('/api/lessons?')) return Response.json([global]);
    if (url === '/api/lessons/g1') return Response.json({ ...detail('g1', 'Escape CSV headers'), lesson: global });
    if (url === '/api/projects') return Response.json([{ key: 'web' }, { key: 'data-pipeline' }]);
    return Response.json([]);
  }));
  render(<Lessons />);
  const scope = await screen.findByLabelText('scope');
  expect(screen.queryByLabelText('project')).toBeNull();
  fireEvent.change(scope, { target: { value: 'project' } });
  const project = (await screen.findByLabelText('project')) as HTMLSelectElement;
  await waitFor(() => expect([...project.options].map((o) => o.value)).toEqual(['', 'web', 'data-pipeline']));
  // No project chosen: nothing is sent, and the owner is told why.
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/choose the project/i)).toBeTruthy();
  expect(sent).toEqual([]);
  fireEvent.change(project, { target: { value: 'data-pipeline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(sent).toEqual([{ status: 'approved', scope: 'project', projectKey: 'data-pipeline' }]));
});

test('the bulk bar never moves the rows: its buttons are there (disabled) before anything is ticked, so a second click lands on the same row', async () => {
  bulkFetch([flagged('l1', 'Server search', []), flagged('l2', 'Auth checks', []), flagged('l3', 'Cache keys', [])]);
  render(<Lessons />);
  await screen.findByRole('checkbox', { name: 'select Server search' });
  const approve = screen.getByRole('button', { name: 'Approve selected' }) as HTMLButtonElement;
  const reject = screen.getByRole('button', { name: 'Reject selected' }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  expect(reject.disabled).toBe(true);
  expect(screen.getByText('none selected')).toBeTruthy();
  const bar = approve.parentElement!;
  const before = bar.childElementCount;
  fireEvent.click(screen.getByRole('checkbox', { name: 'select Server search' }));
  // The same elements, now enabled: nothing is added above the rows.
  expect(bar.childElementCount).toBe(before);
  expect(screen.getByRole('button', { name: 'Approve selected' })).toBe(approve);
  expect(approve.disabled).toBe(false);
  expect(screen.getByText('1 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'select Auth checks' }));
  expect((screen.getByRole('checkbox', { name: 'select Auth checks' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('checkbox', { name: 'select Cache keys' }) as HTMLInputElement).checked).toBe(false);
});

test('an empty list under a filter says nothing matches the filter (not "none yet"), with a way to clear it', async () => {
  const f = bulkFetch([]);
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'approved' }));
  expect(await screen.findByText('No approved lessons yet')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('source'), { target: { value: 'github' } });
  expect(await screen.findByText('No approved lessons match this filter')).toBeTruthy();
  expect(screen.queryByText('No approved lessons yet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(f.lists.at(-1)).toBe('/api/lessons?status=approved'));
  expect(await screen.findByText('No approved lessons yet')).toBeTruthy();
});

test('what the lesson check found is headed by status: "before you approve" only on a proposed lesson', async () => {
  const checks = [{ name: 'generic', why: 'names no file, function, value or command' }];
  const approved = { ...lesson('l1', 'Server search'), status: 'approved', checks };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/lessons?')) return Response.json([approved]);
    if (url === '/api/lessons/l1') return Response.json({ ...detail('l1', 'Server search'), lesson: approved });
    return Response.json([]);
  }));
  render(<Lessons />);
  fireEvent.click(await screen.findByRole('button', { name: 'approved' }));
  const found = await screen.findByRole('region', { name: 'what the lesson check found' });
  expect(found.textContent).toMatch(/what the lesson check found/i);
  expect(found.textContent).not.toMatch(/before you approve/i);
});

test('the judged header counts the decisions an agent made with the operator token apart', async () => {
  const q = (days: number, byOperator: number) => ({ days, asWritten: 5, edited: 3, rejected: 2, decided: 10, byOperator });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/lessons/quality') return Response.json({ windows: [q(30, 4), q(90, 4)], projects: {} });
    if (url.startsWith('/api/lessons?')) return Response.json([lesson('l1', 'Server search')]);
    if (url === '/api/lessons/l1') return Response.json(detail('l1', 'Server search'));
    return Response.json([]);
  }));
  render(<Lessons />);
  const judged = await screen.findByLabelText('how your lessons were judged');
  expect(judged.textContent).toMatch(/4 by an agent/);
  // Said once, with its share: 0.6.3 printed it a second time after the ternary.
  const summary = judged.querySelector('summary')!.textContent!;
  expect(summary.match(/by an agent with the operator token/g)).toHaveLength(1);
  expect(summary).toMatch(/4 by an agent with the operator token \(40%\)/);
});


test('PR number and feedback author filters are sent to the API', async () => {
  render(<Lessons />);
  await screen.findByText('filtered on the client');
  fireEvent.change(screen.getByLabelText('PR number'), { target: { value: '42' } });
  fireEvent.change(screen.getByLabelText('feedback author'), { target: { value: 'octo' } });
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('pr=42') && String(url).includes('author=octo'))).toBe(true));
});


test('a deleted lesson link never opens an unrelated lesson', async () => {
  location.hash = '#lessons/deleted';
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url) === '/api/lessons/deleted' ? new Response(null, { status: 404 }) : original(url, init));
  render(<Lessons />);
  expect(await screen.findByText('Linked lesson is unavailable')).toBeTruthy();
  expect(screen.queryByText('filtered on the client')).toBeNull();
});
