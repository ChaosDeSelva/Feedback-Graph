import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The theme keeps module state (the resolved theme and its listeners), so each test loads a fresh copy.
async function fresh() {
  vi.resetModules();
  const theme = await import('./theme.ts');
  const { AppShell } = await import('./AppShell.tsx');
  return { ...theme, AppShell };
}

/** A system colour-scheme query the test can flip, as the OS setting would. */
function systemScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = { matches: dark, addEventListener: (_: string, l: () => void) => listeners.add(l) };
  window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia;
  return { flip(next: boolean) { query.matches = next; listeners.forEach((l) => l()); } };
}

/** Storage that refuses every access, as in a private window with site data blocked. */
const blockedStorage = () => ({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } });

beforeEach(() => { delete document.documentElement.dataset.theme; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as { matchMedia?: unknown }).matchMedia; });

test('without a stored pick the page follows the system setting, live, and sets no override', async () => {
  const system = systemScheme(true);
  const { initTheme, useTheme } = await fresh();
  initTheme();
  function Probe() { return <span>{useTheme()}</span>; }
  render(<Probe />);
  expect(screen.getByText('dark')).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBeUndefined();
  act(() => system.flip(false));
  expect(screen.getByText('light')).toBeTruthy();
});

test('a stored pick wins over the system setting and is applied to the page', async () => {
  systemScheme(true);
  localStorage.setItem('fg:theme', 'light');
  const { initTheme, useTheme } = await fresh();
  initTheme();
  function Probe() { return <span>{useTheme()}</span>; }
  render(<Probe />);
  expect(screen.getByText('light')).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe('light');
});

test('an unknown stored value is ignored, and a page with no matchMedia starts light', async () => {
  localStorage.setItem('fg:theme', 'sepia');
  const { initTheme, useTheme } = await fresh();
  initTheme();
  function Probe() { return <span>{useTheme()}</span>; }
  render(<Probe />);
  expect(screen.getByText('light')).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

test('the sidebar theme switch flips the theme and remembers it for the next visit', async () => {
  systemScheme(false);
  const { initTheme, AppShell } = await fresh();
  initTheme();
  const user = userEvent.setup();
  render(<AppShell groups={[]} current="x" onNavigate={() => {}} health={null}><p>page</p></AppShell>);
  await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem('fg:theme')).toBe('dark');
  await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem('fg:theme')).toBe('light');
});

test('with storage blocked the switch still applies for this visit, and preferences fall back quietly', async () => {
  systemScheme(false);
  const { initTheme, AppShell, loadPref, savePref } = await fresh();
  vi.stubGlobal('localStorage', blockedStorage());
  initTheme();
  const user = userEvent.setup();
  render(<AppShell groups={[]} current="x" onNavigate={() => {}} health={null}><p>page</p></AppShell>);
  await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeTruthy();
  expect(loadPref('fg:sidebar')).toBeNull();
  expect(() => savePref('fg:sidebar', '1')).not.toThrow();
});

test('readToken returns the resolved CSS colour, or the fallback when the variable is unset', async () => {
  const { readToken } = await fresh();
  document.documentElement.style.setProperty('--color-surface', ' #fafafa ');
  expect(readToken('surface', 'white')).toBe('#fafafa');
  expect(readToken('missing', 'gray')).toBe('gray');
  document.documentElement.style.removeProperty('--color-surface');
});

test('a collapsed sidebar stays collapsed on the next visit', async () => {
  const { AppShell } = await fresh();
  const user = userEvent.setup();
  const shell = () => render(<AppShell groups={[]} current="x" onNavigate={() => {}} health={null}><p>page</p></AppShell>);
  shell();
  await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
  cleanup();
  shell();
  expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
});
