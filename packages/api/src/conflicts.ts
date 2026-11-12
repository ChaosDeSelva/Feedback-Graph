import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  CONFLICT_CHOICES, CONFLICT_DISMISS_REASONS, CONFLICT_KINDS, CONFLICT_STATUSES, conflictFingerprint, FACT_KINDS, NotTheRunsError, resolutionDecision,
  ResolveRefusal, TargetChangedError,
  type ActivityStore, type Conflict, type ConflictSide, type Decision, type DecisionExecStore, type DecisionExecutor, type IntakeMeta, type Person,
  type ShownProjects,
} from '@fb/core';
import { currentActor, currentRun, mayChange } from './operator.ts';
import { runAsked } from './runs.ts';

/**
 * Knowledge intake's conflicts (0.9.0 §6): two things agents may be told that disagree, shown side by side, and the
 * owner's choice of which is true. Resolving one is a resolve_conflict decision (author owner) that the 0.8 executor
 * applies at once, so it is audited on the Decisions page and undone by rolling that decision back
 * (POST /api/decisions/:id/rollback), which reopens the conflict and restores the loser exactly. Reads are the owner's,
 * as claims are (they carry transcript quotes); resolving is an owner route (OPERATOR_ALLOW conflict_decide, off by default).
 */

export type ConflictDeps = {
  /** What the resolution reads and writes through: the sides' records, the decisions, the intake records. */
  store: DecisionExecStore;
  exec: Pick<DecisionExecutor, 'apply'>;
  activity: Pick<ActivityStore, 'record'>;
};
export type ConflictRouteContext = { view: () => Promise<Pick<ShownProjects, 'has' | 'keys'> | null>; agentCaller: (c: Context) => boolean };

const PAGE = 100;
const MAX_PAGE = 500;
const Id = z.string().min(1).max(500);
const ConflictsQuery = z.object({
  status: z.enum(CONFLICT_STATUSES).optional(), kind: z.enum(CONFLICT_KINDS).optional(), project: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(), offset: z.coerce.number().int().min(0).optional(),
});
const ResolveBody = z.object({
  /** a / b: that side is true. both: both partly (note required). none: not a conflict (reason required). */
  choice: z.enum(CONFLICT_CHOICES),
  note: z.string().trim().max(2000).optional(),
  reason: z.enum(CONFLICT_DISMISS_REASONS).optional(),
  /** both: a reconciled statement, filed as your fact; both sides are then superseded by it. */
  statement: z.string().trim().min(1).max(2000).optional(),
  /** The reconciled fact's project when the conflict is global, and its kind. */
  projectKey: z.string().min(1).max(200).optional(),
  factKind: z.enum(FACT_KINDS).optional(),
  /** conflictFingerprint of the conflict as the page showed it: one changed since is not resolved over (409). */
  expect: z.string().min(1).max(200).optional(),
}).strict();

/** For the OpenAPI document (openapi.ts). */
export const conflictSchemas = { ConflictsQuery, ResolveBody };

/**
 * One side as the owner judges it: what it says, the verbatim quote (a claim's), who said it and when, its type and
 * status, and whether agents are given it now (agentsSee). source: a claim's intake source (occurredAt, kind, origin).
 */
export type ConflictSideView = ConflictSide & {
  text: string; quote: string | null; type: string | null; status: string | null; speaker: Pick<Person, 'id' | 'displayName' | 'isOwner'> | null;
  origin: string | null; path: string | null; docId: string | null; source: Pick<IntakeMeta, 'docId' | 'kind' | 'occurredAt' | 'origin'> | null;
  agentsSee: boolean; gone: boolean;
};
export type ConflictView = Conflict & { fingerprint: string; sides: { a: ConflictSideView; b: ConflictSideView } };

