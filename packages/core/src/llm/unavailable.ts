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

/**
 * The model was asked but did not answer within the call's time limit (a runaway generation, a prompt too big for it).
 * That is this item's failure, not unavailability: it counts against the item, so one item the model can never finish
 * is given up on after its attempts instead of stalling every batch it heads.
 */
export class ModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}

/**
 * A CLI provider's run failed. `said` is what the CLI itself reported (its stderr, or the is_error result of its JSON
 * output): the only text read to tell unavailability. The model's answer (stdout) goes into the message so the owner
 * can see it, and is never classified: a post-mortem about auth code would otherwise read as "not signed in" forever.
 */
export class CliRunError extends Error {
  readonly tool: 'claude' | 'codex';
  /** Exit status; null when it exited 0 and reported an error. */
  readonly exit: number | null;
  readonly said: string;
  constructor(tool: 'claude' | 'codex', exit: number | null, said: string, output = '') {
    const shown = said.trim() ? said : output;
    super(`${tool} ${exit === null ? 'error' : `exit ${exit}`}: ${(tool === 'codex' ? shown.slice(-500) : shown.slice(0, 500))}`);
    this.name = 'CliRunError';
    this.tool = tool;
    this.exit = exit;
    this.said = said;
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
/** Connected, then waited too long for the answer: the call timed out, the model is there. */
const ANSWER_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const SIGNED_OUT = /not logged in|please run \/?login|codex login|invalid api key|oauth token (has )?expired|authenticat|unauthori[sz]ed|\b401\b|forbidden|\b403\b/i;
const LIMITED = /usage limit|rate limit|credit balance|quota|\b429\b|overloaded/i;
const excerpt = (s: string) => redactSecrets(s).replace(/\s+/g, ' ').trim().slice(0, 160);

/** Ollama's answer when it stops one generation (e.g. the repeat limit): the model is up, this input went wrong. */
const ABORTED_GENERATION = /prediction aborted|token repeat limit/i;

type ErrLike = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; syscall?: unknown; path?: unknown };

/**
 * Why `err` means one call timed out waiting for the model's answer (see ModelTimeoutError), or null. A connection
 * that could not be made in time is unavailability instead (providerUnavailableReason).
 */
export function modelTimeoutReason(err: unknown): string | null {
  if (err instanceof ModelTimeoutError) return err.message;
  if (!err || typeof err !== 'object') return null;
  const e = err as ErrLike;
  const cause = (e.cause && typeof e.cause === 'object' ? e.cause : {}) as ErrLike;
  if (e.name === 'TimeoutError' || cause.name === 'TimeoutError') return 'timed out waiting for the model';
  const code = typeof e.code === 'string' ? e.code : typeof cause.code === 'string' ? cause.code : null;
  if (code && ANSWER_TIMEOUT_CODES.has(code)) return `timed out waiting for the model (${code})`;
  const msg = typeof e.message === 'string' ? e.message : '';
  const http = msg.match(/^(\S+) (?:embed )?408:/);
  if (http) return `timed out waiting for ${http[1]}`;
  if (err instanceof CliRunError) return err.exit === 124 || /timed out after/.test(err.said) ? `timed out waiting for ${err.tool}` : null;
  const cli = msg.match(/^(claude|codex) (?:exit (\d+)|error):\s*([\s\S]*)$/);
  if (cli && (cli[2] === '124' || /timed out after/.test(cli[3]))) return `timed out waiting for ${cli[1]}`;
  return null;
}

/**
 * Why `err` means the provider is unavailable, or null when it is about this request's answer (bad JSON, a schema
 * mismatch, a 400, a CLI that ran and failed at the task, a call that timed out: see modelTimeoutReason). Reads the
 * errors the providers in providers.ts throw.
 */
export function providerUnavailableReason(err: unknown): string | null {
  if (err instanceof ProviderUnavailableError) return err.reason;
  if (!err || typeof err !== 'object') return null;
  if (modelTimeoutReason(err)) return null;
  const e = err as ErrLike;
  const cause = (e.cause && typeof e.cause === 'object' ? e.cause : {}) as ErrLike;
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
    // Ollama aborting this one generation (stuck repeating itself) is about this input's answer, not the model being down.
    if (status >= 500 && ABORTED_GENERATION.test(http[3])) return null;
    if (status >= 500) return `${http[1]} answered HTTP ${status}${body ? `: ${body}` : ''}`;
    if (status === 404) return `model not found (${http[1]} 404${body ? `: ${body}` : ''})`;
    if (status === 401 || status === 403) return `${http[1]} is not authorized (HTTP ${status}); check its key`;
    if (status === 429) return `${http[1]} is rate limited (HTTP 429)`;
    return null;
  }

  // CLI providers: what the CLI said (CliRunError), never its output; an older plain "claude exit <code>: <stderr>" too.
  const cli: [string, string, string | undefined, string] | null = err instanceof CliRunError
    ? ['', err.tool, err.exit === null ? undefined : String(err.exit), err.said]
    : (msg.match(/^(claude|codex) (?:exit (\d+)|error):\s*([\s\S]*)$/) as [string, string, string | undefined, string] | null);
  if (cli) {
    const [, name, exit, out] = cli;
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
    vision: p.vision ?? false,
    ...(p.mirror ? { mirror: p.mirror } : {}),
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
