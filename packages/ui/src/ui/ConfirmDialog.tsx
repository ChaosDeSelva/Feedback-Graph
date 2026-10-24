import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Button, Input } from './controls.tsx';
import { Alert } from './display.tsx';
import { TrashIcon } from './icons.tsx';

export type ConfirmOptions = {
  /** The question, naming the thing: "Delete everything learned from shop?" */
  title: string;
  /** What exactly goes, and whether it can be undone. */
  message?: ReactNode;
  /** The things that will be removed, listed one by one. */
  items?: string[];
  /** The destructive button's label: the action, not "OK". */
  confirmLabel: string;
  /** Shown on the confirm button while `busy`. */
  busyLabel?: string;
  /** A phrase to type before confirm is enabled, for removals that cannot be undone and reach far. */
  typeToConfirm?: string;
};

type Props = ConfirmOptions & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** The removal is running: both buttons are disabled and Escape does nothing. */
  busy?: boolean;
  /** The removal failed: say why, and leave the dialog open. */
  error?: string | null;
  children?: ReactNode;
};

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Asks before anything is removed. Cancel has the focus, so Enter or a stray click keeps your data; Escape and a click
 * outside cancel too. The confirm button is the only red one and says what it does.
 */
export function ConfirmDialog({ open, title, message, items, confirmLabel, busyLabel, typeToConfirm, onConfirm, onCancel, busy = false, error = null, children }: Props) {
  const titleId = useId();
  const descId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) return;
    setTyped('');
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('[data-cancel]')?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, [open]);

  if (!open) return null;
  const ready = !busy && (!typeToConfirm || typed === typeToConfirm);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // The page's own shortcuts (the Inbox's c/r) must not act behind the dialog.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    const els = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1], at = document.activeElement;
    const to = !dialog.current.contains(at) ? first : e.shiftKey && at === first ? last : !e.shiftKey && at === last ? first : null;
    if (to) {
      e.preventDefault();
      to.focus();
    }
  }

  return createPortal(
    <div
      data-testid="confirm-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-text/30 p-4"
    >
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-md border border-line bg-surface text-[13px] shadow-pop"
      >
        <div className="grid gap-3 p-4">
          <div className="flex items-start gap-3">
            <div aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-bad-soft text-bad-text"><TrashIcon /></div>
            <div className="min-w-0">
              <h2 id={titleId} className="font-semibold">{title}</h2>
              <div id={descId} className="mt-1 text-muted">{children ?? message}</div>
            </div>
          </div>
          {items && items.length > 0 && (
            <ul aria-label="will be removed" className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {items.map((k) => <li key={k} className="rounded-sm border border-line bg-sunken px-1.5 py-0.5 font-mono text-xs">{k}</li>)}
            </ul>
          )}
          {typeToConfirm && (
            <label className="grid gap-1.5 text-xs text-muted">
              <span>Type <code className="font-mono font-semibold text-text">{typeToConfirm}</code> to confirm.</span>
              <Input aria-label={`type ${typeToConfirm} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={typeToConfirm} className="font-mono" autoComplete="off" spellCheck={false} />
            </label>
          )}
          {error && <Alert>{error}</Alert>}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 rounded-b-md border-t border-line bg-sunken px-4 py-3">
          <Button data-cancel onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => { if (ready) onConfirm(); }} disabled={!ready}>{busy && busyLabel ? busyLabel : confirmLabel}</Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// ── askConfirm: the same dialog, awaited, for code that is not a component (leaving unsaved edits) ──

type Request = ConfirmOptions & { resolve: (ok: boolean) => void };
let current: Request | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
let host: { el: HTMLElement; root: Root } | null = null;

function ConfirmHost() {
  const r = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current);
  const done = (ok: boolean) => {
    if (!r || current !== r) return;
    current = null;
    notify();
    r.resolve(ok);
  };
  return <ConfirmDialog {...(r ?? { title: '', confirmLabel: '' })} open={!!r} onConfirm={() => done(true)} onCancel={() => done(false)} />;
}

/** Ask and wait: true only when the person presses the confirm button. A newer question cancels an open one. */
export function askConfirm(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = current;
    current = { ...o, resolve };
    previous?.resolve(false);
    if (!host || !host.el.isConnected) {
      const el = document.createElement('div');
      document.body.appendChild(el);
      host = { el, root: createRoot(el) };
      host.root.render(<ConfirmHost />);
    }
    notify();
  });
}
