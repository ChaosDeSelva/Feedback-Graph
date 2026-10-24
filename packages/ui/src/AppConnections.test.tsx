import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './App.tsx';

const c = (state: string, detail: string) => ({ state, source: null, detail, href: '#settings/connections' });

beforeEach(() => {
  location.hash = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/session') return Response.json({ authRequired: false, authenticated: true });
    if (url === '/api/status') {
      return Response.json({
        version: '0.4.2', graph: true, worker: null, workerHealthy: true, authRequired: false, selection: null, models: null, ollama: null,
        connections: { github: c('connected', 'Connected as octo'), linear: c('error', 'Linear rejected the token'), claude: c('connected', 'ok'), codex: c('not_connected', 'off'), ollama: c('connected', 'ok'), cloud: c('not_connected', 'off') },
      });
    }
    return Response.json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('the sidebar shows every connection from /api/status next to the health badge', async () => {
  render(<App />);
  expect(await screen.findByRole('button', { name: 'Connections: Linear has a problem' })).toBeTruthy();
});
