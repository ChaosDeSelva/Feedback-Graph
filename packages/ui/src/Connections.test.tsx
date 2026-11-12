import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { Connection } from './api.ts';
import { ConnectionsBadge } from './Connections.tsx';

afterEach(cleanup);

const c = (state: Connection['state'], source: Connection['source'], detail: string): Connection => ({ state, source, detail, href: '#settings/connections' });
const all = {
  github: c('error', 'env', 'GitHub rejected the token'),
  linear: c('error', 'app', 'Linear rejected the key'),
  claude: c('connected', null, 'signed in'),
  codex: c('not_connected', null, 'off'),
  ollama: c('connected', null, 'ok'),
  cloud: c('not_connected', null, 'off'),
};

test('two broken connections are named together, and the list says where each token was set', () => {
  render(<ConnectionsBadge connections={all} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connections: GitHub, Linear have a problem' }));
  const list = screen.getByRole('dialog', { name: 'Connections' });
  expect(within(list).getByRole('link', { name: /GitHub/ }).textContent).toContain('error · .env');
  expect(within(list).getByRole('link', { name: /Linear/ }).textContent).toContain('error · app');
  expect(within(list).getByRole('link', { name: /Claude/ }).textContent).toContain('connected');
});

test('the list closes on Escape, on a click outside it, and when one of its links is followed; a click inside keeps it', () => {
  render(<div><button type="button">elsewhere</button><ConnectionsBadge connections={all} collapsed /></div>);
  const badge = screen.getByRole('button', { name: /^Connections:/ });
  fireEvent.click(badge);
  fireEvent.keyDown(document, { key: 'Enter' });
  fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Connections' }));
  expect(screen.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(badge);
  fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(badge);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Codex/ }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a connection in a state this release does not know shows the state as stored, with a neutral dot', () => {
  render(<ConnectionsBadge connections={{ ...all, github: c('paused' as never, null, 'paused by the owner') }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connections: Linear has a problem' }));
  const github = within(screen.getByRole('dialog', { name: 'Connections' })).getByRole('link', { name: /GitHub/ });
  expect(github.textContent).toContain('paused');
  expect(github.querySelector('[aria-hidden="true"]')!.className).toContain('bg-faint');
});
