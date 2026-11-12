import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  /** Owner-cookie revocations survive API restarts here (an owner-only API settings mount). */
  sessionStateFile?: string;
};

export const SESSION_COOKIE = 'fg_session';
const SESSION_MAX_AGE = 30 * 24 * 3600;

/** Browser sessions are random server-side capabilities, never a reusable derivation of API_TOKEN. */
export class OwnerSessions {
  private readonly sessions = new Map<string, number>();
  private readonly revoked = new Map<string, number>();
  private readonly signingKey?: string;
  private readonly stateFile?: string;
  /** Signed cookies issued before this are refused. A first start writes it (no session exists yet), so a file that is
   * later missing, unreadable or corrupt cannot forget a revocation: the cut-off moves to now and is saved again (fail
   * closed: the owner signs in again). */
  private notBefore = 0;
  /** Why the revocation file was not used, for the startup log. */
  readonly stateProblem?: string;
  constructor(signingKey?: string, stateFile?: string, now = Date.now()) {
    this.signingKey = signingKey;
    this.stateFile = stateFile;
    if (!stateFile) return;
    let text: string | undefined;
    try { text = readFileSync(stateFile, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') text = ''; }
    const saved = text === undefined ? null : parseState(text);
    if (saved) {
      this.notBefore = saved.notBefore;
      for (const [key, expiry] of Object.entries(saved.revoked)) if (this.validExpiry(expiry, now)) this.revoked.set(key, expiry);
      return;
    }
    this.notBefore = now;
    const problem = text === undefined
      ? `${stateFile} was missing and is now written: owner browser sessions from before this start, if any, are refused`
      : `${stateFile} is unreadable or corrupt: every earlier owner browser session is refused; sign in again`;
    try { this.persist(new Map()); this.stateProblem = problem; }
    catch (error) {
      this.stateProblem = `${text === undefined ? `${stateFile} is missing` : problem} and could not be written (${(error as Error).message}): every owner browser session from before this start is refused, at every start until it can be written`;
    }
  }
  /** Cookies are shared by every port of a host, so an install's cookie is named after the port it is reached on: two
   * installs on one machine never overwrite each other's session, and the name reveals nothing about any credential. */
  cookieName(hostHeader: string | undefined): string {
    const port = /:(\d{1,5})$/.exec(hostHeader ?? '')?.[1];
    return port ? `${SESSION_COOKIE}_${port}` : SESSION_COOKIE;
  }
  /** Sessions are issued strictly after the cut-off, even within the millisecond it was set. */
  private issuedAt(now: number) { return Math.max(now, this.notBefore + 1); }
  private validExpiry(value: number, now: number) {
    return Number.isSafeInteger(value) && value > now && value <= this.issuedAt(now) + SESSION_MAX_AGE * 1000;
  }
  private digest(value: string) { return createHash('sha256').update(`feedback-graph-ui-session:${value}`).digest('hex'); }
  private sign(value: string) { return createHmac('sha256', this.signingKey!).update(`feedback-graph-ui-session:${value}`).digest('base64url'); }
  create(now = Date.now()): string {
    this.purge(now);
    const expires = this.issuedAt(now) + SESSION_MAX_AGE * 1000;
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
        const claimed = Number(parts[0]);
        if (tokenMatches(parts[2], this.sign(body)) && this.validExpiry(claimed, now) && claimed - SESSION_MAX_AGE * 1000 > this.notBefore) expires = claimed;
      }
    }
    if (!expires || expires <= now) { this.sessions.delete(key); return false; }
    return true;
  }
  /** Revokes a valid session. The revocation is saved first: if saving fails this throws and the session stays valid
   * everywhere, rather than only until the next restart. */
  remove(value: string, now = Date.now()) {
    const key = this.digest(value);
    const expiry = this.sessions.get(key) ?? Number(value.split('.')[0]);
    if (!this.validExpiry(expiry, now)) { this.sessions.delete(key); return; }
    this.purge(now);
    this.persist(new Map(this.revoked).set(key, expiry));
    this.revoked.set(key, expiry);
    this.sessions.delete(key);
  }
  private purge(now: number) {
    for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key);
    for (const [key, expires] of this.revoked) if (expires <= now) this.revoked.delete(key);
  }
  private persist(revoked: Map<string, number>) {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ notBefore: this.notBefore, revoked: Object.fromEntries(revoked) })}\n`, { mode: 0o600 });
      renameSync(tmp, this.stateFile);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

/** How long a sign-in link works, and how many may be outstanding (a new one beyond that retires the oldest). */
export const SIGNIN_LINK_TTL_MS = 60_000;
const SIGNIN_LINK_MAX = 8;

/**
 * One-time sign-in links, so the owner need not copy FG_OWNER_TOKEN into the browser: `fg signin` (holding that token)
 * asks for one and opens it. A code is random, kept only as its hash in memory (a restart forgets every one), works
 * once and for SIGNIN_LINK_TTL_MS, and is never logged (the request log has paths, not query strings).
 */
export class SignInLinks {
  private readonly codes = new Map<string, number>();
  private digest(code: string) { return createHash('sha256').update(`feedback-graph-signin-link:${code}`).digest('hex'); }
  create(now = Date.now()): string {
    this.purge(now);
    while (this.codes.size >= SIGNIN_LINK_MAX) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(32).toString('base64url');
    this.codes.set(this.digest(code), now + SIGNIN_LINK_TTL_MS);
    return code;
  }
  /** True once for a live code: it is spent whether or not it was still valid. */
  redeem(code: unknown, now = Date.now()): boolean {
    if (typeof code !== 'string' || !/^[\w-]{43}$/.test(code)) return false;
    const key = this.digest(code);
    const expires = this.codes.get(key);
    this.codes.delete(key);
    return expires !== undefined && expires > now;
  }
  private purge(now: number) { for (const [key, expires] of this.codes) if (expires <= now) this.codes.delete(key); }
}

/** The revocation file: `{ notBefore, revoked }`, or the 0.7.5 flat `{ digest: expiry }` map. Anything else is null. */
function parseState(text: string): { notBefore: number; revoked: Record<string, number> } | null {
  let saved: unknown;
  try { saved = JSON.parse(text); } catch { return null; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const state = 'revoked' in saved ? saved as { notBefore?: unknown; revoked?: unknown } : { notBefore: 0, revoked: saved };
  const { notBefore, revoked } = state;
  if (!Number.isSafeInteger(notBefore) || !revoked || typeof revoked !== 'object' || Array.isArray(revoked)) return null;
  if (!Object.entries(revoked).every(([key, expiry]) => /^[0-9a-f]{64}$/.test(key) && typeof expiry === 'number')) return null;
  return { notBefore: notBefore as number, revoked: revoked as Record<string, number> };
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Every value of the cookie `name`: a page on another port of this host can plant a second one (Path=/api sorts
 * first), so reading only the first would let it sign the owner out. */
function cookies(header: string | undefined, name: string): string[] {
  const values: string[] = [];
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) values.push(v.join('='));
  }
  return values;
}

export function ownerSession(c: Context, sessions: OwnerSessions): boolean {
  return sessionValue(c, sessions) !== undefined;
}

/** This install's valid session cookie on the request, if any. */
export function sessionValue(c: Context, sessions: OwnerSessions): string | undefined {
  return cookies(c.req.header('cookie'), sessions.cookieName(c.req.header('host'))).find((value) => sessions.has(value));
}

/** The token of an `Authorization: Bearer <token>` header, trimmed; the scheme is case-insensitive (RFC 7235). */
export function bearerToken(header: string | undefined): string | null {
  const m = /^bearer\s+(.*)$/is.exec(header ?? '');
  return m?.[1].trim() || null;
}

export function authenticated(c: Context, token: string | undefined, sessions: OwnerSessions): boolean {
  if (ownerSession(c, sessions)) return true;
  if (!token) return true;
  const given = bearerToken(c.req.header('authorization'));
  return !!given && same(given, token);
}

export function tokenMatches(given: unknown, token: string): boolean {
  return typeof given === 'string' && same(given, token);
}

export function sessionCookie(value: string, secure: boolean, clear = false, name = SESSION_COOKIE): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${clear ? 0 : SESSION_MAX_AGE}`];
  if (secure) attrs.push('Secure');
  return `${name}=${clear ? '' : value}; ${attrs.join('; ')}`;
}

/** Paths anyone may call: health/readiness (the container checks; they expose only ok and, for readiness, store kind), and
 * the sign-in endpoints themselves (each checks its own credential: the owner token, or a one-time link's code). */
export const isOpenPath = (path: string) => path === '/api/health' || path === '/api/ready' || path === '/api/session' || path === '/api/session/link';
export const needsAuth = (path: string) => (path.startsWith('/api/') || path === '/mcp') && !isOpenPath(path);

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // style-src needs 'unsafe-inline' for React style attributes (bar widths); scripts stay same-origin only.
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
