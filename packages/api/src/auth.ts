import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';

export type AuthOpts = {
  /** When set, every /api and /mcp call needs it (Bearer header, or the UI's session cookie). */
  token?: string;
  /** Host names besides localhost the API answers to. Only honoured when a token is set. */
  publicHosts?: string[];
};

export const SESSION_COOKIE = 'fg_session';
const SESSION_MAX_AGE = 30 * 24 * 3600;

/** The cookie holds a digest of the token, never the token itself. */
export const sessionValue = (token: string) => createHash('sha256').update(`feedback-graph-ui-session:${token}`).digest('hex');

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function authenticated(c: Context, token: string | undefined): boolean {
  if (!token) return true;
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ') && same(auth.slice(7).trim(), token)) return true;
  const s = cookie(c.req.header('cookie'), SESSION_COOKIE);
  return s !== undefined && same(s, sessionValue(token));
}

export function tokenMatches(given: unknown, token: string): boolean {
  return typeof given === 'string' && same(given, token);
}

export function sessionCookie(token: string, secure: boolean, clear = false): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${clear ? 0 : SESSION_MAX_AGE}`];
  if (secure) attrs.push('Secure');
  return `${SESSION_COOKIE}=${clear ? '' : sessionValue(token)}; ${attrs.join('; ')}`;
}

/** Paths anyone may call: liveness, readiness (the container health check; it says only ok and the store kind), and
 * the sign-in endpoint itself. */
export const isOpenPath = (path: string) => path === '/api/health' || path === '/api/ready' || path === '/api/session';
export const needsAuth = (path: string) => (path.startsWith('/api/') || path === '/mcp') && !isOpenPath(path);

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // style-src needs 'unsafe-inline' for React style attributes (bar widths); scripts stay same-origin only.
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
