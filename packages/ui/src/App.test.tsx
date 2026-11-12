import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App.tsx';

/** GET /api/settings/projects with no folders yet: what Settings loads when a test opens it. */
const noFolders = { initialized: true, tracked: [], candidates: [], outsideRoots: { claudeSessions: 0, codexSessions: 0, folders: [] }, roots: [], pendingRoots: null, rootsEditable: false, builtAt: null, codexSessionsFound: true };
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/settings/projects' ? noFolders : []))); location.hash = ''; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('the Dashboard is the first page in the sidebar and the one the app opens on', async () => {
  render(<App />);
  const labels = screen.getAllByRole('button').map((b) => b.textContent);
  expect(labels.indexOf('Dashboard')).toBeLessThan(labels.indexOf('Inbox'));
  expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
  await act(async () => {});
  expect(location.hash).toBe('#dashboard');
});

test('changing the URL hash (links, back button) switches the page', async () => {
  render(<App />);
  expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page');
  await act(async () => {
    location.hash = 'activity';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.getByRole('button', { name: 'Activity' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBeNull();
});

test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('a hash naming no page (#%s) opens the Dashboard', async (word) => {
  location.hash = `#${word}`;
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
  await act(async () => {
    location.hash = `#${word}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
});

test('a link to one item (#lessons/<id>) opens its page and keeps the id in the hash', async () => {
  location.hash = '#lessons/l1';
  render(<App />);
  expect(screen.getByRole('button', { name: 'Lessons' }).getAttribute('aria-current')).toBe('page');
  await act(async () => {});
  expect(location.hash).toBe('#lessons/l1');
});

test('a page that crashes shows why with the sidebar still there, and Reset this page opens it again without its address filters', async () => {
  let broken = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // An answer of a shape the page cannot draw (a decision with no confidence).
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.startsWith('/api/decisions') && broken ? [{ id: 'dec:x', status: 'applied' }] : url === '/api/settings/projects' ? noFolders : [])));
  location.hash = '#decisions?status=all&since=2026-11-01';
  render(<App />);
  expect(await screen.findByText(/^Decisions could not be shown: /)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy();
  // Still headed as its page.
  expect(screen.getByRole('heading', { name: 'Decisions', level: 1 })).toBeTruthy();
  broken = false;
  await act(async () => { screen.getByRole('button', { name: 'Reset this page' }).click(); });
  expect(location.hash).toBe('#decisions');
  expect(await screen.findByText('Nothing waiting for you')).toBeTruthy();
  expect(screen.queryByText(/could not be shown/)).toBeNull();
  vi.mocked(console.error).mockRestore();
});

function server(o: { authRequired?: boolean; ownerSetupRequired?: boolean; ownerWrites?: boolean; token?: string; signedIn?: boolean; signOutFails?: boolean; workerHealthy?: boolean; tracked?: number; roots?: number; models?: object; ollama?: object }) {
  let signedIn = o.signedIn ?? !o.authRequired;
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session' && init?.method === 'POST') {
      const { token } = JSON.parse(String(init.body));
      posts.push(token);
      if (token !== o.token) return Response.json({ error: 'wrong token' }, { status: 401 });
      signedIn = true;
      return new Response(null, { status: 204 });
    }
    if (url === '/api/session' && init?.method === 'DELETE') {
      if (o.signOutFails) return Response.json({ error: 'store unavailable' }, { status: 503 });
      signedIn = false; return new Response(null, { status: 204 });
    }
    if (url === '/api/session') return Response.json({ authRequired: !!o.authRequired, authenticated: signedIn, ownerSession: !!o.authRequired && signedIn, ownerSetupRequired: !!o.ownerSetupRequired, ownerWrites: o.ownerWrites ?? true });
    if (!signedIn) return Response.json({ error: 'sign in required' }, { status: 401 });
    if (url === '/api/settings/projects') return Response.json(noFolders);
    if (url === '/api/status') return Response.json({ version: '0.2.0', graph: true, worker: null, workerHealthy: o.workerHealthy ?? true, authRequired: !!o.authRequired, selection: o.tracked === undefined ? null : { initialized: true, tracked: o.tracked, roots: o.roots, note: o.roots === 0 ? 'No project folders yet: add a project folder in Settings first.' : o.tracked ? null : 'No projects are selected yet, so no sessions are being read.' }, models: o.models ?? null, ollama: o.ollama ?? null });
    return Response.json([]);
  }));
  return { posts };
}

test('with a token configured, the UI asks you to sign in first', async () => {
  const { fireEvent } = await import('@testing-library/react');
  const s = server({ authRequired: true, token: 'secret-token' });
  render(<App />);
  const input = await screen.findByLabelText('owner token');
  // The one-time link comes first; pasting the owner token is the fallback.
  const card = input.closest('form')!;
  expect(card.textContent).toMatch(/run \.\/scripts\/fg signin and open the link it prints/);
  expect(card.textContent!.indexOf('./scripts/fg signin')).toBeLessThan(card.textContent!.indexOf('Or paste the owner sign-in token (FG_OWNER_TOKEN'));
  fireEvent.change(input, { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('wrong token')).toBeTruthy();
  fireEvent.change(input, { target: { value: 'secret-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('button', { name: 'Inbox' })).toBeTruthy();
  expect(s.posts).toEqual(['wrong', 'secret-token']);
});

test('an upgraded protected install without an owner token explains the required migration instead of offering a broken sign-in', async () => {
  server({ authRequired: true, ownerSetupRequired: true });
  render(<App />);
  expect(await screen.findByText('Owner sign-in needs setup')).toBeTruthy();
  expect(screen.getByText(/setup\.sh --yes/)).toBeTruthy();
  expect(screen.queryByLabelText('owner token')).toBeNull();
});

test('tokenless installs show no dead sign-out action; a failed protected sign-out keeps the app and reports it', async () => {
  const { fireEvent } = await import('@testing-library/react');
  server({}); render(<App />);
  await screen.findByRole('button', { name: 'Inbox' });
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  cleanup();
  server({ authRequired: true, token: 'owner', signedIn: true, signOutFails: true }); render(<App />);
  const signOut = await screen.findByRole('button', { name: 'Sign out' });
  fireEvent.click(signOut);
  expect(await screen.findByText(/Sign out failed: store unavailable.*still signed in/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy();
});

test('signing out of a protected install goes back to the sign-in screen', async () => {
  const { fireEvent } = await import('@testing-library/react');
  server({ authRequired: true, token: 'owner', signedIn: true });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  expect(await screen.findByLabelText('owner token')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
});

test('the header warns when the worker has stopped reporting', async () => {
  server({ workerHealthy: false });
  render(<App />);
  expect(await screen.findByText(/worker offline/i)).toBeTruthy();
});

test('the header says plainly when no projects are selected, so nothing is being read', async () => {
  server({ tracked: 0 });
  render(<App />);
  const badge = await screen.findByText(/no projects selected/i);
  expect(badge.closest('[title]')?.getAttribute('title')).toMatch(/no sessions are being read/);
});

test('with no project folder at all, the header points to Settings to add one', async () => {
  server({ tracked: 0, roots: 0 });
  render(<App />);
  const badge = await screen.findByText(/no project folders/i);
  expect(badge.closest('[title]')?.getAttribute('title')).toMatch(/add a project folder in Settings first/);
});

test('with no projects selected, every page but Settings says nothing is shown and links to Settings', async () => {
  server({ tracked: 0 });
  render(<App />);
  const note = await screen.findByRole('status', { name: 'no projects selected' });
  expect(note.textContent).toMatch(/only the projects you select in Settings are shown/i);
  expect(within(note).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('#settings');
  await act(async () => { screen.getByRole('button', { name: 'Settings' }).click(); });
  expect(screen.queryByRole('status', { name: 'no projects selected' })).toBeNull();
});

test('with projects selected there is no such note', async () => {
  server({ tracked: 1 });
  render(<App />);
  await screen.findByText(/worker running/i);
  expect(screen.queryByRole('status', { name: 'no projects selected' })).toBeNull();
});

test('the header names an unavailable model in its label, with the reason in the tooltip', async () => {
  const ok = { provider: 'claude-cli', ok: true, reason: null };
  server({ tracked: 2, models: { classify: { provider: 'ollama:gemma4', ok: false, reason: 'model not found (ollama 404)' }, postmortem: ok, scan: ok } });
  render(<App />);
  const badge = await screen.findByText(/classifier unavailable/i);
  expect(badge.closest('[title]')?.getAttribute('title')).toMatch(/ollama:gemma4: model not found \(ollama 404\)/);
});

test('a post-mortem model that is down is named in the label too', async () => {
  const ok = { provider: 'ollama:gemma4', ok: true, reason: null };
  server({ tracked: 2, models: { classify: ok, postmortem: { provider: 'claude-cli', ok: false, reason: 'claude is not signed in' }, scan: ok } });
  render(<App />);
  expect(await screen.findByText(/post-mortem model unavailable/i)).toBeTruthy();
});

test('the header warns when session summaries are paused, and not when SUMMARY_LLM=off', async () => {
  const ok = { provider: 'claude-cli', ok: true, reason: null };
  server({ tracked: 2, models: { classify: ok, postmortem: ok, scan: ok, summary: { provider: 'ollama:gemma4', ok: false, reason: 'model not found (ollama 404)' } } });
  render(<App />);
  const badge = await screen.findByText(/summaries paused/i);
  expect(badge.closest('[title]')?.getAttribute('title')).toMatch(/summaries paused: ollama:gemma4: model not found \(ollama 404\)/);
  cleanup();
  server({ tracked: 2, models: { classify: ok, postmortem: ok, scan: ok, summary: { provider: null, ok: true, reason: null, off: true } } });
  render(<App />);
  expect(await screen.findByText(/worker running/i)).toBeTruthy();
});

test('the header says Ollama is unreachable, with the reason, even when no job model uses it', async () => {
  const ok = { provider: 'claude-cli', ok: true, reason: null };
  const reason = 'Ollama is not reachable at http://host.docker.internal:11434: start it (ollama serve)';
  server({ tracked: 2, models: { classify: ok, postmortem: ok, scan: ok }, ollama: { url: 'http://host.docker.internal:11434', ok: false, reason } });
  render(<App />);
  const badge = await screen.findByText(/ollama unreachable/i);
  expect(badge.closest('[title]')?.getAttribute('title')).toContain(reason);
  expect(badge.closest('[title]')?.getAttribute('title')).toMatch(/search, get_task_context and check_before_done/);
});

test('a Docs page after Activity explains how to use the tool', async () => {
  render(<App />);
  const labels = screen.getAllByRole('button').map((b) => b.textContent);
  expect(labels.indexOf('Docs')).toBe(labels.indexOf('Activity') + 1);
  await act(async () => { screen.getByRole('button', { name: 'Docs' }).click(); });
  expect(location.hash).toBe('#docs');
  for (const heading of ['How it works', 'Your first hour', 'Connect your agents', 'Each page']) {
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  }
  expect(screen.getAllByText('get_task_context').length).toBeGreaterThan(0);
});

test('Settings has its own place in the sidebar and its own #settings address', async () => {
  render(<App />);
  await act(async () => { screen.getByRole('button', { name: 'Settings' }).click(); });
  expect(location.hash).toBe('#settings');
  expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
});

function settingsServer() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/settings/projects') return Response.json({
      initialized: true, tracked: [], outsideRoots: { claudeSessions: 0, codexSessions: 0, folders: [] }, roots: ['/r'], builtAt: null, codexSessionsFound: true,
      candidates: [{ key: 'other', path: '/r/other', exists: true, git: true, remote: null, claudeSessions: 1, codexSessions: 0, lastActivity: null, tracked: false, excluded: false, aliasOf: null, hasData: false, inScope: false }],
    });
    return Response.json([]);
  }));
}

test('leaving Settings with an unsaved selection asks first in a dialog, from the sidebar or a link', async () => {
  const { fireEvent } = await import('@testing-library/react');
  settingsServer();
  location.hash = '#settings';
  const browserConfirm = vi.spyOn(window, 'confirm');
  try {
    render(<App />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'read other' }));
    await act(async () => { screen.getByRole('button', { name: 'Inbox' }).click(); });
    const ask = await screen.findByRole('alertdialog', { name: /leave without saving/i });
    expect(ask.textContent).toContain('Your folder selection is not saved.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect((screen.getByRole('checkbox', { name: 'read other' }) as HTMLInputElement).checked).toBe(true);

    await act(async () => {
      location.hash = 'activity';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    // The address goes back at once; the page stays until you answer.
    expect(location.hash).toBe('#settings');
    fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(location.hash).toBe('#settings');

    // Closing or reloading the tab asks the browser to warn too.
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await act(async () => { screen.getByRole('button', { name: 'Inbox' }).click(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page'));
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(browserConfirm).not.toHaveBeenCalled();
  } finally {
    browserConfirm.mockRestore();
  }
});

test('with nothing unsaved, moving between pages never asks', async () => {
  render(<App />);
  await act(async () => { screen.getByRole('button', { name: 'Settings' }).click(); });
  await act(async () => { screen.getByRole('button', { name: 'Inbox' }).click(); });
  expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('a write the API cannot take (restarting) shows a banner while it retries, and a plain alert if it gives up', async () => {
  const { NETWORK_EVENT } = await import('./api.ts');
  const say = (detail: object) => act(async () => { window.dispatchEvent(new CustomEvent(NETWORK_EVENT, { detail })); });
  render(<App />);
  await say({ state: 'retrying', attempt: 1, of: 4 });
  expect(screen.getByRole('status', { name: 'connection' }).textContent).toMatch(/reconnecting to the API: retrying your last change \(1 of 4\)/i);
  await say({ state: 'ok' });
  expect(screen.queryByRole('status', { name: 'connection' })).toBeNull();
  await say({ state: 'failed' });
  const alert = screen.getByRole('alert', { name: 'connection' });
  expect(alert.textContent).toMatch(/was not saved/);
  await act(async () => { within(alert).getByRole('button', { name: 'Dismiss' }).click(); });
  expect(screen.queryByRole('alert', { name: 'connection' })).toBeNull();
});

test('the first-run panel shows on an empty Inbox, Lessons and Graph, not on other pages or with nothing selected', async () => {
  const pipeline = { stage: { name: 'ingest', startedAt: new Date().toISOString(), current: null }, progress: { done: 4, total: null }, sessions: 3, classify: { backlog: 10, capped: false }, inbox: { pending: 0, confirmed: 0 }, postmortems: { queued: 0 }, lessons: { proposed: 0, approved: 0 }, scans: { done: 0, queued: 0, running: 0, failed: 0, never: 2 } };
  const status = (tracked: number) => ({ version: '0.4.5', graph: true, worker: null, workerHealthy: true, authRequired: false, selection: { initialized: true, tracked, roots: 1, note: tracked ? null : 'none' } });
  let tracked = 2;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/pipeline') return Response.json(pipeline);
    if (url === '/api/status') return Response.json(status(tracked));
    if (url === '/api/session') return Response.json({ authRequired: false, authenticated: true });
    return Response.json([]);
  }));
  location.hash = '#inbox';
  render(<App />);
  expect(await screen.findByRole('region', { name: 'pipeline' })).toBeTruthy();
  await act(async () => { screen.getByRole('button', { name: 'Lessons' }).click(); });
  expect(await screen.findByRole('region', { name: 'pipeline' })).toBeTruthy();
  await act(async () => { screen.getByRole('button', { name: 'Activity' }).click(); });
  expect(screen.queryByRole('region', { name: 'pipeline' })).toBeNull();
  cleanup();
  tracked = 0;
  render(<App />);
  await screen.findByRole('status', { name: 'no projects selected' });
  expect(screen.queryByRole('region', { name: 'pipeline' })).toBeNull();
});

test('the header tooltip says what the worker is doing, and since when a model has been down', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/session') return Response.json({ authRequired: false, authenticated: true });
    if (url === '/api/status') return Response.json({
      version: '0.4.5', graph: true, worker: { version: '0.4.5', lastBeat: new Date().toISOString() }, workerHealthy: true, authRequired: false, selection: { initialized: true, tracked: 1, roots: 1, note: null },
      models: { classify: { provider: 'ollama:gemma4', ok: false, reason: 'timed out', since: '2026-10-24T10:00:00Z', checkedAt: '2026-10-24T10:05:00Z' } },
      stage: { name: 'scan', startedAt: new Date().toISOString(), current: 'demo-shop' }, progress: null,
    });
    return Response.json([]);
  }));
  render(<App />);
  const badge = await screen.findByText(/classifier unavailable/i);
  const title = badge.closest('[title]')?.getAttribute('title') ?? '';
  expect(title).toMatch(/ollama:gemma4: timed out \(since /);
  expect(title).toMatch(/now: Scanning a project, for \d+s \(demo-shop\)/);
});


test('the application exposes one main landmark and a keyboard skip link', async () => {
  render(<App />);
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe('#main-content');
});

test('a tokenless install reached through Docker says it is read-only, how to fix it, and disables owner controls', async () => {
  server({ ownerWrites: false });
  const { Button } = await import('./ui/controls.tsx');
  const { OwnerWrites } = await import('./ownerAccess.tsx');
  render(<App />);
  const banner = await screen.findByRole('status', { name: 'read-only' });
  expect(banner.textContent).toMatch(/Read-only: this install has no owner token/);
  expect(banner.textContent).toContain('./scripts/setup.sh --yes --enable-auth');
  cleanup();
  render(<OwnerWrites.Provider value={false}><Button owner>Approve</Button><Button>Clear filters</Button></OwnerWrites.Provider>);
  const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  expect(approve.title).toMatch(/--yes --enable-auth/);
  expect((screen.getByRole('button', { name: 'Clear filters' }) as HTMLButtonElement).disabled).toBe(false);
});

test('an install with owner access shows no read-only banner', async () => {
  server({});
  render(<App />);
  await act(async () => {});
  expect(screen.queryByRole('status', { name: 'read-only' })).toBeNull();
});

test('signing in from a tab opened while the install was tokenless drops the read-only state without a reload', async () => {
  const { fireEvent } = await import('@testing-library/react');
  const { SIGN_IN_EVENT } = await import('./api.ts');
  // The tab opens on a tokenless install; setup --enable-auth then adds tokens while it stays open.
  let state = { authRequired: false, signedIn: false, ownerWrites: false };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session' && init?.method === 'POST') { state = { ...state, signedIn: true }; return new Response(null, { status: 204 }); }
    if (url === '/api/session' && init?.method === 'DELETE') { state = { ...state, signedIn: false }; return new Response(null, { status: 204 }); }
    if (url === '/api/session') return Response.json({ authRequired: state.authRequired, authenticated: state.signedIn, ownerSession: state.authRequired && state.signedIn, ownerSetupRequired: false, ownerWrites: state.authRequired ? state.signedIn : state.ownerWrites });
    return Response.json([]);
  }));
  render(<App />);
  expect(await screen.findByRole('status', { name: 'read-only' })).toBeTruthy();
  state = { authRequired: true, signedIn: false, ownerWrites: false };
  await act(async () => { window.dispatchEvent(new Event(SIGN_IN_EVENT)); });
  fireEvent.change(await screen.findByLabelText('owner token'), { target: { value: 'owner' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('status', { name: 'read-only' })).toBeNull());
});

/** An install whose tokens and this browser's session change while the tab stays open. */
function changingServer(initial: { authRequired: boolean; signedIn: boolean; ownerWrites: boolean }) {
  const state = { ...initial, sessionReply: null as Promise<void> | null };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session' && init?.method === 'POST') { state.signedIn = true; return new Response(null, { status: 204 }); }
    if (url === '/api/session' && init?.method === 'DELETE') { state.signedIn = false; return new Response(null, { status: 204 }); }
    if (url === '/api/session') {
      if (state.sessionReply) await state.sessionReply;
      return Response.json({ authRequired: state.authRequired, authenticated: state.signedIn, ownerSession: state.authRequired && state.signedIn, ownerSetupRequired: false, ownerWrites: state.authRequired ? state.signedIn : state.ownerWrites });
    }
    if (state.authRequired && !state.signedIn) return Response.json({ error: 'sign in required' }, { status: 401 });
    if (url === '/api/status') return Response.json({ version: '0.2.0', graph: true, worker: null, workerHealthy: true, authRequired: state.authRequired, selection: null, models: null, ollama: null });
    return Response.json([]);
  }));
  return state;
}

test('a read-only tab follows a sign-in made elsewhere at its next status poll, without ever getting a 401', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const state = changingServer({ authRequired: false, signedIn: false, ownerWrites: false });
    render(<App />);
    expect(await screen.findByRole('status', { name: 'read-only' })).toBeTruthy();
    // setup --enable-auth, then another tab signs this browser in: this tab's cookie is valid, so nothing answers it 401.
    Object.assign(state, { authRequired: true, signedIn: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'read-only' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

test('a tab shown again reads the session: an install that lost its tokens turns read-only, one that gained them asks to sign in', async () => {
  const state = changingServer({ authRequired: true, signedIn: true, ownerWrites: true });
  render(<App />);
  expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
  expect(screen.queryByRole('status', { name: 'read-only' })).toBeNull();
  Object.assign(state, { authRequired: false, signedIn: false, ownerWrites: false });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(await screen.findByRole('status', { name: 'read-only' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  Object.assign(state, { authRequired: true });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(await screen.findByLabelText('owner token')).toBeTruthy();
});

test('signing in never shows the read-only banner, even before the session is read again', async () => {
  const { fireEvent } = await import('@testing-library/react');
  const { SIGN_IN_EVENT } = await import('./api.ts');
  const state = changingServer({ authRequired: false, signedIn: false, ownerWrites: false });
  render(<App />);
  expect(await screen.findByRole('status', { name: 'read-only' })).toBeTruthy();
  Object.assign(state, { authRequired: true });
  await act(async () => { window.dispatchEvent(new Event(SIGN_IN_EVENT)); });
  let answer!: () => void;
  state.sessionReply = new Promise((r) => { answer = r; });
  fireEvent.change(await screen.findByLabelText('owner token'), { target: { value: 'owner' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
  expect(screen.queryByRole('status', { name: 'read-only' })).toBeNull();
  await act(async () => { answer(); });
  expect(screen.queryByRole('status', { name: 'read-only' })).toBeNull();
});

test('Decisions sits under Review with the proposals waiting as a badge, Learning loop under Insights; a decision made here counts again', async () => {
  const { LOOP_CHANGED_EVENT } = await import('./api.ts');
  const { loopState } = await import('./testing/loop.ts');
  let proposed = 3;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/loop' ? Response.json(loopState({ counts: { proposed, week: { observed: 0, proposed: 0, applied: 0, rolledBack: 0 } } })) : Response.json([]))));
  render(<App />);
  const decisions = screen.getByRole('button', { name: /^Decisions/ });
  await waitFor(() => expect(decisions.textContent).toBe('Decisions3 waiting'));
  proposed = 0;
  await act(async () => { window.dispatchEvent(new Event(LOOP_CHANGED_EVENT)); });
  await waitFor(() => expect(decisions.textContent).toBe('Decisions'));
  const labels = screen.getAllByRole('button').map((b) => b.textContent);
  expect(labels.indexOf('Lessons')).toBeLessThan(labels.indexOf('Decisions'));
  expect(labels.indexOf('Learning loop')).toBeLessThan(labels.indexOf('Graph'));
  await act(async () => { screen.getByRole('button', { name: 'Learning loop' }).click(); });
  expect(screen.getByRole('heading', { name: 'Learning loop', level: 1 })).toBeTruthy();
  expect(location.hash).toBe('#loop');
});
