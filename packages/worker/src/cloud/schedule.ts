import { nextSyncDelayMs, redactSecrets, type CloudSyncResult, type CloudSyncStatus } from '@fb/core';

/**
 * Automatic cloud sync: once at start, then every SYNC_INTERVAL_MINUTES, doubling the wait after each failed run (at
 * most a day) until one succeeds. With no interval it never runs; Sync now in Settings still works (the api runs it).
 */
export class CloudSyncSchedule {
  readonly status: CloudSyncStatus;
  private readonly d: {
    host: string;
    intervalMinutes: number | null;
    run: () => Promise<CloudSyncResult>;
    now?: () => number;
    log: (msg: string, extra?: object) => void;
  };
  private due = 0;
  private running: Promise<void> | null = null;

  constructor(d: CloudSyncSchedule['d']) {
    this.d = d;
    this.status = { host: d.host, intervalMinutes: d.intervalMinutes, lastAt: null, lastOk: null, lastError: null, lastSent: null, nextAt: null, failures: 0 };
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

  private async runOnce() {
    const interval = this.d.intervalMinutes!;
    try {
      const r = await this.d.run();
      this.status.lastAt = r.at;
      this.status.lastOk = r.ok;
      this.status.lastError = r.error;
      this.status.lastSent = r.sent;
      this.status.failures = r.ok ? 0 : this.status.failures + 1;
      this.d.log(r.ok ? 'cloud sync' : 'cloud sync failed', {
        host: r.host,
        sent: r.sent,
        projects: r.projects.map((p) => ({ key: p.key, status: p.status })),
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (err) {
      this.status.lastAt = new Date(this.now()).toISOString();
      this.status.lastOk = false;
      this.status.lastError = redactSecrets(String(err)).slice(0, 500);
      this.status.failures += 1;
      this.d.log('cloud sync failed', { host: this.d.host, error: this.status.lastError });
    }
    this.due = this.now() + nextSyncDelayMs(interval, this.status.failures);
    this.status.nextAt = new Date(this.due).toISOString();
  }
}
