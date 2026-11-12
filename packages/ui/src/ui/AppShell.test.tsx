import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AppShell, type NavGroup } from './AppShell.tsx';

type K = 'inbox' | 'lessons';
const groups: NavGroup<K>[] = [{ label: 'Review', items: [{ key: 'inbox', label: 'Inbox', icon: null }, { key: 'lessons', label: 'Lessons', icon: null }] }];

afterEach(() => { cleanup(); });

function shell(onNavigate = vi.fn()) {
  render(
    <AppShell groups={groups} current="inbox" onNavigate={onNavigate} health={null}>
      <button type="button">page button</button>
    </AppShell>,
  );
  return onNavigate;
}

test('the skip link is the first Tab stop and moves focus to the page', async () => {
  const user = userEvent.setup();
  shell();
  await user.tab();
  const skip = screen.getByRole('link', { name: 'Skip to main content' });
  expect(document.activeElement).toBe(skip);
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(document.getElementById('main-content'));
});

test('opening the phone menu moves focus into it, and Tab stays inside until it closes', async () => {
  const user = userEvent.setup();
  shell();
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inbox' }));
  for (let i = 0; i < 8; i++) {
    await user.tab();
    expect(document.activeElement?.textContent).not.toBe('page button');
  }
  for (let i = 0; i < 8; i++) {
    await user.tab({ shift: true });
    expect(document.activeElement?.textContent).not.toBe('page button');
  }
});

test('Escape closes the phone menu and gives focus back to the menu button', async () => {
  const user = userEvent.setup();
  shell();
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inbox' }));
  await user.keyboard('{Escape}');
  const menu = screen.getByRole('button', { name: 'Open menu' });
  expect(menu.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(menu);
});

test('picking a page from the phone menu closes it and gives focus back to the menu button', async () => {
  const user = userEvent.setup();
  const onNavigate = shell();
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  await user.click(screen.getByRole('button', { name: 'Lessons' }));
  expect(onNavigate).toHaveBeenCalledWith('lessons');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open menu' }));
});

test('a page with something waiting shows the count beside its label, and in the tooltip when the sidebar is collapsed', () => {
  const withBadge: NavGroup<K>[] = [{ label: 'Review', items: [{ key: 'inbox', label: 'Inbox', icon: null, badge: 4 }, { key: 'lessons', label: 'Lessons', icon: null, badge: 0 }] }];
  const { unmount } = render(<AppShell groups={withBadge} current="lessons" onNavigate={() => {}} health={null}><p>page</p></AppShell>);
  expect(screen.getByRole('button', { name: 'Inbox 4 waiting' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Lessons' }).title).toBe('');
  unmount();
  localStorage.setItem('fg:sidebar-collapsed', '1');
  render(<AppShell groups={withBadge} current="lessons" onNavigate={() => {}} health={null}><p>page</p></AppShell>);
  expect(screen.getByRole('button', { name: 'Inbox 4 waiting' }).title).toBe('Inbox (4 waiting)');
  expect(screen.getByRole('button', { name: 'Lessons' }).title).toBe('Lessons');
});