export function conflictRoutes(app: Hono, d: ConflictDeps, ctx: ConflictRouteContext) {
  const { store } = d;
  const visible = async (key: string | null) => {
    const v = await ctx.view();
    return key === null || !v || v.has(key);
  };
  const runSees = (r: { run: string | null; sandbox: boolean }) => !r.sandbox || (!!r.run && r.run === currentRun()?.id);
  const shown = async (id: string) => {
    const k = await store.intake.conflict(id);
    return k && runSees(k) && (await visible(k.projectKey)) ? k : null;
  };

  async function sideView(s: ConflictSide): Promise<ConflictSideView> {
    const base = { ...s, quote: null, type: null, status: null, speaker: null, origin: null, path: null, docId: null, source: null, agentsSee: false, gone: false };
    if (s.kind === 'claim') {
      const c = await store.intake.claim(s.id);
      if (!c) return { ...base, text: '', gone: true };
      const [person, [meta]] = await Promise.all([c.speakerId ? store.intake.person(c.speakerId) : null, store.intake.metas([c.docId])]);
      // A claim reaches agents only as the fact accepting it made (an opinion never), while that fact is current.
      const fact = c.factId ? await store.facts.fact(c.factId) : null;
      return {
        ...base, text: c.statement, quote: c.quote, type: c.type, status: c.status, docId: c.docId, origin: 'claim',
        speaker: person && { id: person.id, displayName: person.displayName, isOwner: person.isOwner },
        source: meta ? { docId: meta.docId, kind: meta.kind, occurredAt: meta.occurredAt, origin: meta.origin } : null,
        agentsSee: c.status === 'accepted' && !!fact?.current,
      };
    }
    if (s.kind === 'fact') {
      const f = await store.facts.fact(s.id);
      if (!f) return { ...base, text: '', gone: true };
      return { ...base, text: f.statement, type: f.kind, status: f.current ? 'current' : 'closed', origin: f.origin ?? null, path: f.path, agentsSee: f.current };
    }
    const l = (await store.knowledge.lessonDetail(s.id))?.lesson;
    if (!l) return { ...base, text: '', gone: true };
    return { ...base, text: `${l.title}: ${l.rule}`, type: 'lesson', status: l.status, origin: l.source, agentsSee: l.status === 'approved' };
  }
  const view = async (k: Conflict): Promise<ConflictView> => {
    const [a, b] = await Promise.all([sideView(k.a), sideView(k.b)]);
    return { ...k, fingerprint: conflictFingerprint(k), sides: { a, b } };
  };

  app.use('/api/conflicts/*', ownerReads);
  app.use('/api/conflicts', ownerReads);
  async function ownerReads(c: Context, next: () => Promise<void>) {
    // Conflicts quote what people said: an agent reads only what was accepted, served with its [disputed] marker.
    if (ctx.agentCaller(c)) return c.json({ error: 'conflicts are the owner\'s to read and settle (use the browser, FG_OWNER_TOKEN or FG_OPERATOR_TOKEN)' }, 403);
    await next();
  }

  // Open first (the queue), then newest; each with both sides as the owner judges them.
  app.get('/api/conflicts', async (c) => {
    const q = ConflictsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const v = await ctx.view();
    const projectKeys = !v ? (q.data.project ? [q.data.project] : undefined) : q.data.project ? (v.has(q.data.project) ? [q.data.project] : []) : v.keys;
    if (q.data.project && projectKeys?.length === 0) return c.json([]);
    const limit = q.data.limit ?? PAGE;
    const offset = q.data.offset ?? 0;
    const rows = await store.intake.listConflicts({
      ...(q.data.status && { status: [q.data.status] }), ...(q.data.kind && { kind: [q.data.kind] }), ...(projectKeys && { projectKeys }),
      limit: limit + 1, offset, run: runAsked().run ?? null,
    });
    if (rows.length > limit) c.header('x-next-offset', String(offset + limit));
    return c.json(await Promise.all(rows.slice(0, limit).map(view)));
  });

  app.get('/api/conflicts/:id', async (c) => {
    const k = await shown(c.req.param('id'));
    if (!k) return c.json({ error: 'not found' }, 404);
    const decision: Decision | null = k.decisionId ? await store.decisions.get(k.decisionId) : null;
    return c.json({ ...(await view(k)), decision });
  });

  app.post('/api/conflicts/:id/resolve', async (c) => {
    const body = ResolveBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const k = await shown(c.req.param('id'));
    if (!k) return c.json({ error: 'not found' }, 404);
    if (!mayChange(k)) return c.json({ error: new NotTheRunsError(`the conflict ${k.id}`, currentRun()!.id).message }, 409);
    if (body.data.expect !== undefined && body.data.expect !== conflictFingerprint(k)) return c.json({ error: `${k.id} changed since you opened it: reload it and decide again` }, 409);
    const by = currentActor();
    const r = body.data;
    if (r.statement && r.projectKey && k.projectKey === null && !(await visible(r.projectKey))) return c.json({ error: 'not found: this project is not selected' }, 404);
    let applied: Decision;
    try {
      const input = await resolutionDecision(store, k, r, { by });
      const { decision } = await store.decisions.propose(input);
      applied = await d.exec.apply(decision, { by });
    } catch (e) {
      if (e instanceof ResolveRefusal) return c.json({ error: e.message }, k.status === 'open' ? 400 : 409);
      if (e instanceof TargetChangedError) return c.json({ error: `${e.targetId} changed meanwhile, so nothing was resolved: reload it and decide again` }, 409);
      throw e;
    }
    const after = (await store.intake.conflict(k.id))!;
    const sides = await view(after);
    const word = r.choice === 'none' ? 'dismissed' : 'resolved';
    const loser = r.choice === 'a' ? sides.sides.b : r.choice === 'b' ? sides.sides.a : null;
    await d.activity.record({
      kind: 'conflict_resolved', actor: 'you', projectKey: k.projectKey,
      subject: `${word} conflict: ${r.choice === 'a' || r.choice === 'b' ? `side ${r.choice.toUpperCase()} is true` : r.choice === 'both' ? 'both partly true' : `not a conflict (${r.reason})`}`.slice(0, 300),
      why: loser ? `you chose which is true; "${loser.text.slice(0, 120)}" is superseded, and agents are no longer given it` : r.choice === 'both' ? (r.statement ? 'you reconciled both into one statement agents are given; both sides are superseded by it' : 'you said both are partly true; agents are given both with your note') : 'you said they do not conflict',
      details: { decisionId: applied.id, decisionType: applied.type, choice: r.choice, ...(r.reason && { reason: r.reason }), author: 'owner' },
      targets: [k.id, applied.id, ...applied.targets.map((t) => t.id)],
    });
    return c.json({ conflict: sides, decision: applied });
  });
}
