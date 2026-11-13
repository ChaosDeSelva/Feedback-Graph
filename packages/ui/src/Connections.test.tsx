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

test('a cloud sync problem stays inside the sidebar: the label truncates with the whole of it as the tooltip, and collapsed the six dots go two to a row', () => {
  const long = 'the cloud rejected the bundle (422): ' + 'facts.39.kind: Invalid enum value; '.repeat(12).trim();
  const broken = { ...all, github: c('connected', 'env', 'ok'), linear: c('connected', 'app', 'ok'), cloud: c('error', 'env', long) };
  const { rerender } = render(<ConnectionsBadge connections={broken} />);
  const badge = screen.getByRole('button', { name: 'Connections: Cloud sync has a problem' });
  expect(badge.getAttribute('title')).toBe('Cloud sync has a problem');
  expect(badge.className).toMatch(/\bmin-w-0\b.*\boverflow-hidden\b/);
  expect(within(badge).getByText('Cloud sync has a problem').className).toMatch(/\btruncate\b/);
  fireEvent.click(badge);
  expect(within(screen.getByRole('dialog', { name: 'Connections' })).getByText(long).className).toContain('[overflow-wrap:anywhere]');
  rerender(<ConnectionsBadge connections={broken} collapsed />);
  const dots = badge.querySelector('[aria-hidden="true"]')!;
  expect(dots.children).toHaveLength(6);
  expect(dots.className).toContain('md:grid-cols-2');
});

test('a Codex runner no job uses is listed as not used, naming the scan model, and is not counted as missing', () => {
  const unused: Connection = { state: 'not_connected', source: null, unused: true, detail: 'Codex runner: not used (scans use claude-cli).', href: '#settings/connections' };
  const ok = { ...all, github: c('connected', 'env', 'ok'), linear: c('connected', 'app', 'ok'), cloud: c('connected', 'env', 'ok'), codex: unused };
  render(<ConnectionsBadge connections={ok} />);
  const badge = screen.getByRole('button', { name: 'Connections: 5 of 5 connected' });
  expect(badge.className).not.toContain('bg-bad-soft');
  fireEvent.click(badge);
  const runner = within(screen.getByRole('dialog', { name: 'Connections' })).getByRole('link', { name: /Codex runner/ });
  expect(runner.textContent).toContain('not used');
  expect(runner.textContent).toContain('Codex runner: not used (scans use claude-cli).');
  expect(runner.textContent).not.toMatch(/not connected/);
});
