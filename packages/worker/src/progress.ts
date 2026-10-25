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

/**
 * Whether a round of the worker loop did work you are waiting for, so it goes again without sleeping: turns
 * classified, post-mortems written, an upload read. The relevance backfill (`scored`) is not: it takes one batch per
 * wake, last in line, and would otherwise keep the loop (and its scope refresh, ingest and sync checks) spinning for
 * as long as old facts remain unscored.
 */
export function cycleProgressed(r: { turnsClassified: number; postmortems: number; docRead: boolean; scored: number }): boolean {
  return r.turnsClassified > 0 || r.postmortems > 0 || r.docRead;
}
