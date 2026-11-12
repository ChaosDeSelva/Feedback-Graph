import type { MiddlewareHandler } from 'hono';
import { StoreDeadlineError, withStoreDeadline } from '@fb/core';

/** Includes authentication, pool waits and store work before route dispatch. SSE setup is bounded; an opened stream is not. */
export function requestDeadline(timeoutMs = 55_000): MiddlewareHandler {
  return async (c, next) => {
    if (!c.req.path.startsWith('/api/') && !c.req.path.startsWith('/mcp')) return next();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
    const expiresAt = Date.now() + timeoutMs;
    return withStoreDeadline({ signal, expiresAt }, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A route's error never rejects next(): app.onError answers it (504 for a deadline, 499 for a closed client).
      try {
        return await Promise.race([
          next().then(() => c.res),
          new Promise<Response>(resolve => { timer = setTimeout(() => {
            controller.abort(new StoreDeadlineError());
            resolve(c.json({ error: 'request deadline exceeded; retry the request', retryable: true }, 504));
          }, timeoutMs); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    });
  };
}
