import { createElement, useCallback, useRef, type HTMLAttributes, type Ref } from 'react';
import { hasTabbable } from './focus.ts';

/**
 * Whether a keyboard user needs `el` itself as a tab stop to scroll it (axe's scrollable-region-focusable): it overflows
 * and holds nothing focusable that is drawn. A box that does not scroll, or whose rows are buttons or links, would only be
 * an extra stop.
 */
export function needsTabStop(el: Element): boolean {
  return (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) && !hasTabbable(el);
}

/**
 * A callback ref that makes its element a tab stop exactly while `needsTabStop` holds, checked again whenever the element
 * or its content resizes or changes.
 */
export function useScrollReach<T extends HTMLElement>(): (el: T | null) => void {
  const stop = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    stop.current?.();
    stop.current = null;
    if (!el) return;
    const update = () => {
      // Only a change is written: the tabindex attribute is observed below, so writing it every time would loop.
      const want = needsTabStop(el);
      if (want === el.hasAttribute('tabindex')) return;
      if (want) el.tabIndex = 0;
      // Dropping the stop from the focused box would drop focus to <body>; it goes when focus leaves.
      else if (document.activeElement === el) el.addEventListener('blur', update, { once: true });
      else el.removeAttribute('tabindex');
    };
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    const watchSizes = () => {
      if (!sizes) return;
      sizes.disconnect();
      sizes.observe(el);
      for (const child of el.children) sizes.observe(child);
    };
    const changes = new MutationObserver(() => { watchSizes(); update(); });
    changes.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'href', 'hidden', 'tabindex', 'class', 'style'] });
    watchSizes();
    update();
    stop.current = () => { sizes?.disconnect(); changes.disconnect(); el.removeEventListener('blur', update); };
  }, []);
}

/**
 * Every box that scrolls on overflow (`overflow-auto`, `overflow-x-auto`, `overflow-y-auto`) is one of these, so a keyboard
 * user can always reach it (`useScrollReach`). Its focus ring is drawn inside its edge (the `!` beats the global
 * `:focus-visible` offset in styles.css): a pane that meets the viewport edge would clip a ring drawn outside it.
 */
export function ScrollArea({ as = 'div', className = '', ...rest }: { as?: 'div' | 'pre' | 'ul' | 'section' | 'aside' | 'nav' } & HTMLAttributes<HTMLElement>) {
  const ref: Ref<HTMLElement> = useScrollReach<HTMLElement>();
  return createElement(as, { ...rest, ref, className: `${className} focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-focus` });
}
