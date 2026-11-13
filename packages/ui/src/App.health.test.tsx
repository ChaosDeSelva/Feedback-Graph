import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); location.hash = ''; });

/** The app over an API whose /api/status is `status`. */
function withStatus(status: object) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/session') return Response.json({ authRequired: false, authenticated: true, ownerSession: false, ownerWrites: true });
    if (url === '/api/status') return Response.json({ version: '0.7.6', graph: true, worker: null, workerHealthy: true, authRequired: false, selection: { initialized: true, tracked: 1, roots: 1, note: null }, models: null, ollama: null, ...status });
    return Response.json([]);
  }));
  render(<App />);
}
const titleOf = async (label: RegExp) => (await screen.findByText(label)).closest('[title]')!.getAttribute('title')!;

test('a model down for no stated reason says so, with when it was last tried', async () => {
  withStatus({ models: { scan: { provider: null, ok: false, reason: null, since: '2026-10-24T10:00:00Z', checkedAt: '2026-10-24T10:05:00Z' } } });
  const title = await titleOf(/scan model unavailable/);
  expect(title).toMatch(/^scan model unavailable: unknown reason \(since .*, last tried .*\)/);
  cleanup();
  withStatus({ models: { docs: { provider: 'ollama:llava', ok: false, reason: 'no vision', since: '2026-10-24T10:00:00Z' } } });
  expect(await titleOf(/docs reader unavailable/)).toMatch(/^docs reader unavailable: ollama:llava: no vision \(since [^,]*\)/);
});

test('an intake model that is down is named as the intake reader, with its model or the reason it could not be built', async () => {
  withStatus({ models: { intake: { provider: 'claude-cli', ok: false, reason: 'claude is not signed in' } } });
  expect(await titleOf(/intake reader unavailable/)).toMatch(/^intake reader unavailable: claude-cli: claude is not signed in/);
  expect(screen.queryByText(/^intake unavailable/)).toBeNull();
  cleanup();
  withStatus({ models: { intake: { provider: null, ok: false, reason: 'no intake model could be built (INTAKE_LLM, INTAKE_PROVIDER_ALLOW; see the worker log): intake sources wait' } } });
  expect(await titleOf(/intake reader unavailable/)).toMatch(/^intake reader unavailable: no intake model could be built \(INTAKE_LLM/);
  cleanup();
  withStatus({ models: { intake: { provider: 'codex-cli', ok: false, reason: 'sandbox failed', disabled: true } } });
  expect(await screen.findByText('Codex runner off: intake reading paused')).toBeTruthy();
});

test('Ollama without its model, or not answering with no reason, is named in the label with what needs it', async () => {
  withStatus({ ollama: { ok: false, url: 'http://ollama:11434', reason: 'model nomic-embed-text is not pulled' } });
  expect(await titleOf(/Ollama model missing/)).toMatch(/not pulled; search, get_task_context and check_before_done need it/);
  cleanup();
  withStatus({ ollama: { ok: false, url: 'http://ollama:11434', reason: null } });
  expect(await titleOf(/Ollama unreachable/)).toMatch(/^Ollama unreachable: Ollama at http:\/\/ollama:11434 is not answering;/);
});

test('an unreachable graph is the label; the worker line carries its last error', async () => {
  withStatus({ graph: false, worker: { version: '0.7.6', lastBeat: '2026-10-24T10:00:00Z', lastError: 'scan parked' } });
  expect(await titleOf(/graph unreachable/)).toMatch(/worker 0\.7\.6, last heartbeat .*, last error: scan parked/);
});

test('a model job this release does not know is named as the worker sent it', async () => {
  withStatus({ models: { rerank: { provider: null, ok: false, reason: 'gone', since: null } } });
  expect(await screen.findByText(/rerank unavailable/)).toBeTruthy();
});

test('a Codex runner turned off on purpose is one neutral line linking to the fix, not a red alarm; the version stays out of the pill', async () => {
  const reason = 'sandbox: nested sandbox startup failed';
  withStatus({
    models: { scan: { provider: 'codex-cli', ok: false, reason, disabled: true } },
    connections: { codex: { state: 'not_connected', source: 'env', detail: `Codex runner off: scans paused (${reason}).`, href: '#settings/connections' } },
  });
  const line = await screen.findByText('Codex runner off: scans paused');
  const pill = line.closest('a')!;
  expect(pill.getAttribute('href')).toBe('#settings/connections');
  expect(pill.getAttribute('title')).toContain(reason);
  expect(pill.getAttribute('title')).toMatch(/SCAN_LLM.*doctor\.sh/);
  expect(pill.className).not.toMatch(/bad/);
  expect(document.body.innerHTML).not.toMatch(/has a problem|scan model unavailable/);
  expect(pill.textContent).not.toContain('0.7.6');
  expect(screen.getByText('v0.7.6').closest('a,[title]')?.getAttribute('title')).toBe('Feedback Graph 0.7.6');
});

test('an unexpected runner failure next to it is still red', async () => {
  withStatus({ models: { scan: { provider: 'codex-cli', ok: false, reason: 'off', disabled: true }, postmortem: { provider: 'codex-cli', ok: false, reason: 'login expired' } } });
  const label = await screen.findByText('post-mortem model unavailable');
  expect(label.closest('[title]')!.className).toMatch(/bad/);
});
