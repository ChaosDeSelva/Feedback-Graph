import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { rendered, tabbables } from './focus.ts';
import { ScrollArea } from './ScrollArea.tsx';

/**
 * Every modal dialog in the app: on open, focus moves into it (to the element marked `data-autofocus`, else the first
 * one Tab reaches); Tab and Shift+Tab stay inside; Escape and a click on the backdrop cancel unless `busy`; on close,
 * focus goes back to what opened it, or to <main> when that is gone or hidden (a phone menu that closed behind it).
 */
export function Modal({ role = 'dialog', labelledBy, describedBy, busy = false, onCancel, children, className = '', backdropTestId }: {
  role?: 'dialog' | 'alertdialog';
  labelledBy: string;
  describedBy?: string;
  busy?: boolean;
  onCancel: () => void;
  children: ReactNode;
  className?: string;
  backdropTestId?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = dialog.current!;
    (el.querySelector<HTMLElement>('[data-autofocus]') ?? tabbables(el)[0])?.focus();
    return () => {
      // Focus is handed back only when it was in the dialog (or dropped with it); one that moved on keeps its place.
      const at = document.activeElement;
      if (at && at !== document.body && !el.contains(at)) return;
      if (before?.isConnected && rendered(before, document.body)) before.focus();
      if (!before || document.activeElement !== before) document.querySelector<HTMLElement>('main')?.focus();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // The page's own shortcuts (the Inbox's c/r) must not act behind the dialog.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const els = tabbables(dialog.current!);
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1], at = document.activeElement;
    const to = !dialog.current!.contains(at) ? first : e.shiftKey && at === first ? last : !e.shiftKey && at === last ? first : null;
    if (to) {
      e.preventDefault();
      to.focus();
    }
  }

  return createPortal(
    <ScrollArea
      data-testid={backdropTestId}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-text/30 p-4"
    >
      <div
        ref={dialog}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
        className={`w-full max-w-md rounded-md border border-line bg-surface text-[13px] shadow-pop ${className}`}
      >
        {children}
      </div>
    </ScrollArea>,
    document.body,
  );
}
