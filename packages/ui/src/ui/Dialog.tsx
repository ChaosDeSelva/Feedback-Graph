import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ScrollArea } from './ScrollArea.tsx';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * A modal with a form inside (ConfirmDialog is the plain question). Focus starts on the element marked `data-autofocus`
 * (else the first control), Tab stays inside, Escape and a click outside cancel unless `busy`, and focus goes back to
 * where it was when it closes. The page's own shortcut keys never act behind it.
 */
export function Dialog({ title, onCancel, busy = false, footer, children }: { title: string; onCancel: () => void; busy?: boolean; footer: ReactNode; children: ReactNode }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (box.current!.querySelector<HTMLElement>('[data-autofocus]') ?? box.current!.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const els = [...box.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = els[0], last = els[els.length - 1], at = document.activeElement;
    const to = !box.current!.contains(at) ? first : e.shiftKey && at === first ? last : !e.shiftKey && at === last ? first : null;
    if (to) {
      e.preventDefault();
      to.focus();
    }
  }
  return createPortal(
    <ScrollArea
      data-testid="dialog-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-text/30 p-4"
    >
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} onKeyDown={onKeyDown} className="w-full max-w-lg rounded-md border border-line bg-surface text-[13px] shadow-pop">
        <div className="grid gap-3 p-4">
          <h2 id={titleId} className="font-semibold">{title}</h2>
          {children}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 rounded-b-md border-t border-line bg-sunken px-4 py-3">{footer}</footer>
      </div>
    </ScrollArea>,
    document.body,
  );
}
