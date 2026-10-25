import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Settings } from './Settings.tsx';

const row = (key: string, o: Record<string, unknown> = {}) => ({
  key, path: `/Users/me/Vibe/${key}`, exists: true, git: true, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null,
  tracked: false, excluded: false, aliasOf: null, hasData: false, inScope: false, ...o,
});

function body(o: { initialized?: boolean; tracked?: string[] } = {}) {
  const tracked = o.tracked ?? ['demo-shop'];
  return {
    initialized: o.initialized ?? true,
    tracked,
    candidates: [
      row('demo-shop', { remote: 'github.com/me/shop', claudeSessions: 3, codexSessions: 2, lastActivity: '2026-10-22T10:00:00Z', tracked: tracked.includes('demo-shop'), hasData: true, inScope: tracked.includes('demo-shop') }),
      row('other', { claudeSessions: 5, lastActivity: '2026-10-20T10:00:00Z', hasData: true }),
      row('secret', { claudeSessions: 4, excluded: true, lastActivity: '2026-10-21T10:00:00Z' }),
      row('shop-copy', { claudeSessions: 1, aliasOf: 'demo-shop', tracked: tracked.includes('demo-shop'), lastActivity: '2026-10-19T10:00:00Z' }),
      row('gone', { path: '', exists: false, git: false, claudeSessions: 2 }),
      row('empty', { git: false }),
    ],
    outsideRoots: { claudeSessions: 37, codexSessions: 41, folders: [{ path: '/Users/me/work', claudeSessions: 30, codexSessions: 6 }, { path: '/Users/me/games', claudeSessions: 7, codexSessions: 0 }] },
    roots: ['/Users/me/Vibe'],
    pendingRoots: null as string[] | null,
    rootsEditable: true,
    builtAt: '2026-10-22T10:05:00Z',
    codexSessionsFound: true,
  };
}

let calls: { url: string; method: string; body?: unknown }[];
let state: ReturnType<typeof body>;
let failGet: { status: number; error: string } | null;
let failPut: string | null;

beforeEach(() => {
  calls = [];
  state = body();
  failGet = null;
  failPut = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/settings/projects' && method === 'GET') {
      if (failGet) return Response.json({ error: failGet.error }, { status: failGet.status });
      return Response.json(state);
    }
    if (url === '/api/settings/projects' && method === 'PUT') {
      const tracked = (JSON.parse(init!.body as string) as { tracked: string[] }).tracked;
      if (failPut) return Response.json({ error: failPut }, { status: 400 });
      state = body({ tracked });
      return Response.json(state);
    }
    if (url === '/api/settings/roots' && method === 'PUT') {
      const roots = (JSON.parse(init!.body as string) as { roots: string[] }).roots;
      if (failPut) return Response.json({ error: failPut }, { status: 400 });
      state = { ...state, pendingRoots: roots.join() === state.roots.join() ? null : roots };
      return Response.json(state);
    }
    if (url === '/api/settings/cleanup') return Response.json({ removed: ['other'], nodesRemoved: 12 });
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rowOf = (key: string) => screen.getByRole('row', { name: key });
const box = (key: string) => screen.getByRole('checkbox', { name: `read ${key}` }) as HTMLInputElement;
const shown = () => screen.queryAllByRole('checkbox').map((c) => c.getAttribute('aria-label')!.replace('read ', ''));

test('the comments skipped before the classifier are listed right under Integrations, where comments are set up', async () => {
  const base = fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
  const svc = { connection: { state: 'not_connected', source: null, detail: 'Not connected.', href: '#settings/integrations-github' }, envSet: false, envVar: 'GITHUB_TOKEN', savedInApp: false, account: null, checkedAt: null, lastSyncAt: null, lastError: null, errorKind: null, rateLimitedUntil: null };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
    url === '/api/settings/integrations' ? Response.json({ canSave: true, syncMinutes: 10, github: svc, linear: { ...svc, envVar: 'LINEAR_API_KEY' }, projects: [] })
      : url === '/api/cloud' ? Response.json({ enabled: false, host: null, intervalMinutes: 60, suggestions: false, projects: [], preview: null, previewError: null, last: null, nextAt: null, neverSent: 'x' })
      : base(url, init)));
  render(<Settings />);
  const rules = await screen.findByRole('list', { name: 'comments skipped before the classifier' });
  const section = rules.closest('section')!;
  await screen.findByText('Cloud sync');
  await waitFor(() => expect(section.previousElementSibling?.id).toBe('settings-integrations-section'));
});

