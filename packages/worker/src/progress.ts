import type { ProviderHealth, WorkerStageName, WorkerStatus } from '@fb/core';

/** Steps that count their items without a total (ingest reads only the transcripts that changed). */
const COUNTED = new Set<WorkerStageName>(['ingest']);

/**
 * What the worker is doing right now, kept in its heartbeat status (WorkerStatus.stage) so /api/status can say which
 * step runs, since when, and how far it got. `changed` is called on every change (main.ts beats soon after).
 */
export class StageTracker {
  private status: WorkerStatus;
  private changed: () => void;
  private now: () => Date;

  constructor(status: WorkerStatus, changed: () => void, now: () => Date = () => new Date()) {
    this.status = status;
    this.changed = changed;
    this.now = now;
  }

  /** Start a step. `total`: its items, when known (done counts from 0). Waiting again keeps when waiting began. */
  enter(name: WorkerStageName, o: { total?: number; current?: string } = {}) {
    if (name === 'waiting' && this.status.stage?.name === 'waiting') return;
    this.status.stage = {
      name,
      startedAt: this.now().toISOString(),
      done: o.total !== undefined || COUNTED.has(name) ? 0 : null,
      total: o.total ?? null,
      current: o.current ?? null,
    };
    this.changed();
  }

  /** One item of the current step taken up (or finished): counted, and named as the item in hand. */
  step(current: string) {
    const s = this.status.stage;
    if (!s) return;
    s.current = current;
    if (s.done !== null) s.done++;
    this.changed();
  }
}

/** A job's health with `since`: when this run of failures began (same provider), cleared once it answers. */
export function healthSince(prev: ProviderHealth | undefined, next: ProviderHealth): ProviderHealth {
  if (next.ok) {
    const { since: _, ...rest } = next;
    return rest;
  }
  const since = prev && !prev.ok && prev.provider === next.provider ? (prev.since ?? prev.at) : next.at;
  return { ...next, since };
}
