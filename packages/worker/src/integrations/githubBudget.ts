import { createHash } from 'node:crypto';
import { IntegrationError, type DocsStore } from '@fb/core';

type BudgetState = { start: number; used: number; blockedUntil?: number };
/** Shared by docs, feedback and recovery. Persist each reservation, leaving headroom for the user's other clients. */
export function githubBudgetFetch(cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>, fetchImpl: typeof fetch = fetch,
  options: { maxPerHour?: number; now?: () => number } = {}): typeof fetch {
  const now = options.now ?? Date.now;
  const limit = options.maxPerHour ?? 1200;
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>) => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  return async (input, init) => {
    const token = new Headers(init?.headers).get('authorization') ?? '';
    const key = `github-http-budget:${createHash('sha256').update(token).digest('hex')}`;
    await serialized(async () => {
      let state: BudgetState;
      try { state = JSON.parse(await cursors.getCursor(key) ?? 'null') as BudgetState; } catch { state = null as unknown as BudgetState; }
      if (!state || !Number.isFinite(state.start) || !Number.isFinite(state.used) || now() >= state.start + 3600_000) state = { start: now(), used: 0 };
      const until = Math.max(state.blockedUntil ?? 0, state.used >= limit ? state.start + 3600_000 : 0);
      if (until > now()) throw new IntegrationError('GitHub sync is waiting for its shared request budget', 'rate_limit', new Date(until).toISOString());
      state.used++;
      await cursors.setCursor(key, JSON.stringify(state));
    });
    const response = await fetchImpl(input, init);
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const retryAfter = response.headers.get('retry-after');
    const retrySeconds = Number(retryAfter);
    const retryTime = retryAfter ? (Number.isFinite(retrySeconds) ? now() + retrySeconds * 1000 : Date.parse(retryAfter)) : 0;
    if (response.status === 429 || (response.status === 403 && !!retryAfter) || (response.headers.has('x-ratelimit-remaining') && remaining < 100)) {
      await serialized(async () => {
        const state = JSON.parse(await cursors.getCursor(key) ?? '{}') as BudgetState;
        state.blockedUntil = Number.isFinite(reset) && reset > now() ? reset : Number.isFinite(retryTime) && retryTime > now() ? retryTime : now() + 60_000;
        await cursors.setCursor(key, JSON.stringify(state));
      });
    }
    return response;
  };
}
