import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useOwnerWrites } from '../ownerAccess.tsx';
import { Button, FilterBar } from './controls.tsx';
import { Alert, Kbd, SkeletonList } from './display.tsx';
import { ListRow, SplitPane } from './SplitPane.tsx';

/**
 * A key that acts on the open item (`a` accept, `r` reject). `owner`: it makes an owner decision, so it does nothing on
 * a read-only install, as the buttons it stands for are disabled there. `when` false: not offered now.
 */
export type ReviewKey = { key: string; label: string; run: () => void; owner?: boolean; when?: boolean };

/** Ticking rows for a bulk decision: which are ticked, how to tick one, and each row's name for its checkbox. */
export type ReviewPick<T> = { picked: Set<string>; toggle: (id: string) => void; label: (item: T) => string };

/**
 * The review queue the Inbox made (a list and the open item, `j`/`k` to move, a key per decision, an Undo bar, Load
 * more for x-next-offset paging, ticked rows for bulk decisions), for lists of any kind: the Intake page's claims,
 * questions, people and sources. The page owns the items, the selection and the decisions; this owns the layout, the
 * keys and, on a phone, whether the list or the item shows.
 * Keys never fire while typing in a field, with a modifier (Cmd+C copies), on a held key, or while `busy` (a decision
 * is saving, so the list has not moved on and a key would land on the wrong item).
 */
export function ReviewList<T>({
  label, items, idOf, row, selected, onSelect, loaded, notice, listHeader, empty, next, loadingMore = false, onLoadMore, pick, keys = [], busy = false,
  undo, actions, listWidth, children,
}: {
  /** What the list holds ("claims"): its landmark's name. */
  label: string;
  items: T[];
  idOf: (item: T) => string;
  row: (item: T) => ReactNode;
  selected: number;
  onSelect: (i: number) => void;
  loaded: boolean;
  /** An error, shown above the list on a phone and in the detail pane elsewhere. */
  notice?: ReactNode;
  listHeader?: ReactNode;
  /** What an empty list says. */
  empty: ReactNode;
  /** Another page waits (x-next-offset): Load more, at the end of the list, fetches it. */
  next?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  pick?: ReviewPick<T>;
  keys?: ReviewKey[];
  busy?: boolean;
  /** A decision just saved, and how to take it back. */
  undo?: { message: string; label: string; onUndo: () => void } | null;
  /** The open item's decision bar, kept at the foot of the detail pane. */
  actions?: ReactNode;
  listWidth?: string;
  /** The open item. */
  children: ReactNode;
}) {
  const writes = useOwnerWrites();
  // On a phone the list and the item take turns; true while the item shows.
  const [open, setOpen] = useState(false);
  const live = keys.filter((k) => k.when !== false && (!k.owner || writes));
  const state = useRef({ items, selected, live, busy, onSelect });
  state.current = { items, selected, live, busy, onSelect };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const s = state.current;
      if (s.busy || !s.items.length) return;
      if (e.key === 'j') s.onSelect(Math.min(s.selected + 1, s.items.length - 1));
      else if (e.key === 'k') s.onSelect(Math.max(s.selected - 1, 0));
      else {
        const k = s.live.find((x) => x.key === e.key);
        if (!k) return;
        e.preventDefault();
        k.run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {undo && (
        <div role="status" className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-sunken px-4 py-2 text-sm md:px-6">
          <span>{undo.message}</span>
          <Button size="sm" owner disabled={busy} onClick={undo.onUndo}>{undo.label}</Button>
        </div>
      )}
      <SplitPane
        listLabel={label}
        listWidth={listWidth}
        listHeader={listHeader}
        detailOpen={open && items.length > 0}
        onBack={() => setOpen(false)}
        notice={notice}
        list={
          !loaded ? <SkeletonList /> : items.length === 0 ? empty : (
            <ul>
              {items.map((item, i) => (
                <li key={idOf(item)}>
                  <ListRow
                    selected={i === selected}
                    lead={pick ? <input type="checkbox" aria-label={`select ${pick.label(item)}`} checked={pick.picked.has(idOf(item))} onChange={() => pick.toggle(idOf(item))} className="cursor-pointer" /> : undefined}
                    onClick={() => { onSelect(i); setOpen(true); }}
                  >
                    {row(item)}
                  </ListRow>
                </li>
              ))}
              {next && (
                <li className="px-3 py-2">
                  <Button size="sm" variant="ghost" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</Button>
                </li>
              )}
            </ul>
          )
        }
        listFooter={items.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
            <span className="flex items-center gap-1"><Kbd>j</Kbd><Kbd>k</Kbd> move</span>
            {live.map((k) => <span key={k.key} className="flex items-center gap-1"><Kbd>{k.key}</Kbd> {k.label}</span>)}
          </div>
        )}
      >
        <div className="flex min-h-full flex-col">
          <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-5 md:px-6">
            {notice && <div className="mb-4">{notice}</div>}
            {children}
          </div>
          {actions && (
            <div className="sticky bottom-0 border-t border-line bg-surface/95 backdrop-blur">
              <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 py-2.5 md:px-6">{actions}</div>
            </div>
          )}
        </div>
      </SplitPane>
    </div>
  );
}

/**
 * The bulk bar above a list with ticked rows: select all or clear, how many are ticked, and the decisions. It is always
 * there, its buttons disabled until a row is ticked, so the rows never move under the cursor.
 */
export function BulkBar({ total, picked, onAll, children }: { total: number; picked: number; onAll: (all: boolean) => void; children: ReactNode }) {
  const all = picked === total && total > 0;
  return (
    <FilterBar label="bulk decisions">
      <Button size="sm" onClick={() => onAll(!all)}>{all ? 'Clear' : 'Select all'}</Button>
      <span className="text-xs text-muted tabular-nums">{picked ? `${picked} selected` : 'none selected'}</span>
      {children}
    </FilterBar>
  );
}

/** A refusal per failed row of a bulk decision, the first few named. */
export function bulkFailures(results: { id: string; ok: boolean; error?: string }[], what: string): ReactNode {
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return null;
  const shown = failed.slice(0, 3);
  return <Alert>{`${failed.length} ${what}${failed.length === 1 ? '' : 's'} could not be decided (still selected): ${shown.map((r) => `${r.id}: ${r.error ?? 'failed'}`).join('; ')}${failed.length > shown.length ? `; and ${failed.length - shown.length} more` : ''}`}</Alert>;
}
