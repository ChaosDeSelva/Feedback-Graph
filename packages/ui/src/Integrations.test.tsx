import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { IntegrationsView, ServiceView } from './api.ts';
import { ConnectionsBadge } from './Connections.tsx';
import { Integrations } from './Integrations.tsx';

const svc = (o: Partial<ServiceView> = {}): ServiceView => ({
  connection: { state: 'not_connected', source: null, detail: 'Not connected: paste a token in Settings or set GITHUB_TOKEN in .env.', href: '#settings/integrations-github' },
  envSet: false, envVar: 'GITHUB_TOKEN', savedInApp: false, account: null, checkedAt: null, lastSyncAt: null, lastError: null, errorKind: null, rateLimitedUntil: null, ...o,
});
const connected = (o: Partial<ServiceView> = {}) => svc({ connection: { state: 'connected', source: 'app', detail: 'Connected as octo; last sync just now.', href: '#settings/integrations-github' }, savedInApp: true, account: 'octo', lastSyncAt: new Date().toISOString(), ...o });

function view(o: Partial<IntegrationsView> = {}): IntegrationsView {
  return {
    canSave: true, syncMinutes: 10,
    github: svc(),
    linear: svc({ envVar: 'LINEAR_API_KEY', connection: { state: 'not_connected', source: null, detail: 'Not connected.', href: '#settings/integrations-linear' } }),
    projects: [
      { key: 'shop', github: { repo: 'acme/shop', from: 'remote', enabled: true, lastSyncAt: null, items: 0, error: null, backlog: null }, linear: { teamId: null, teamName: null, lastSyncAt: null, items: 0, error: null } },
      { key: 'notes', github: { repo: null, from: null, enabled: true, lastSyncAt: null, items: 0, error: null, backlog: null }, linear: { teamId: null, teamName: null, lastSyncAt: null, items: 0, error: null } },
    ],
    ...o,
  };
}

let state: IntegrationsView;
let calls: { url: string; method: string; body?: any }[];
let reject: string | null;

beforeEach(() => {
  state = view();
  calls = [];
  reject = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    if (url === '/api/settings/integrations') return Response.json(state);
    if (url === '/api/settings/integrations/github' && method === 'PUT') {
      if (reject) return Response.json({ error: reject }, { status: 400 });
      state = view({ github: connected() });
      return Response.json(state);
    }
    if (url === '/api/settings/integrations/github' && method === 'DELETE') {
      state = view();
      return Response.json(state);
    }
    if (url === '/api/settings/integrations/github/test') return Response.json({ ok: true, account: 'octo', error: null, view: state });
    if (url === '/api/settings/integrations/linear/teams') return Response.json([{ id: 't1', key: 'WEB', name: 'Web' }]);
    if (url.startsWith('/api/settings/integrations/projects/')) {
      state = { ...state, projects: state.projects.map((p) => (url.endsWith(p.key) ? { ...p, github: { ...p.github, enabled: body.github ?? p.github.enabled }, linear: { ...p.linear, teamId: body.linearTeamId ?? p.linear.teamId, teamName: body.linearTeamName ?? p.linear.teamName } } : p)) };
      return Response.json(state);
    }
    if (url === '/api/status') return Response.json({ connections: null });
    return Response.json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const card = async (name: string) => screen.findByRole('region', { name });

test('not connected: explains the token scopes with a link to create one, and each project shows its repository', async () => {
  render(<Integrations />);
  const gh = await card('GitHub');
  expect(within(gh).getByText('not connected')).toBeTruthy();
  expect(within(gh).getByRole('link', { name: 'fine-grained personal access token' }).getAttribute('href')).toBe('https://github.com/settings/personal-access-tokens/new');
  expect(within(gh).getAllByText('Read-only').length).toBeGreaterThan(0);
  const lin = await card('Linear');
  expect(within(lin).getByRole('link', { name: /Security and access/ }).getAttribute('href')).toBe('https://linear.app/settings/account/security');
  expect(screen.getByText('acme/shop')).toBeTruthy();
  expect(screen.getByText('no github.com remote')).toBeTruthy();
});

test('a project whose PR sync hit its cap says which pull requests are still to be read', async () => {
  const base = view();
  state = view({
    github: connected(),
    projects: [{ ...base.projects[0], github: { ...base.projects[0].github, lastSyncAt: new Date().toISOString(), items: 3, backlog: { since: '2026-10-01T00:00:00Z', until: '2026-10-21T00:00:00Z' } } }, base.projects[1]],
  });
  render(<Integrations />);
  expect(await screen.findByText(/catching up: pull requests updated 2026-10-01 to 2026-10-21 are read on the next syncs/)).toBeTruthy();
});

test('connecting sends the token once, clears the field and shows the account', async () => {
  render(<Integrations />);
  const gh = await card('GitHub');
  const input = within(gh).getByLabelText('GitHub token') as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: 'github_pat_secret_value' } });
  fireEvent.click(within(gh).getByRole('button', { name: 'Connect' }));
  expect(await within(gh).findByText('Connected as octo.')).toBeTruthy();
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ token: 'github_pat_secret_value' });
  expect(within(gh).getByText('connected')).toBeTruthy();
  expect(within(gh).queryByLabelText('GitHub token')).toBeNull();
});

