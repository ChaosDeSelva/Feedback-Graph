/** What can take keyboard focus, before checking that it is drawn (`rendered`). */
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';

/** Whether `x`, inside `root`, is drawn: a control under `display: none` (a `hidden lg:inline` sort button) cannot take focus. */
export function rendered(x: Element, root: Element): boolean {
  if (getComputedStyle(x).visibility === 'hidden') return false;
  for (let n: Element | null = x; n && n !== root; n = n.parentElement) if (getComputedStyle(n).display === 'none') return false;
  return true;
}

/** The elements Tab reaches inside `root`, in order. */
export const tabbables = (root: Element) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => rendered(x, root));

/** Whether Tab reaches anything inside `root` (stops at the first drawn one). */
export const hasTabbable = (root: Element) => [...root.querySelectorAll(FOCUSABLE)].some((x) => rendered(x, root));
