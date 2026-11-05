import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { OperatorConfig } from '@fb/core';

export type AuthOpts = {
  /** Private installation salt; never returned or logged. */
  runKeySalt?: string;
  /** When set, every /api and /mcp call needs it (Bearer header, or the UI's session cookie). */
  token?: string;
  /** Headless owner bearer. It is never a general read token and never installed into agents. */
  ownerToken?: string;
  /** Host names besides localhost the API answers to. Only honoured when a token is set. */
  publicHosts?: string[];
  /** FG_OPERATOR_TOKEN: as a Bearer it signs in like the token and passes ownerOnly for the verbs in `allow`. */
  operator?: OperatorConfig;
};

export const SESSION_COOKIE = 'fg_session';
const SESSION_MAX_AGE = 30 * 24 * 3600;

/** Browser sessions are random server-side capabilities, never a reusable derivation of API_TOKEN. */
export class OwnerSessions {
  private readonly sessions = new Map<string, number>();
  private readonly revoked = new Map<string, number>();
  private readonly signingKey?: string;
  constructor(signingKey?: string) { this.signingKey = signingKey; }
  private digest(value: string) { return createHash('sha256').update(`feedback-graph-ui-session:${value}`).digest('hex'); }
  private sign(value: string) { return createHmac('sha256', this.signingKey!).update(`feedback-graph-ui-session:${value}`).digest('base64url'); }
  create(now = Date.now()): string {
    this.purge(now);
    const expires = now + SESSION_MAX_AGE * 1000;
    const body = `${expires}.${randomBytes(32).toString('base64url')}`;
    const value = this.signingKey ? `${body}.${this.sign(body)}` : body;
    this.sessions.set(this.digest(value), expires);
    return value;
  }
  has(value: string | undefined, now = Date.now()): boolean {
    if (!value) return false;
    const key = this.digest(value);
    const revokedUntil = this.revoked.get(key);
    if (revokedUntil && revokedUntil > now) return false;
    let expires = this.sessions.get(key);
    if (!expires && this.signingKey) {
      const parts = value.split('.');
      if (parts.length === 3) {
        const body = `${parts[0]}.${parts[1]}`;
        if (tokenMatches(parts[2], this.sign(body))) expires = Number(parts[0]);
      }
    }
    if (!expires || expires <= now) { this.sessions.delete(key); return false; }
    return true;
  }
  remove(value: string | undefined) {
    if (!value) return;
    const key = this.digest(value);
    const expiry = this.sessions.get(key) ?? Number(value.split('.')[0]);
    this.sessions.delete(key);
    if (Number.isFinite(expiry)) this.revoked.set(key, expiry);
  }
  private purge(now: number) {
    for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key);
    for (const [key, expires] of this.revoked) if (expires <= now) this.revoked.delete(key);
  }
}

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

export function ownerSession(c: Context, sessions: OwnerSessions): boolean {
  return sessions.has(cookie(c.req.header('cookie'), SESSION_COOKIE));
}

export function authenticated(c: Context, token: string | undefined, sessions: OwnerSessions): boolean {
  if (ownerSession(c, sessions)) return true;
  if (!token) return true;
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ') && same(auth.slice(7).trim(), token)) return true;
  return false;
}

export function tokenMatches(given: unknown, token: string): boolean {
  return typeof given === 'string' && same(given, token);
}

export function sessionCookie(value: string, secure: boolean, clear = false): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${clear ? 0 : SESSION_MAX_AGE}`];
  if (secure) attrs.push('Secure');
  return `${SESSION_COOKIE}=${clear ? '' : value}; ${attrs.join('; ')}`;
}

/** Paths anyone may call: health/readiness (the container checks; they expose only ok and, for readiness, store kind), and
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
