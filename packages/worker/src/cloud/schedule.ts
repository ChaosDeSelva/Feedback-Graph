import { nextSyncDelayMs, redactSecrets, type CloudSyncResult, type CloudSyncStatus } from '@fb/core';

/**
 * Automatic cloud sync: once at start, then every SYNC_INTERVAL_MINUTES. A project whose send fails backs off alone
 * (the interval doubled per failure in a row, at most a day) while the others keep their interval: one project the
 * cloud refuses (a 422, a 413 its code map cannot explain) never slows the rest. Only a run that stops for everyone
 * (a 401/403, or one that throws) backs the whole schedule off the same way. With no interval it never runs; Sync now
 * in Settings still works (the api runs it, and ignores this backoff: someone asked).
 */
export class CloudSyncSchedule {
  readonly status: CloudSyncStatus;
  private readonly d: {
    host: string;
    last?: CloudSyncResult | null;
    intervalMinutes: number | null;
    /** `waiting(key)`: when a backing-off project is tried again (ISO), else null (runCloudSync's `waiting`). */
    run: (waiting: (key: string) => string | null) => Promise<CloudSyncResult>;
    now?: () => number;
    log: (msg: string, extra?: object) => void;
  };
  private due = 0;
  private running: Promise<void> | null = null;
  /** Per project: failures in a row, when it is tried again, and the last error. */
  private readonly backoff = new Map<string, { failures: number; due: number; error: string | null }>();

  constructor(d: CloudSyncSchedule['d']) {
    this.d = d;
    this.status = { host: d.host, intervalMinutes: d.intervalMinutes, lastAt: d.last?.at ?? null, lastOk: d.last?.ok ?? null, lastError: d.last?.error ?? null, lastSent: d.last?.sent ?? null, nextAt: null, failures: 0, waiting: [] };
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** Run a sync if one is due. Never throws; concurrent calls share one run. */
  tick(): Promise<void> {
    if (this.d.intervalMinutes === null) return Promise.resolve();
    if (this.running) return this.running;
    if (this.now() < this.due) return Promise.resolve();
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private readonly waiting = (key: string): string | null => {
    const b = this.backoff.get(key);
    return b && this.now() < b.due ? new Date(b.due).toISOString() : null;
  };

  private async runOnce() {
    const interval = this.d.intervalMinutes!;
    try {
      const r = await this.d.run(this.waiting);
      this.status.lastAt = r.at;
      this.status.lastOk = r.ok;
      this.status.lastError = r.error;
      this.status.lastSent = r.sent;
      this.status.failures = r.stopped ? this.status.failures + 1 : 0;
      // Only what was tried moves a project's backoff: a stopped run says nothing about the projects it did not reach.
      for (const p of r.projects) {
        if (p.status === 'failed') {
          const failures = (this.backoff.get(p.key)?.failures ?? 0) + 1;
          this.backoff.set(p.key, { failures, due: this.now() + nextSyncDelayMs(interval, failures), error: p.error ?? null });
        } else if (p.status !== 'waiting' && p.status !== 'not sent') this.backoff.delete(p.key);
      }
      this.d.log(r.ok ? 'cloud sync' : 'cloud sync failed', {
        host: r.host,
        sent: r.sent,
        projects: r.projects.map((p) => ({ key: p.key, status: p.status, ...(p.until ? { until: p.until } : {}) })),
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (err) {
      this.status.lastAt = new Date(this.now()).toISOString();
      this.status.lastOk = false;
      this.status.lastError = redactSecrets(String(err)).slice(0, 500);
      this.status.failures += 1;
      this.d.log('cloud sync failed', { host: this.d.host, error: this.status.lastError });
    }
    this.status.waiting = [...this.backoff].map(([key, b]) => ({ key, failures: b.failures, until: new Date(b.due).toISOString(), error: b.error }));
    // The next run: the interval (longer after runs that stopped), or sooner when a waiting project's turn comes first.
    const next = this.now() + nextSyncDelayMs(interval, this.status.failures);
    const soonest = Math.min(...[...this.backoff.values()].map((b) => b.due).filter((t) => t > this.now()));
    this.due = this.status.failures ? next : Math.min(next, soonest);
    this.status.nextAt = new Date(this.due).toISOString();
  }
}
