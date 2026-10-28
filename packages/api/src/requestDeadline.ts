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
      const expired = () => c.json({ error: 'request deadline exceeded; retry the request', retryable: true }, 504);
      try {
        return await Promise.race([
          next().then(() => c.res),
          new Promise<Response>(resolve => { timer = setTimeout(() => {
            controller.abort(new StoreDeadlineError());
            resolve(expired());
          }, timeoutMs); }),
        ]);
      } catch (error) {
        if (error instanceof StoreDeadlineError || signal.aborted) return expired();
        throw error;
      } finally { if (timer) clearTimeout(timer); }
    });
  };
}
