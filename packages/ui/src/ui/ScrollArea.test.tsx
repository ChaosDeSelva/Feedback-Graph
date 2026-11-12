import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, onTestFinished, test } from 'vitest';
import { ScrollArea } from './ScrollArea.tsx';
import { overflowAll } from './scrollReach.ts';
import { ListRow, SplitPane } from './SplitPane.tsx';

afterEach(cleanup);

test('a box that does not scroll is no tab stop', () => {
  render(<ScrollArea aria-label="box" className="overflow-auto">short text</ScrollArea>);
  expect(screen.getByLabelText('box').hasAttribute('tabindex')).toBe(false);
});

test('a box that scrolls with nothing focusable inside is a tab stop; one whose rows are buttons is not, until they go', async () => {
  onTestFinished(overflowAll());
  const { rerender } = render(<ScrollArea as="pre" aria-label="text" className="overflow-auto">a long line</ScrollArea>);
  expect(screen.getByLabelText('text').tabIndex).toBe(0);
  rerender(<ScrollArea aria-label="rows" className="overflow-auto"><button type="button">one</button><button type="button">two</button></ScrollArea>);
  const rows = screen.getByLabelText('rows');
  expect(rows.hasAttribute('tabindex')).toBe(false);
  rerender(<ScrollArea aria-label="rows" className="overflow-auto"><p>no rows</p></ScrollArea>);
  await waitFor(() => expect(rows.tabIndex).toBe(0));
});

test('a split-pane list of rows adds no tab stop before its first row, scrolling or not', async () => {
  const pane = () => (
    <SplitPane listLabel="items" list={['a', 'b'].map((k) => <ListRow key={k} selected={false} onClick={() => {}}>{k}</ListRow>)}>
      <p>detail</p>
    </SplitPane>
  );
  const user = userEvent.setup();
  render(pane());
  await user.tab();
  expect(document.activeElement?.textContent).toBe('a');
  cleanup();
  onTestFinished(overflowAll());
  render(pane());
  await user.tab();
  expect(document.activeElement?.textContent).toBe('a');
  expect(screen.getByRole('region', { name: 'items list' }).hasAttribute('tabindex')).toBe(false);
});

test('a scrolling box whose only controls are not drawn (display: none, or hidden) is a tab stop; drawn ones make it none', async () => {
  onTestFinished(overflowAll());
  const box = (shown: boolean) => (
    <ScrollArea aria-label="folders" className="overflow-auto">
      <div style={{ display: shown ? 'block' : 'none' }}><button type="button">sort</button></div>
      <a href="#x" style={{ visibility: 'hidden' }}>hidden link</a>
      <input type="checkbox" disabled aria-label="locked" />
    </ScrollArea>
  );
  const { rerender } = render(box(false));
  const el = screen.getByLabelText('folders');
  expect(el.tabIndex).toBe(0);
  rerender(box(true));
  await waitFor(() => expect(el.hasAttribute('tabindex')).toBe(false));
});

test('a focused box that stops scrolling keeps focus and its tab stop until focus leaves it', async () => {
  let overflowing = true;
  onTestFinished(overflowAll(() => overflowing));
  const resized: (() => void)[] = [];
  const Real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(cb: () => void) { resized.push(cb); } observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
  onTestFinished(() => { globalThis.ResizeObserver = Real; });
  render(<><ScrollArea aria-label="table" className="overflow-auto">wide table</ScrollArea><button type="button">next</button></>);
  const el = screen.getByLabelText('table');
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(el);
  overflowing = false;
  for (const cb of resized) cb();
  expect(document.activeElement).toBe(el);
  expect(el.tabIndex).toBe(0);
  await user.tab();
  expect(document.activeElement?.textContent).toBe('next');
  expect(el.hasAttribute('tabindex')).toBe(false);
});

test('a box that unmounts while waiting for focus to leave stops listening', async () => {
  let overflowing = true;
  onTestFinished(overflowAll(() => overflowing));
  const resized: (() => void)[] = [];
  const Real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(cb: () => void) { resized.push(cb); } observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
  onTestFinished(() => { globalThis.ResizeObserver = Real; });
  const { unmount } = render(<ScrollArea aria-label="table" className="overflow-auto">wide</ScrollArea>);
  const el = screen.getByLabelText('table');
  el.focus();
  overflowing = false;
  for (const cb of resized) cb();
  unmount();
  el.dispatchEvent(new FocusEvent('blur'));
  expect(el.tabIndex).toBe(0);
});
