import { needsTabStop } from './ScrollArea.tsx';

/**
 * For tests (axe's scrollable-region-focusable): every element that scrolls on overflow must be reachable by keyboard,
 * itself focusable or holding something focusable, or a keyboard user cannot scroll it. Returns the ones that are not.
 * jsdom lays nothing out, so call `overflowAll` first to test the case where every such box overflows.
 */
export function unreachableScrollers(root: ParentNode): Element[] {
  return [...root.querySelectorAll('[class*="overflow-auto"], [class*="overflow-x-auto"], [class*="overflow-y-auto"]')]
    .filter((el) => !el.matches('[tabindex]:not([tabindex="-1"])') && needsTabStop(el));
}

/** For tests: every element (or each one `which` picks) reports more content than fits; the returned function undoes it. */
export function overflowAll(which: (el: Element) => boolean = () => true): () => void {
  const proto = Element.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get(this: Element) { return which(this) ? this.clientHeight + 100 : this.clientHeight; } });
  return () => { if (own) Object.defineProperty(proto, 'scrollHeight', own); };
}