test('a refused token shows why and stays unsaved', async () => {
  reject = 'GitHub did not accept this token, so it was not saved: github 401';
  render(<Integrations />);
  const gh = await card('GitHub');
  fireEvent.change(within(gh).getByLabelText('GitHub token'), { target: { value: 'bad-token-123' } });
  fireEvent.click(within(gh).getByRole('button', { name: 'Connect' }));
  expect(await within(gh).findByText(/did not accept this token/)).toBeTruthy();
  expect(within(gh).getByText('not connected')).toBeTruthy();
});

test('Test connection reports the result; Disconnect asks first', async () => {
  state = view({ github: connected() });
  render(<Integrations />);
  const gh = await card('GitHub');
  fireEvent.click(within(gh).getByRole('button', { name: 'Test connection' }));
  expect(await within(gh).findByText('Works: GitHub answered as octo.')).toBeTruthy();
  fireEvent.click(within(gh).getByRole('button', { name: 'Disconnect' }));
  const confirm = await screen.findByRole('alertdialog', { name: 'Disconnect GitHub?' });
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Disconnect GitHub' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  expect(await within(gh).findByText(/Disconnected/)).toBeTruthy();
});

test('a token in .env is shown as set in .env and can be replaced here (a saved token wins), not disconnected', async () => {
  state = view({ github: connected({ envSet: true, savedInApp: false, connection: { state: 'connected', source: 'env', detail: 'Connected as octo (set in .env).', href: '' } }) });
  render(<Integrations />);
  const gh = await card('GitHub');
  expect(within(gh).getByText('set in .env')).toBeTruthy();
  expect(within(gh).queryByRole('button', { name: 'Disconnect' })).toBeNull();
  fireEvent.click(within(gh).getByRole('button', { name: 'Replace token' }));
  expect(within(gh).getByText(/wins over GITHUB_TOKEN in \.env/)).toBeTruthy();
});

