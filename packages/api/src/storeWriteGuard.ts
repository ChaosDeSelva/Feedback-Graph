import { guardStoreMethods, STORE_WRITE_POLICY } from '@fb/core';
/** Fixture/dependency surfaces use the same exhaustive semantic methods as real stores. */
const methods = Object.assign({}, ...Object.values(STORE_WRITE_POLICY));
const cache = new WeakMap<object, object>();
export function guardApiStoreWrites<T extends object>(value: T): T {
  const prior = cache.get(value); if (prior) return prior as T;
  const guarded = guardStoreMethods(value, methods);
  const proxy = new Proxy(guarded, { get(target, key) {
    const item = Reflect.get(target, key);
    if (!item || typeof item !== 'object' || Array.isArray(item) || item instanceof Map || item instanceof Set || item instanceof Date || item instanceof RegExp || item instanceof URL || item instanceof Promise || item instanceof AbortSignal) return item;
    return guardApiStoreWrites(item);
  } });
  cache.set(value, proxy); cache.set(proxy, proxy);
  return proxy;
}

/** Only protocol discovery is exempt; unknown methods and batches containing tools keep lazy write protection. */
export function mcpDiscoveryOnly(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.length > 0 && messages.every(message => message && typeof message === 'object'
    && ['initialize', 'notifications/initialized', 'tools/list', 'ping'].includes((message as { method?: string }).method ?? ''));
}
