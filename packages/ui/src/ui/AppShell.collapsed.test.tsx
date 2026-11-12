import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppShell, type NavGroup } from './AppShell.tsx';

type K = 'inbox' | 'lessons';
const groups: NavGroup<K>[] = [{ label: 'Review', items: [{ key: 'inbox', label: 'Inbox', icon: null }, { key: 'lessons', label: 'Lessons', icon: null }] }];
const health = { ok: false, label: 'Worker down', version: '0.7.6', title: 'no heartbeat for 5 minutes' };

/** jsdom under this Node has no Web Storage; the sidebar's preference needs one. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } as Storage;
}
beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function shell(o: { onSignOut?: () => void } = {}) {
  const connections = vi.fn((collapsed: boolean) => <span>{collapsed ? 'icons only' : 'connections in full'}</span>);
  render(
    <AppShell groups={groups} current="inbox" onNavigate={() => {}} health={health} connections={connections} onSignOut={o.onSignOut}>
      <button type="button">page button</button>
    </AppShell>,
  );
  return { connections };
}

test('a sidebar collapsed last time opens collapsed: page buttons carry their names as tooltips, and expanding is remembered', () => {
  localStorage.setItem('fg:sidebar-collapsed', '1');
  const onSignOut = vi.fn();
  shell({ onSignOut });
  expect(screen.getByRole('button', { name: 'Lessons' }).getAttribute('title')).toBe('Lessons');
  expect(screen.getByText('icons only')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(onSignOut).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
  expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Lessons' }).getAttribute('title')).toBeNull();
  expect(screen.getByText('connections in full')).toBeTruthy();
  expect(localStorage.getItem('fg:sidebar-collapsed')).toBe('0');
});

test('the theme button switches between dark and light and says which one it goes to', () => {
  shell();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy();
});

test('with the phone menu open, Tab from the page behind it brings focus into the menu', async () => {
  const user = userEvent.setup();
  shell();
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  screen.getByRole('button', { name: 'page button' }).focus();
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close menu' }));
});

test('Tab in the phone menu wraps past controls the breakpoint hides', async () => {
  // jsdom has no layout; a browser reports the wide-screen-only Collapse button as not visible on a phone.
  HTMLElement.prototype.checkVisibility = function (this: HTMLElement) { return this.getAttribute('aria-label') !== 'Collapse sidebar'; };
  try {
    const user = userEvent.setup();
    shell();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const theme = screen.getByRole('button', { name: 'Switch to dark theme' });
    theme.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close menu' }));
  } finally {
    delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
  }
});
