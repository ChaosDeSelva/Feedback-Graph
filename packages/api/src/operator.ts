import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from 'hono';
import { RUN_ID, type ActivityStore, type OperatorConfig, type OperatorVerb, type RunTag } from '@fb/core';
import { tokenMatches } from './auth.ts';

/**
 * The operator token (FG_OPERATOR_TOKEN): an agent or the `fg` CLI sends it as `Authorization: Bearer` to make the
 * owner decisions OPERATOR_ALLOW lets it make. The browser stays the owner's ('you'); a write made with the token is
 * logged as `operator:<name>`, the name from the X-FG-Operator header.
 */

/** Which OPERATOR_ALLOW verb each owner-only route is. */
export const OWNER_ROUTES: readonly (readonly ['POST' | 'PUT' | 'PATCH' | 'DELETE', string, OperatorVerb])[] = [
  ['POST', '/api/candidates/:id/decision', 'inbox_decide'],
  ['POST', '/api/candidates/decisions', 'inbox_decide'],
  ['PATCH', '/api/lessons/:id', 'lesson_decide'],
  ['POST', '/api/lessons/decisions', 'lesson_decide'],
  ['POST', '/api/lessons/recheck', 'retry'],
  ['POST', '/api/lessons/:id/to-fact', 'lesson_decide'],
  ['POST', '/api/projects/:key/scan', 'scan'],
  ['POST', '/api/projects/scan', 'scan'],
  ['POST', '/api/projects/:key/codemap/rebuild', 'scan'],
  ['PATCH', '/api/projects/:key/facts/:id/relevance', 'relevance'],
  ['PUT', '/api/projects/:key/pin', 'pin'],
  ['PUT', '/api/links', 'links'],
  // Confirming or dismissing is `links`; removing a link (one the owner may have decided) is its own verb, off by default.
  ['DELETE', '/api/links/:id', 'links_delete'],
  ['POST', '/api/projects/:key/docs', 'docs'],
  ['POST', '/api/docs/:id/reread', 'docs'],
  ['DELETE', '/api/docs/:id', 'docs_delete'],
  ['DELETE', '/api/projects/:key', 'delete_project'],
  ['POST', '/api/feedback/:id/retry', 'retry'],
  ['PUT', '/api/settings/projects', 'select_projects'],
  ['PUT', '/api/settings/roots', 'settings'],
  ['POST', '/api/settings/cleanup', 'settings'],
  ['POST', '/api/cloud/sync', 'sync_now'],
  ['POST', '/api/turns/requeue', 'requeue'],
  ['POST', '/api/import', 'import'],
  ['POST', '/api/sessions/:id/resummarize', 'resummarize'],
  ['PUT', '/api/settings/integrations/:kind', 'integrations'],
  // Not POST /api/settings/integrations/:kind/test: it re-checks the token already saved, a read (fg integrations test).
  ['DELETE', '/api/settings/integrations/:kind', 'integrations'],
  ['PUT', '/api/settings/integrations/projects/:key', 'integrations'],
  ['POST', '/api/chats', 'chat'],
  ['POST', '/api/chats/:id/messages', 'chat'],
  ['POST', '/api/chats/:id/turns/:turnId/retry', 'chat'],
  ['PATCH', '/api/chats/:id', 'chat'],
  ['DELETE', '/api/chats/:id', 'chat_delete'],
  // Removes only what one run wrote (runs.ts): on for the operator token by default.
  ['DELETE', '/api/runs/:id', 'run_cleanup'],
];

const MAX_NAME = 40;

