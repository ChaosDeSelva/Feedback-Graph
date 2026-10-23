import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App.tsx';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => Response.json([]))); location.hash = ''; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('changing the URL hash (links, back button) switches the page', async () => {
  render(<App />);
  expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
  await act(async () => {
    location.hash = 'activity';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.getByRole('button', { name: 'Activity' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBeNull();
});

test('a link to one item (#lessons/<id>) opens its page and keeps the id in the hash', async () => {
  location.hash = '#lessons/l1';
  render(<App />);
  expect(screen.getByRole('button', { name: 'Lessons' }).getAttribute('aria-current')).toBe('page');
  await act(async () => {});
  expect(location.hash).toBe('#lessons/l1');
});

function server(o: { authRequired?: boolean; token?: string; workerHealthy?: boolean; tracked?: number; models?: object; ollama?: object }) {
  let signedIn = !o.authRequired;
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session' && init?.method === 'POST') {
      const { token } = JSON.parse(String(init.body));
      posts.push(token);
      if (token !== o.token) return Response.json({ error: 'wrong token' }, { status: 401 });
      signedIn = true;
      return new Response(null, { status: 204 });
    }
    if (url === '/api/session') return Response.json({ authRequired: !!o.authRequired, authenticated: signedIn });
    if (!signedIn) return Response.json({ error: 'sign in required' }, { status: 401 });
    if (url === '/api/status') return Response.json({ version: '0.2.0', graph: true, worker: null, workerHealthy: o.workerHealthy ?? true, authRequired: !!o.authRequired, selection: o.tracked === undefined ? null : { initialized: true, tracked: o.tracked, note: o.tracked ? null : 'No projects are selected yet, so no sessions are being read.' }, models: o.models ?? null, ollama: o.ollama ?? null });
    return Response.json([]);
  }));
  return { posts };
}

test('with a token configured, the UI asks you to sign in first', async () => {
  const { fireEvent } = await import('@testing-library/react');
  const s = server({ authRequired: true, token: 'secret-token' });
  render(<App />);
  const input = await screen.findByLabelText('access token');
  fireEvent.change(input, { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('wrong token')).toBeTruthy();
  fireEvent.change(input, { target: { value: 'secret-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('button', { name: 'Inbox' })).toBeTruthy();
  expect(s.posts).toEqual(['wrong', 'secret-token']);
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
  expect(screen.getByText('get_task_context')).toBeTruthy();
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
      initialized: true, tracked: [], outsideRoots: { claudeSessions: 0, codexSessions: 0 }, roots: ['/r'], builtAt: null, codexSessionsFound: true,
      candidates: [{ key: 'other', path: '/r/other', exists: true, git: true, remote: null, claudeSessions: 1, codexSessions: 0, lastActivity: null, tracked: false, excluded: false, aliasOf: null, hasData: false, inScope: false }],
    });
    return Response.json([]);
  }));
}

test('leaving Settings with an unsaved selection asks first, from the sidebar or a link', async () => {
  const { fireEvent } = await import('@testing-library/react');
  settingsServer();
  location.hash = '#settings';
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    render(<App />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'read other' }));
    await act(async () => { screen.getByRole('button', { name: 'Inbox' }).click(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect((screen.getByRole('checkbox', { name: 'read other' }) as HTMLInputElement).checked).toBe(true);

    await act(async () => {
      location.hash = 'activity';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(location.hash).toBe('#settings');

    // Closing or reloading the tab asks the browser to warn too.
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    confirm.mockReturnValue(true);
    await act(async () => { screen.getByRole('button', { name: 'Inbox' }).click(); });
    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  } finally {
    confirm.mockRestore();
  }
});

test('with nothing unsaved, moving between pages never asks', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    render(<App />);
    await act(async () => { screen.getByRole('button', { name: 'Settings' }).click(); });
    await act(async () => { screen.getByRole('button', { name: 'Inbox' }).click(); });
    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
    expect(confirm).not.toHaveBeenCalled();
  } finally {
    confirm.mockRestore();
  }
});