test('a token saved here while .env also sets one can be disconnected, falling back to .env', async () => {
  state = view({ github: connected({ envSet: true, savedInApp: true }) });
  render(<Integrations />);
  const gh = await card('GitHub');
  expect(within(gh).getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  expect(within(gh).getByText(/Disconnecting goes back to GITHUB_TOKEN in \.env/)).toBeTruthy();
});

test('the account shows when it was checked; a token not checked yet says it is checked on its own', async () => {
  state = view({ github: connected({ checkedAt: new Date(Date.now() - 5 * 60_000).toISOString() }), linear: connected({ envVar: 'LINEAR_API_KEY', account: null, checkedAt: null }) });
  render(<Integrations />);
  expect((await screen.findByText('5m ago')).parentElement!.textContent).toMatch(/checked 5m ago/);
  expect(screen.getByText(/being checked: it is checked on first use/)).toBeTruthy();
});

test('a revoked token is an error with the token field back to replace it', async () => {
  state = view({ github: connected({ errorKind: 'auth', connection: { state: 'error', source: 'app', detail: 'GitHub rejected the token (revoked, expired or missing access). Syncing is paused until you replace it.', href: '' } }) });
  render(<Integrations />);
  const gh = await card('GitHub');
  expect(within(gh).getByText('error')).toBeTruthy();
  expect(within(gh).getByText(/Syncing is paused until you replace it/)).toBeTruthy();
  expect(within(gh).getByLabelText('GitHub token')).toBeTruthy();
});

test('per project: turn GitHub off, and pick a Linear team once Linear is connected', async () => {
  state = view({ github: connected(), linear: connected({ envVar: 'LINEAR_API_KEY', account: 'Pat' }) });
  render(<Integrations />);
  fireEvent.click(await screen.findByLabelText('read pull request comments of shop'));
  await waitFor(() => expect(calls.find((c) => c.url === '/api/settings/integrations/projects/shop')?.body).toEqual({ github: false }));
  const select = await screen.findByLabelText('Linear team of shop');
  await within(select).findByText('Web (WEB)');
  fireEvent.change(select, { target: { value: 't1' } });
  await waitFor(() => expect(calls.filter((c) => c.url === '/api/settings/integrations/projects/shop').at(-1)?.body).toEqual({ linearTeamId: 't1', linearTeamName: 'Web' }));
});

test('the sidebar indicator shows a dot per connection, names problems, and lists reasons with links', () => {
  const c = (state: 'connected' | 'error' | 'not_connected', detail: string, href = '#settings/connections') => ({ state, source: null, detail, href });
  render(
    <ConnectionsBadge
      connections={{
        github: c('error', 'GitHub rejected the token', '#settings/integrations-github'),
        linear: c('not_connected', 'Not connected.', '#settings/integrations-linear'),
        claude: c('connected', 'Claude runs: postmortem.'),
        codex: c('not_connected', 'No job uses Codex.'),
        ollama: c('connected', 'Ollama answers.'),
        cloud: c('not_connected', 'Cloud sync is off.'),
      }}
    />,
  );
  const button = screen.getByRole('button', { name: /Connections: GitHub has a problem/ });
  fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: 'Connections' });
  expect(within(dialog).getByText('GitHub rejected the token')).toBeTruthy();
  expect(within(dialog).getByText('GitHub').closest('a')?.getAttribute('href')).toBe('#settings/integrations-github');
  expect(within(dialog).getAllByRole('link')).toHaveLength(6);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('with everything fine the indicator counts what is connected', () => {
  const ok = { state: 'connected' as const, source: 'env' as const, detail: 'fine', href: '#' };
  const off = { state: 'not_connected' as const, source: null, detail: 'off', href: '#' };
  render(<ConnectionsBadge connections={{ github: ok, linear: off, claude: ok, codex: off, ollama: ok, cloud: off }} />);
  expect(screen.getByRole('button', { name: 'Connections: 3 of 6 connected' })).toBeTruthy();
});

const ISO = /\d{4}-\d\d-\d\dT\d\d:/;

test('hover titles on times are in words, never the ISO string', async () => {
  const at = '2026-10-26T08:34:00.000Z';
  state = view({
    github: connected({ checkedAt: at, lastSyncAt: at }),
    projects: [{ ...view().projects[0], github: { ...view().projects[0].github, lastSyncAt: at, items: 3 } }],
  });
  render(<Integrations />);
  await card('GitHub');
  await screen.findByText(/3 comments/);
  const titled = [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title')!);
  expect(titled.filter((t) => ISO.test(t))).toEqual([]);
  expect(document.querySelectorAll(`time[datetime="${at}"]`).length).toBeGreaterThanOrEqual(3);
});

test('Linear connected with no team mapped says to map a team to start syncing, not "not synced yet"', async () => {
  state = view({ linear: connected({ envVar: 'LINEAR_API_KEY', account: 'me', lastSyncAt: null, connection: { state: 'connected', source: 'app', detail: 'Connected.', href: '#settings/integrations-linear' } }) });
  render(<Integrations />);
  const linear = within(await card('Linear'));
  expect(linear.getByText(/map a team to a project below to start syncing/i)).toBeTruthy();
  expect(linear.queryByText(/not yet: the worker syncs/)).toBeNull();
});
