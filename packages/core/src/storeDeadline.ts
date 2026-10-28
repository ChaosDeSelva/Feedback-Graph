import { AsyncLocalStorage } from 'node:async_hooks';

export class StoreDeadlineError extends Error {
  constructor() { super('request deadline exceeded; the operation was cancelled'); this.name = 'StoreDeadlineError'; }
}
type Deadline = { signal: AbortSignal; expiresAt: number };
const scope = new AsyncLocalStorage<Deadline>();
export const withStoreDeadline = <T>(deadline: Deadline, fn: () => T): T => scope.run(deadline, fn);
export const storeRequestSignal = (): AbortSignal | undefined => scope.getStore()?.signal;
export function storeTimeLeft(fallback = 30_000): number {
  const current = scope.getStore();
  if (!current) return fallback;
  const left = current.expiresAt - Date.now();
  if (current.signal.aborted || left <= 0) throw new StoreDeadlineError();
  return Math.max(1, Math.min(fallback, Math.floor(left)));
}
