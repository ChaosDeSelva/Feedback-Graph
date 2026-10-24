import { useEffect } from 'react';
import { askConfirm } from './ui/ConfirmDialog.tsx';

/** What would be lost, for each page that has edits not saved yet. */
const pending = new Map<symbol, string>();

const warnOnUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = ''; // older browsers only warn when this is set
};

/**
 * While `dirty`, leaving asks first: closing or reloading the tab (the browser's own prompt),
 * and moving to another page or item in the app (afterDiscard).
 */
export function useUnsavedChanges(dirty: boolean, what: string) {
  useEffect(() => {
    if (!dirty) return;
    const id = Symbol(what);
    pending.set(id, what);
    window.addEventListener('beforeunload', warnOnUnload);
    return () => {
      pending.delete(id);
      if (!pending.size) window.removeEventListener('beforeunload', warnOnUnload);
    };
  }, [dirty, what]);
}

/**
 * Run `go` now when nothing unsaved would be lost; otherwise only once the person agrees, in the app's dialog, to
 * discard the edits. Staying (Cancel, Escape, a click outside) keeps them and never runs `go`.
 */
export function afterDiscard(go: () => void): void {
  if (!pending.size) return go();
  void askConfirm({
    title: 'Leave without saving?',
    message: `${[...new Set(pending.values())].join(' ')} Leaving discards these changes.`,
    confirmLabel: 'Discard changes',
  }).then((ok) => { if (ok) go(); });
}