/** The actor a write made with the operator token is logged as: `operator:<name>`, or `operator` with no usable name. */
export function operatorName(header: string | undefined): string {
  const name = (header ?? '').trim().replace(/[^\w.@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME).replace(/-+$/, '');
  return name ? `operator:${name}` : 'operator';
}

/** The request carries the operator token (never true while FG_OPERATOR_TOKEN is unset or empty). */
export function hasOperatorToken(c: Context, op: OperatorConfig | undefined): boolean {
  if (!op?.token) return false;
  const auth = c.req.header('authorization');
  return !!auth?.startsWith('Bearer ') && tokenMatches(auth.slice(7).trim(), op.token);
}

/** Who is making the current request's writes, while an operator-token request runs; unset: the owner. */
const acting = new AsyncLocalStorage<string>();

export const runAs = <T>(actor: string, fn: () => T): T => acting.run(actor, fn);
/** 'you', or the operator actor of the request being handled. */
export const currentActor = (): string => acting.getStore() ?? 'you';
export const actingAsOperator = (): boolean => acting.getStore() !== undefined;

/**
 * How the request being handled arrived: with the operator token, from a browser (it sent Origin, as browsers do on
 * every write), or from another local client (no Origin, no operator token). A forged Origin still says browser: it is
 * what the request claimed, recorded so a write "by you" can be told apart from one by the token.
 */
export type Via = 'operator' | 'browser' | 'api';
const arrived = new AsyncLocalStorage<Via>();
export const runVia = <T>(via: Via, fn: () => T): T => arrived.run(via, fn);

/** The run the request being handled was labelled with (runLabel); unset: none. */
const running = new AsyncLocalStorage<RunTag>();
export const runIn = <T>(run: RunTag | null, fn: () => T): T => (run ? running.run(run, fn) : fn());
/** The run of the request being handled, for the writes that record it; null outside a labelled request. */
export const currentRun = (): RunTag | null => running.getStore() ?? null;

/** The request being handled came from the owner (the browser, or the owner's API token), not an agent. */
const fromOwner = new AsyncLocalStorage<boolean>();
export const runFromOwner = <T>(owner: boolean, fn: () => T): T => fromOwner.run(owner, fn);

/**
 * A run changes only what it wrote: outside a run, or in a run the owner opened (not a sandbox), the request may change
 * any record, and the change is the owner's. A sandbox run, or one an agent opened, changes only records with its run.
 */
export const mayChangeAny = (): boolean => {
  const run = currentRun();
  return !run || (!run.sandbox && fromOwner.getStore() === true);
};
/** Whether the request may change a record that carries `run` (absent or null: the owner's). */
export const mayChange = (record: { run?: string | null }): boolean => mayChangeAny() || (!!record.run && record.run === currentRun()?.id);

const YES = new Set(['1', 'true', 'yes', 'on']);
const NO = new Set(['0', 'false', 'no', 'off', '']);

/**
 * The run a request is labelled with: X-FG-Run (a run id like CLOUD_MACHINE: 1 to 64 letters, digits, dots, dashes or
 * underscores) and X-FG-Sandbox (1 or 0). `query`: the MCP endpoints also take ?run= and ?sandbox=, for a client that
 * is configured with a URL only. Null: not labelled; an error: a label that is not usable, refused rather than ignored.
 */
export function runLabel(header: (name: string) => string | undefined, query?: (name: string) => string | undefined): RunTag | null | { error: string } {
  const id = (header('x-fg-run') ?? query?.('run'))?.trim() ?? '';
  const flag = (header('x-fg-sandbox') ?? query?.('sandbox'))?.trim().toLowerCase();
  if (flag !== undefined && !YES.has(flag) && !NO.has(flag)) return { error: 'x-fg-sandbox must be 1 or 0' };
  const sandbox = flag !== undefined && YES.has(flag);
  if (!id) return sandbox ? { error: 'x-fg-sandbox needs x-fg-run: name the run too, so what it writes can be cleaned up (fg cleanup --run <id>)' } : null;
  if (!RUN_ID.test(id)) return { error: 'x-fg-run must be 1 to 64 letters, digits, dots, dashes or underscores' };
  return { id, sandbox };
}

/**
 * The store's record, with the owner's writes made through the operator token logged as the agent instead of you: the
 * actor, and a `why` written for the owner ("you pinned it") reworded to name the agent ("an agent (operator:codex)
 * pinned it"). Every entry recorded while a request runs says how it arrived (`details.via`).
 */
export function asActor<T extends Pick<ActivityStore, 'record'>>(a: T): T;
export function asActor<T extends Pick<ActivityStore, 'record'>>(a: T | undefined): T | undefined;
export function asActor<T extends Pick<ActivityStore, 'record'>>(a: T | undefined): T | undefined {
  if (!a) return a;
  const record: ActivityStore['record'] = (input) => {
    const via = arrived.getStore();
    const run = running.getStore();
    const e0 = via ? { ...input, details: { ...input.details, via } } : input;
    // The run it was made in, unless the entry names one itself.
    const e = run && e0.run === undefined ? { ...e0, run: run.id, ...(run.sandbox && { sandbox: true }) } : e0;
    const actor = acting.getStore();
    if (!actor || e.actor !== 'you') return a.record(e);
    return a.record({ ...e, actor, why: e.why.startsWith('you ') ? `an agent (${actor}) ${e.why.slice(4)}` : e.why });
  };
  return new Proxy(a, {
    get: (t, k) => {
      if (k === 'record') return record;
      const v: unknown = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/**
 * Choosing projects has one more way in, the owner's own on the host: `setup.sh --select` (INGEST_PROJECTS), which the
 * app takes while no selection has been made, so a first run without the UI is not stuck.
 */
export const refusedVerb = (verb: OperatorVerb) => ({
  error: `the operator token may not ${verb.replace(/_/g, ' ')} (${verb}): add ${verb} to OPERATOR_ALLOW in .env and restart, or do it in the Feedback Graph UI` +
    (verb === 'select_projects' ? '; before any selection is made, ./scripts/setup.sh --select k1,k2 on the host chooses the first one' : ''),
});
