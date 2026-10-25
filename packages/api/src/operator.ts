import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from 'hono';
import type { ActivityStore, OperatorConfig, OperatorVerb } from '@fb/core';
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
  ['DELETE', '/api/links/:id', 'links'],
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
    const e = via ? { ...input, details: { ...input.details, via } } : input;
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

export const refusedVerb = (verb: OperatorVerb) => ({
  error: `the operator token may not ${verb.replace(/_/g, ' ')} (${verb}): add ${verb} to OPERATOR_ALLOW in .env and restart, or do it in the Feedback Graph UI`,
});
