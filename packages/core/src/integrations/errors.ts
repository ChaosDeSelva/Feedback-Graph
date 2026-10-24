/**
 * Why a call to GitHub or Linear failed, so a sync can react: `auth` (the token was revoked, expired or lacks access:
 * stop and say so), `rate_limit` (wait until `retryAt`), `not_found` (the repository or team is gone or out of the
 * token's reach), `network` and `other` (try again next time). Messages never contain the token.
 */
export type IntegrationErrorKind = 'auth' | 'rate_limit' | 'not_found' | 'network' | 'other';

export class IntegrationError extends Error {
  readonly kind: IntegrationErrorKind;
  /** When a rate limit lifts (ISO), if the service said. */
  readonly retryAt: string | null;
  constructor(message: string, kind: IntegrationErrorKind, retryAt: string | null = null) {
    super(message);
    this.name = 'IntegrationError';
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

/** The kind of any error a sync caught: fetch failures (DNS, refused, timeout) are network errors. */
export function integrationErrorKind(err: unknown): IntegrationErrorKind {
  if (err instanceof IntegrationError) return err.kind;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(err.message))) return 'network';
  return 'other';
}