test('lists every candidate folder with its path, remote, counts and status chips', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  const shop = within(rowOf('demo-shop'));
  expect(shop.getByText('/Users/me/Vibe/demo-shop')).toBeTruthy();
  expect(shop.getByText('github.com/me/shop')).toBeTruthy();
  expect(shop.getByText('selected')).toBeTruthy();
  expect(shop.getByText('has data')).toBeTruthy();
  expect(within(rowOf('secret')).getByText('excluded')).toBeTruthy();
  expect(within(rowOf('shop-copy')).getByText('clone of demo-shop')).toBeTruthy();
  expect(within(rowOf('gone')).getByText('missing folder')).toBeTruthy();
  expect(within(rowOf('other')).queryByText('selected')).toBeNull();
  expect(box('demo-shop').checked).toBe(true);
  expect(box('other').checked).toBe(false);
});

test('sorted by last activity by default, and by name when that header is clicked', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  expect(shown().slice(0, 4)).toEqual(['demo-shop', 'secret', 'other', 'shop-copy']);
  fireEvent.click(screen.getByRole('button', { name: /^Folder/ }));
  expect(shown()).toEqual(['demo-shop', 'empty', 'gone', 'other', 'secret', 'shop-copy']);
  fireEvent.click(screen.getByRole('button', { name: /^Claude Code/ }));
  expect(shown()[0]).toBe('other');
});

test('excluded, alias and missing folders cannot be ticked, and say why', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  expect(box('secret').disabled).toBe(true);
  expect(box('secret').closest('[title]')?.getAttribute('title')).toMatch(/EXCLUDE_PROJECTS/);
  expect(box('shop-copy').disabled).toBe(true);
  expect(within(rowOf('shop-copy')).getByText(/follows demo-shop/)).toBeTruthy();
  expect(box('gone').disabled).toBe(true);
  expect(box('other').disabled).toBe(false);
});

test('search and filters narrow the list', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  fireEvent.change(screen.getByLabelText('search folders'), { target: { value: 'oth' } });
  expect(shown()).toEqual(['other']);
  fireEvent.change(screen.getByLabelText('search folders'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /^Selected/ }));
  expect(shown()).toEqual(['demo-shop', 'shop-copy']);
  fireEvent.click(screen.getByRole('button', { name: /^With sessions/ }));
  expect(shown()).not.toContain('empty');
  expect(shown()).toHaveLength(5);
  fireEvent.click(screen.getByRole('button', { name: /^Has data/ }));
  expect(shown().sort()).toEqual(['demo-shop', 'other']);
});

test('ticking only edits locally; Save selection sends exactly the edited list', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  fireEvent.click(box('other'));
  fireEvent.click(box('empty'));
  fireEvent.click(box('demo-shop'));
  expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  const bar = within(screen.getByRole('region', { name: 'unsaved selection' }));
  expect(bar.getByText('+2 added')).toBeTruthy();
  expect(bar.getByText('-1 removed')).toBeTruthy();
  fireEvent.click(bar.getByRole('button', { name: 'Save selection' }));
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/settings/projects', method: 'PUT', body: { tracked: ['empty', 'other'] } }));
  expect(await screen.findByText(/Saved/)).toBeTruthy();
  await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/settings/projects').length).toBeGreaterThanOrEqual(2));
  expect(screen.queryByRole('region', { name: 'unsaved selection' })).toBeNull();
  expect(box('other').checked).toBe(true);
});

