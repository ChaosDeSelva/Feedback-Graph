import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'fg:theme';
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

const media = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

/** The viewer's own pick wins; without one the page follows the system setting. */
function resolve(): Theme {
  return stored() ?? (media()?.matches ? 'dark' : 'light');
}

let current: Theme = 'light';

function apply() {
  const pick = stored();
  if (pick) document.documentElement.dataset.theme = pick;
  else delete document.documentElement.dataset.theme;
  const next = resolve();
  if (next !== current) {
    current = next;
    listeners.forEach((l) => l());
  }
}

/** Called once at startup, before the first render. */
export function initTheme() {
  current = resolve();
  apply();
  media()?.addEventListener?.('change', apply);
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Storage can be blocked (private windows); the switch still applies for this visit.
    document.documentElement.dataset.theme = t;
    current = t;
    listeners.forEach((l) => l());
    return;
  }
  apply();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => current,
    () => current,
  );
}

/** Canvas drawing (the graph) cannot use CSS variables, so it reads the resolved token values. */
export function readToken(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
  return v || fallback;
}

/** A small persisted per-viewer preference (sidebar collapsed and the like). */
export function loadPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function savePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* not persisted this visit */ }
}
