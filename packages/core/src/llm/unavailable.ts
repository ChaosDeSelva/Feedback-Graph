import { redactSecrets } from '../redact.ts';
import type { ProviderHealth } from '../types.ts';
import type { LlmProvider } from './providers.ts';

/**
 * The model could not be asked at all (not running, unreachable, missing, not signed in, overloaded), as opposed to
 * an answer that could not be used. Work that hits this stops and waits; it is never counted against the item.
 */
export class ProviderUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`model unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
    this.reason = reason;
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const SIGNED_OUT = /not logged in|please run \/?login|codex login|invalid api key|oauth token (has )?expired|authenticat|unauthori[sz]ed|\b401\b|forbidden|\b403\b/i;
const LIMITED = /usage limit|rate limit|credit balance|quota|\b429\b|overloaded/i;
const excerpt = (s: string) => redactSecrets(s).replace(/\s+/g, ' ').trim().slice(0, 160);

type ErrLike = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; syscall?: unknown; path?: unknown };

/**
 * Why `err` means the provider is unavailable, or null when it is about this request's answer (bad JSON, a schema
 * mismatch, a 400, a CLI that ran and failed at the task). Reads the errors the providers in providers.ts throw.
 */
export function providerUnavailableReason(err: unknown): string | null {
  if (err instanceof ProviderUnavailableError) return err.reason;
  if (!err || typeof err !== 'object') return null;
  const e = err as ErrLike;
  const cause = (e.cause && typeof e.cause === 'object' ? e.cause : {}) as ErrLike;
  if (e.name === 'TimeoutError' || cause.name === 'TimeoutError') return 'timed out waiting for the model';
  const code = typeof e.code === 'string' ? e.code : typeof cause.code === 'string' ? cause.code : null;
  if (code === 'ENOENT' && typeof e.syscall === 'string' && e.syscall.startsWith('spawn')) return `${String(e.path ?? 'the CLI')} is not installed`;
  if (code && NETWORK_CODES.has(code)) return `cannot reach the model (${code})`;
  const msg = typeof e.message === 'string' ? e.message : '';
  if (e.name === 'TypeError' && /fetch failed/i.test(msg)) return 'cannot reach the model';

  // HTTP providers: "<id> <status>: <body>"
  const http = msg.match(/^(\S+) (?:embed )?(\d{3}):\s*([\s\S]*)$/);
  if (http) {
    const status = Number(http[2]);
    const body = excerpt(http[3]);
    if (status >= 500) return `${http[1]} answered HTTP ${status}${body ? `: ${body}` : ''}`;
    if (status === 404) return `model not found (${http[1]} 404${body ? `: ${body}` : ''})`;
    if (status === 401 || status === 403) return `${http[1]} is not authorized (HTTP ${status}); check its key`;
    if (status === 429) return `${http[1]} is rate limited (HTTP 429)`;
    if (status === 408) return `timed out waiting for ${http[1]}`;
    return null;
  }

  // CLI providers: "claude exit <code>: <stderr>", "codex exit <code>: ...", "claude error: <result>"
  const cli = msg.match(/^(claude|codex) (?:exit (\d+)|error):\s*([\s\S]*)$/);
  if (cli) {
    const [, name, exit, out] = cli;
    if (exit === '124' || /timed out after/.test(out)) return `timed out waiting for ${name}`;
    if (exit === '127' || /command not found/i.test(out)) return `${name} is not installed`;
    if (SIGNED_OUT.test(out)) return `${name} is not signed in (${excerpt(out)})`;
    if (LIMITED.test(out)) return `${name} hit a usage or rate limit (${excerpt(out)})`;
    return null;
  }
  return null;
}

/** `p`, reporting each call's outcome: ok when it answers, the reason when it is unavailable. Errors still throw. */
export function withHealth(p: LlmProvider, report: (h: ProviderHealth) => void): LlmProvider {
  return {
    id: p.id,
    agentic: p.agentic,
    async json(t) {
      try {
        const out = await p.json(t);
        report({ provider: p.id, ok: true, reason: null, at: new Date().toISOString() });
        return out;
      } catch (err) {
        const reason = providerUnavailableReason(err);
        if (reason) report({ provider: p.id, ok: false, reason, at: new Date().toISOString() });
        throw err;
      }
    },
  };
}
