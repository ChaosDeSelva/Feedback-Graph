/**
 * Bring `el` into view by scrolling only its nearest scrolling ancestor (a list or a pane). `scrollIntoView` scrolls
 * every scrolling ancestor up to the page, which nudged the whole app (header clipped) when a row was selected.
 */
export function scrollIntoPane(el: HTMLElement | null, o: { smooth?: boolean } = {}) {
  if (!el) return;
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box || box === document.body || box === document.documentElement) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  // "nearest": move only as far as needed, top edge first when the element is taller than the pane.
  const delta = r.top < b.top ? r.top - b.top : r.bottom > b.bottom ? Math.min(r.bottom - b.bottom, r.top - b.top) : 0;
  if (delta) box.scrollTo?.({ top: box.scrollTop + delta, behavior: o.smooth ? 'smooth' : 'auto' });
}
