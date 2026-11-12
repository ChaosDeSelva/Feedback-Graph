import { afterEach } from 'vitest';

// Node 25+ has a global localStorage of its own, undefined unless node runs with --localstorage-file, and it hides
// jsdom's: put jsdom's stores back so tests get the working per-viewer storage a browser has. Tests of blocked storage
// stub it themselves.
const { window } = (globalThis as unknown as { jsdom: { window: Window } }).jsdom;
for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: window[name] });
}
afterEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
