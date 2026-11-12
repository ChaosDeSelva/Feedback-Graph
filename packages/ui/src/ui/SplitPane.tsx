import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronIcon } from './icons.tsx';
import { scrollIntoPane } from './scroll.ts';
import { ScrollArea } from './ScrollArea.tsx';

const NARROW = '(max-width: 767.98px)';
const narrowQuery = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null);
const subscribeNarrow = (cb: () => void) => {
  const q = narrowQuery();
  q?.addEventListener('change', cb);
  return () => q?.removeEventListener('change', cb);
};
/** True below the md breakpoint, where the list and the detail take turns. */
export function useNarrow() {
  return useSyncExternalStore(subscribeNarrow, () => narrowQuery()?.matches ?? false, () => false);
}

/**
 * A list on the left and the selected item on the right, each scrolling on its own. Both panes are positioned, so an
 * absolutely placed box inside (a visually hidden file input) is placed in its pane, never against the page, which
 * would then grow and scroll as a whole.
 * On a phone it shows one at a time: the list, then the item you tap with a way back to the list.
 * `detailOpen` says which of the two a phone shows; wider screens always show both.
 */
export function SplitPane({ listHeader, list, listFooter, children, listWidth = '22rem', listLabel, detailOpen = false, onBack, notice }: {
  listHeader?: ReactNode;
  /** Shown above the list on a phone (an error, say), where the detail pane that carries it on wider screens is hidden. */
  notice?: ReactNode;
  list: ReactNode;
  listFooter?: ReactNode;
  children: ReactNode;
  listWidth?: string;
  listLabel: string;
  detailOpen?: boolean;
  onBack?: () => void;
}) {
  const narrow = useNarrow();
  return (
    <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,var(--list-w))_minmax(20rem,1fr)]" style={{ ['--list-w' as string]: `min(${listWidth}, calc(100vw - 20rem))` }}>
      <aside aria-label={listLabel} className={`${detailOpen ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col bg-surface md:flex md:border-r md:border-line`}>
        {narrow && notice && <div className="shrink-0 p-3 pb-0">{notice}</div>}
        {listHeader && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">{listHeader}</div>}
        <ScrollArea role="region" aria-label={`${listLabel} list`} className="relative min-h-0 flex-1 overflow-y-auto">{list}</ScrollArea>
        {listFooter && <div className="hidden shrink-0 border-t border-line px-3 py-2 md:block">{listFooter}</div>}
      </aside>
      <ScrollArea as="section" aria-label="item detail" className={`${detailOpen ? 'block' : 'hidden'} relative min-h-0 min-w-0 flex-1 overflow-y-auto md:block`}>
        {onBack && (
          <div className="sticky top-0 z-10 border-b border-line bg-surface/95 px-2 py-1.5 backdrop-blur md:hidden">
            <button type="button" onClick={onBack} className="flex h-8 items-center gap-1 rounded-sm px-2 text-[13px] font-medium text-muted hover:bg-hover hover:text-text">
              <ChevronIcon size={12} className="rotate-180" />
              Back to {listLabel}
            </button>
          </div>
        )}
        {children}
      </ScrollArea>
    </div>
  );
}

/** The selected row's mark: a bar on its left edge. */
const SELECTED_BAR = 'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent';

/**
 * One selectable row in a SplitPane list. The selected row is marked with a bar on its left edge and kept in view (its
 * list scrolls, never the page). Content starts 13px clear of the 3px bar, so a row that opens with a control never
 * touches it. `lead`: a control before the row (a selection checkbox), outside its button (controls
 * do not nest); the bar is then the whole row's, left of the lead, which is inset like the row's text so it never
 * touches the bar or the text.
 */
export function ListRow({ selected, onClick, children, lead }: { selected: boolean; onClick: () => void; children: ReactNode; lead?: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) scrollIntoPane(ref.current);
  }, [selected]);
  const button = (
    <button
      ref={ref}
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      className={`relative block w-full min-w-0 border-b border-line py-2.5 text-left transition-colors ${lead ? 'flex-1 pr-3 pl-2' : 'pr-3 pl-4'} ${
        selected ? `bg-selected ${lead ? '' : SELECTED_BAR}` : 'hover:bg-sunken'
      }`}
    >
      {children}
    </button>
  );
  if (!lead) return button;
  return (
    <div className={`relative flex ${selected ? `bg-selected ${SELECTED_BAR}` : ''}`}>
      <div className="flex shrink-0 items-start border-b border-line pt-3 pl-4">{lead}</div>
      {button}
    </div>
  );
}
