import { useEffect } from 'react';

/** What would be lost, for each page that has edits not saved yet. */
const pending = new Map<symbol, string>();

const warnOnUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = ''; // older browsers only warn when this is set
};

/**
 * While `dirty`, leaving asks first: closing or reloading the tab (the browser's own prompt),
 * and moving to another page or item in the app (confirmDiscard).
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

/** True when nothing unsaved would be lost, or the person agrees to lose it. */
export function confirmDiscard(): boolean {
  if (!pending.size) return true;
  return window.confirm(`${[...new Set(pending.values())].join(' ')} Leave without saving?`);
}