test('bulk selection: all, none, the folders shown by the search and filter, and the folders with sessions; locked ones are skipped', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  const bulk = within(screen.getByRole('group', { name: 'select folders' }));
  const ticked = () => shown().filter((k) => box(k).checked);
  const saveSends = async (tracked: string[]) => {
    fireEvent.click(within(screen.getByRole('region', { name: 'unsaved selection' })).getByRole('button', { name: 'Save selection' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/settings/projects', method: 'PUT', body: { tracked } }));
  };

  fireEvent.click(bulk.getByRole('button', { name: 'Select all' }));
  // Excluded, another clone (it follows demo-shop) and gone stay as they were.
  expect(ticked().sort()).toEqual(['demo-shop', 'empty', 'other', 'shop-copy']);
  fireEvent.click(bulk.getByRole('button', { name: 'Select none' }));
  expect(ticked()).toEqual([]);
  await saveSends([]);

  fireEvent.change(screen.getByLabelText('search folders'), { target: { value: 'oth' } });
  fireEvent.click(bulk.getByRole('button', { name: 'Select shown (1)' }));
  fireEvent.change(screen.getByLabelText('search folders'), { target: { value: '' } });
  expect(ticked()).toEqual(['other']);
  fireEvent.click(bulk.getByRole('button', { name: 'Select folders with sessions (2)' }));
  expect(ticked().sort()).toEqual(['demo-shop', 'other', 'shop-copy']);
  await saveSends(['demo-shop', 'other']);
});

test('Cancel puts the saved selection back', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  fireEvent.click(box('other'));
  expect(box('other').checked).toBe(true);
  fireEvent.click(within(screen.getByRole('region', { name: 'unsaved selection' })).getByRole('button', { name: 'Cancel' }));
  expect(box('other').checked).toBe(false);
  expect(screen.queryByRole('region', { name: 'unsaved selection' })).toBeNull();
});

test('clean up lists unselected projects with data and needs the typed confirm', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  const section = within(screen.getByRole('region', { name: 'Clean up' }));
  expect(section.getByText('other')).toBeTruthy();
  fireEvent.click(section.getByRole('button', { name: 'Remove data for 1 unselected project' }));
  const ask = within(await screen.findByRole('alertdialog', { name: /remove the data of 1 unselected project/i }));
  expect(ask.getByRole('list', { name: 'will be removed' }).textContent).toBe('other');
  expect(document.activeElement).toBe(ask.getByRole('button', { name: 'Cancel' }));
  const confirm = ask.getByRole('button', { name: 'Remove data' }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(ask.getByLabelText(/type remove-unselected/), { target: { value: 'remove' } });
  expect(confirm.disabled).toBe(true);
  fireEvent.change(ask.getByLabelText(/type remove-unselected/), { target: { value: 'remove-unselected' } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/settings/cleanup', method: 'POST', body: { confirm: 'remove-unselected' } }));
  expect(await section.findByText(/Removed data for other/)).toBeTruthy();
});

test('cancelling clean up removes nothing', async () => {
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  fireEvent.click(within(screen.getByRole('region', { name: 'Clean up' })).getByRole('button', { name: 'Remove data for 1 unselected project' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(calls.some((c) => c.url === '/api/settings/cleanup')).toBe(false);
});

test('clean up is disabled when every project with data is selected', async () => {
  state = body({ tracked: ['demo-shop', 'other'] });
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  const section = within(screen.getByRole('region', { name: 'Clean up' }));
  expect((section.getByRole('button', { name: /Remove data for 0/ }) as HTMLButtonElement).disabled).toBe(true);
});

test('clean up does not offer data filed under a clone of a selected project', async () => {
  state = body({ tracked: ['demo-shop', 'other'] });
  state.candidates = state.candidates.map((c) => (c.key === 'shop-copy' ? { ...c, hasData: true } : c));
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  const section = within(screen.getByRole('region', { name: 'Clean up' }));
  expect((section.getByRole('button', { name: /Remove data for 0/ }) as HTMLButtonElement).disabled).toBe(true);
});

test('with nothing chosen, a callout says nothing is being read', async () => {
  state = body({ initialized: false, tracked: [] });
  render(<Settings />);
  expect(await screen.findByText(/Nothing is being read/)).toBeTruthy();
});

test('sessions outside the roots and the roots themselves are shown', async () => {
  render(<Settings />);
  expect(await screen.findByText(/37 Claude Code and 41 Codex sessions ran outside your project folders/)).toBeTruthy();
  expect(screen.queryByText(/PROJECTS_DIR/)).toBeNull();
  const roots = within(screen.getByRole('list', { name: 'project roots' }));
  expect(roots.getByText('/Users/me/Vibe')).toBeTruthy();
});

const rootsPut = () => calls.filter((c) => c.url === '/api/settings/roots').map((c) => c.body);

test('a folder typed in Add folder is saved as a root, and the banner says how to mount it', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  render(<Settings />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'folder to add' }), { target: { value: '/Users/me/code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
  await waitFor(() => expect(rootsPut()).toEqual([{ roots: ['/Users/me/Vibe', '/Users/me/code'] }]));
  const banner = await screen.findByRole('status', { name: 'roots not mounted yet' });
  expect(banner.textContent).toContain('Saved. Run ./scripts/setup.sh to mount these folders (restarts the containers).');
  expect(within(screen.getByRole('list', { name: 'project roots' })).getByText('not mounted yet')).toBeTruthy();
  fireEvent.click(within(banner).getByRole('button', { name: /copy/i }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('./scripts/setup.sh'));
});

test('removing a root asks first in the confirm dialog, then saves the rest', async () => {
  render(<Settings />);
  fireEvent.click(await screen.findByRole('button', { name: 'remove /Users/me/Vibe' }));
  expect(rootsPut()).toEqual([]);
  const ask = screen.getByRole('alertdialog', { name: 'Remove /Users/me/Vibe from the project roots?' });
  expect(ask.textContent).toMatch(/no longer listed/);
  expect(document.activeElement?.textContent).toBe('Cancel');
  fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'remove /Users/me/Vibe' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove folder' }));
  await waitFor(() => expect(rootsPut()).toEqual([{ roots: [] }]));
  expect((await screen.findByRole('status', { name: 'roots not mounted yet' })).textContent).toContain('Run ./scripts/setup.sh');
  expect(screen.getByText(/Still mounted until then/)).toBeTruthy();
});

test('the folders outside sessions ran in are suggested with their counts, each one click from being a root', async () => {
  render(<Settings />);
  const list = within(await screen.findByRole('list', { name: 'suggested folders' }));
  expect(list.getByText('/Users/me/work')).toBeTruthy();
  expect(list.getByText(/30 Claude Code, 6 Codex/)).toBeTruthy();
  fireEvent.click(list.getByRole('button', { name: 'add /Users/me/games as a root' }));
  await waitFor(() => expect(rootsPut()).toEqual([{ roots: ['/Users/me/Vibe', '/Users/me/games'] }]));
});

test('a refused root shows the server reason', async () => {
  failPut = 'code: give an absolute path';
  render(<Settings />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'folder to add' }), { target: { value: 'code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
  expect(await screen.findByText('code: give an absolute path')).toBeTruthy();
});

test('with no project folder at all, the page says to add one first', async () => {
  state = { ...body(), roots: [], candidates: [] };
  render(<Settings />);
  expect(await screen.findByText('No project folders yet')).toBeTruthy();
  expect(screen.getAllByText(/Add a project folder/).length).toBeGreaterThan(0);
});

test('when roots cannot be saved here, it says how to change them instead', async () => {
  state = { ...body(), rootsEditable: false };
  render(<Settings />);
  await screen.findByRole('list', { name: 'project roots' });
  expect(screen.queryByRole('textbox', { name: 'folder to add' })).toBeNull();
  expect(screen.queryByRole('button', { name: /remove \// })).toBeNull();
  expect(screen.getByText(/PROJECTS_DIRS/)).toBeTruthy();
});

test('server errors are shown in an alert', async () => {
  failGet = { status: 503, error: 'graph unreachable' };
  render(<Settings />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/graph unreachable/);
});

test('a refused save shows the server reason and keeps your edits', async () => {
  failPut = 'excluded by EXCLUDE_PROJECTS: other';
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  fireEvent.click(box('other'));
  fireEvent.click(screen.getByRole('button', { name: 'Save selection' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/excluded by EXCLUDE_PROJECTS: other/);
  expect(box('other').checked).toBe(true);
});

// A folder saved as tracked can later become another clone (its first session links it to a project with the same
// remote) or be added to EXCLUDE_PROJECTS. It must never lock the page: it can be unticked, and saving drops it.
test('a tracked folder that became a clone or was excluded can be unticked, says why, and saving works', async () => {
  state = body({ tracked: ['demo-shop', 'secret', 'shop-copy'] });
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  expect(box('secret').disabled).toBe(false);
  expect(box('secret').checked).toBe(true);
  expect(within(rowOf('secret')).getByText(/still in your saved selection/i)).toBeTruthy();
  expect(box('shop-copy').disabled).toBe(false);
  expect(within(rowOf('shop-copy')).getByText(/still in your saved selection/i)).toBeTruthy();
  fireEvent.click(box('shop-copy'));
  expect(box('shop-copy').checked).toBe(false);
  // Unticking the stale clone key leaves the project it follows ticked.
  expect(box('demo-shop').checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save selection' }));
  // The excluded key left ticked is dropped too: the server would refuse to keep it, and it is never read anyway.
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/settings/projects', method: 'PUT', body: { tracked: ['demo-shop'] } }));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('ticking a new folder while a stale tracked one is still ticked saves without it', async () => {
  state = body({ tracked: ['demo-shop', 'secret'] });
  render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  fireEvent.click(box('other'));
  fireEvent.click(screen.getByRole('button', { name: 'Save selection' }));
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/settings/projects', method: 'PUT', body: { tracked: ['demo-shop', 'other'] } }));
});

test('labels people read never use the icon-only faint colour', async () => {
  const { container } = render(<Settings />);
  await screen.findByRole('row', { name: 'demo-shop' });
  expect(within(rowOf('empty')).getByText('never')).toBeTruthy();
  expect(container.querySelectorAll('.text-faint')).toHaveLength(0);
});

test('lists the rules that skip GitHub and Linear comments before the classifier', async () => {
  render(<Settings />);
  const rules = await screen.findByRole('list', { name: 'comments skipped before the classifier' });
  expect(within(rules).getByText('pr-author-reply')).toBeTruthy();
});
