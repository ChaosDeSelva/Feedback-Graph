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
  ['POST', '/api/projects/:key/scan', 'scan'],
  ['POST', '/api/projects/scan', 'scan'],
  ['PATCH', '/api/projects/:key/facts/:id/relevance', 'relevance'],
  ['PUT', '/api/projects/:key/pin', 'pin'],
  ['PUT', '/api/links', 'links'],
  ['DELETE', '/api/links/:id', 'links'],
  ['POST', '/api/projects/:key/docs', 'docs'],
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
  ['POST', '/api/settings/integrations/:kind/test', 'integrations'],
  ['DELETE', '/api/settings/integrations/:kind', 'integrations'],
  ['PUT', '/api/settings/integrations/projects/:key', 'integrations'],
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

/** The store's record, with the owner's writes made through the operator token logged as the agent instead of you. */
export function asActor<T extends Pick<ActivityStore, 'record'>>(a: T): T;
export function asActor<T extends Pick<ActivityStore, 'record'>>(a: T | undefined): T | undefined;
export function asActor<T extends Pick<ActivityStore, 'record'>>(a: T | undefined): T | undefined {
  if (!a) return a;
  const record: ActivityStore['record'] = (e) => {
    const actor = acting.getStore();
    return a.record(actor && e.actor === 'you' ? { ...e, actor } : e);
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
