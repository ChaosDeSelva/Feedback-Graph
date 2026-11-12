import type { Decision, TargetSnapshot } from '../types.ts';
import { changedError, refuse, TargetChangedError } from './record.ts';
import { drift, snapshotKeys, snapshotOf, snapshotTargets, type DecisionExecStore } from './snapshot.ts';
import { handlerFor, type ExecDeps, type HandlerContext } from './types/index.ts';

export const handlerContext = (store: DecisionExecStore, deps: ExecDeps, by: string): HandlerContext => ({ store, deps, by });

/** The decision's targets as they are now, as its type's handler reads them (comparable with `before` and `after`). */
export async function currentTargets(s: DecisionExecStore, d: Decision, deps: ExecDeps = {}): Promise<TargetSnapshot[]> {
  const h = handlerFor(d.type);
  return h.snapshot ? h.snapshot(handlerContext(s, deps, ''), d) : snapshotTargets(s, snapshotKeys([...d.before, ...d.after]));
}

/**
 * Apply a proposed or observed decision: markApplying (compare-and-set), its type's handler writes `after` over
 * `before`, then markApplied with the targets as written, decided by `by`. A target changed since the decision was
 * made throws TargetChangedError and the decision is overridden (the owner's change stands); any other failure puts
 * it back where it was. Writes no Activity: the caller records it.
 */
export async function applyDecision(s: DecisionExecStore, d: Decision, o: { by: string; syncHoldUntil?: string | null }, deps: ExecDeps = {}): Promise<Decision> {
  const cur = await s.decisions.get(d.id);
  if (!cur || (cur.status !== 'proposed' && cur.status !== 'observed')) throw refuse(d.id, cur, 'proposed or observed');
  const changed = drift(await currentTargets(s, cur, deps), cur.before);
  if (changed) {
    await s.decisions.markStatus(cur.id, { status: 'overridden', from: [cur.status] });
    throw changedError(changed.target.id, changed.expected, changed.target);
  }
  const syncHoldUntil = o.syncHoldUntil ?? null;
  if (!(await s.decisions.markApplying(cur.id, { by: o.by, syncHoldUntil }))) throw refuse(cur.id, await s.decisions.get(cur.id), 'proposed or observed');
  const lease = holdLease(s, cur.id, o.by);
  try {
    await handlerFor(cur.type).apply(handlerContext(s, deps, o.by), cur);
  } catch (error) {
    await lease.end();
    await s.decisions.markStatus(cur.id, { status: error instanceof TargetChangedError ? 'overridden' : cur.status, from: ['applying'] });
    throw error;
  }
  await lease.end();
  // Not applying any more: a reconcile pass settled it meanwhile (a process that stalled past RECONCILE_AFTER_MS
  // without renewing its lease). It completed it (applied, as this apply would have) or it is the caller's to read again.
  if (!(await s.decisions.markApplied(cur.id, await currentTargets(s, cur, deps), { syncHoldUntil }))) {
    const now = await s.decisions.get(cur.id);
    if (now?.status === 'applied') return now;
    throw refuse(cur.id, now, 'applying');
  }
  await s.decisions.markStatus(cur.id, { status: 'applied', from: ['applied'], by: o.by });
  return (await s.decisions.get(cur.id))!;
}

export type ReconcileResult = { applied: number; proposed: number; overridden: number };

/**
 * How long an apply may go without renewing its lease (decidedAt) before reconcileInFlight settles it: an apply still
 * running in another process (the API's approve while the worker reconciles) renews it every APPLY_LEASE_RENEW_MS,
 * however long its embeddings take, so only one whose process died is settled.
 */
export const RECONCILE_AFTER_MS = 2 * 60_000;
/** How often a running apply renews its lease: well inside RECONCILE_AFTER_MS, so a slow store write cannot let it lapse. */
export const APPLY_LEASE_RENEW_MS = RECONCILE_AFTER_MS / 4;

/**
 * Renew the applying decision's lease (decidedAt, by the same decider) every APPLY_LEASE_RENEW_MS until end(), which
 * waits for a renewal under way. A renewal that fails is not retried until the next tick: the lease is long enough for a
 * few to be missed.
 */
function holdLease(s: DecisionExecStore, id: string, by: string): { end: () => Promise<void> } {
  let renewing: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    renewing ??= s.decisions.markStatus(id, { status: 'applying', from: ['applying'], by }).catch(() => false).finally(() => { renewing = null; });
  }, APPLY_LEASE_RENEW_MS);
  return {
    end: async () => {
      clearInterval(timer);
      await renewing;
    },
  };
}

/**
 * Settle decisions a crash left `applying` (between markApplying and markApplied), their lease not renewed for
 * RECONCILE_AFTER_MS, so nothing is left half written. Targets all as `after`: applied, by whom and with the sync hold the apply recorded.
 * Each target as `before` or `after` (the write stopped part way: a record_fact's fact made but its lesson not yet
 * rejected, a split's reworded lesson without the lesson it splits off): the part written is undone (the type's
 * rollback over the targets as they are) and the decision is proposed again. A target that is neither was changed
 * since by someone else: overridden, and nothing is written over that change.
 */
export async function reconcileInFlight(s: DecisionExecStore, deps: ExecDeps = {}, now = Date.now()): Promise<ReconcileResult> {
  const out: ReconcileResult = { applied: 0, proposed: 0, overridden: 0 };
  const settled = new Date(now - RECONCILE_AFTER_MS).toISOString();
  for (const d of await s.decisions.inFlight()) {
    if (d.decidedAt && d.decidedAt > settled) continue;
    const cur = await currentTargets(s, d, deps);
    if (!drift(cur, d.after)) {
      if (!(await s.decisions.markApplied(d.id, cur, { syncHoldUntil: d.syncHoldUntil }))) continue;
      if (d.decidedBy) await s.decisions.markStatus(d.id, { status: 'applied', from: ['applied'], by: d.decidedBy });
      out.applied++;
    } else if (cur.every((n) => n.fingerprint === snapshotOf(d.before, n).fingerprint || n.fingerprint === snapshotOf(d.after, n).fingerprint)) {
      if (drift(cur, d.before)) await handlerFor(d.type).rollback(handlerContext(s, deps, d.decidedBy ?? ''), d, cur);
      if (await s.decisions.markStatus(d.id, { status: 'proposed', from: ['applying'] })) out.proposed++;
    } else if (await s.decisions.markStatus(d.id, { status: 'overridden', from: ['applying'] })) out.overridden++;
  }
  return out;
}
