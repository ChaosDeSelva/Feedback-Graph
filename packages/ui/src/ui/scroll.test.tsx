import { afterEach, expect, test, vi } from 'vitest';
import { scrollIntoPane } from './scroll.ts';

afterEach(() => { document.body.innerHTML = ''; });

/** A row inside a scrolling list (inside an outer scrolling page box), with fixed on-screen rectangles. */
function rowInPane(row: { top: number; bottom: number }, pane = { top: 100, bottom: 300 }) {
  const page = document.createElement('div');
  page.style.overflowY = 'auto';
  const list = document.createElement('div');
  list.style.overflowY = 'auto';
  const wrapper = document.createElement('div');
  const el = document.createElement('div');
  wrapper.append(el); list.append(wrapper); page.append(list); document.body.append(page);
  list.scrollTop = 40;
  const rect = (r: { top: number; bottom: number }) => ({ ...r, left: 0, right: 0, width: 0, height: r.bottom - r.top, x: 0, y: r.top, toJSON: () => r }) as DOMRect;
  el.getBoundingClientRect = () => rect(row);
  list.getBoundingClientRect = () => rect(pane);
  list.scrollTo = vi.fn() as unknown as typeof list.scrollTo;
  page.scrollTo = vi.fn() as unknown as typeof page.scrollTo;
  return { el, list, page };
}

test('a row above the pane scrolls only its nearest scrolling list up to it', () => {
  const { el, list, page } = rowInPane({ top: 60, bottom: 90 });
  scrollIntoPane(el, { smooth: true });
  expect(list.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  expect(page.scrollTo).not.toHaveBeenCalled();
});

test('a row below the pane scrolls down just far enough to show it', () => {
  const { el, list } = rowInPane({ top: 290, bottom: 330 });
  scrollIntoPane(el);
  expect(list.scrollTo).toHaveBeenCalledWith({ top: 70, behavior: 'auto' });
});

test('a row taller than the pane brings its top edge in first', () => {
  const { el, list } = rowInPane({ top: 150, bottom: 500 });
  scrollIntoPane(el);
  expect(list.scrollTo).toHaveBeenCalledWith({ top: 90, behavior: 'auto' });
});

test('a visible row, a missing element, or one with no scrolling ancestor scrolls nothing', () => {
  const { el, list } = rowInPane({ top: 150, bottom: 200 });
  scrollIntoPane(el);
  scrollIntoPane(null);
  expect(list.scrollTo).not.toHaveBeenCalled();
  const loose = document.createElement('div');
  document.body.append(loose);
  expect(() => scrollIntoPane(loose)).not.toThrow();
});
