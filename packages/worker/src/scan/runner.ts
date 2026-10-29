import type { FactsStore, ScanJob } from '@fb/core';

/** Refresh even old/future parked jobs so every project explains the same provider outage. */
export async function parkScanProvider(facts: Pick<FactsStore, 'scanQueue' | 'updateScanJob'>, provider: string, fallback: string, reason: string, retryAt: string): Promise<void> {
  const error = `scan parked: ${reason}; checking readiness with backoff before copying the repository`;
  for (const job of await facts.scanQueue()) {
    if (job.status === 'queued' && (job.provider?.trim() || fallback) === provider)
      await facts.updateScanJob(job.id, { error, retryAt });
  }
}

/** What a running scan can ask the runner. */
export type ScanTurn = {
  /**
   * Whether another scan waits for this one's slot (asked between shards): an agentic one while this holds the agentic
   * slot, or any while every slot is taken; true too once the runner is stopping. A waiting scan a free slot can run
   * is started there instead, and is no reason to give way.
   */
  waiting(): Promise<boolean>;
};

export type ScanRunnerDeps = {
  /** The due queued job that has waited longest, other than these ids (FactsStore.nextScanJob). */
  next(exclude: string[]): Promise<ScanJob | null>;
  /** Whether the job's model explores the repo itself (codex-cli, claude-cli): those run one at a time. */
  agentic(job: ScanJob): boolean;
  /** No file worth scanning: the job is run at once, outside the slots (it finishes without a model call). */
  empty(job: ScanJob): Promise<boolean>;
  /**
   * Run one job to its end (done, failed, or queued again with a retryAt). True when it finished; false when it went
   * back to wait, so the runner does not pick the queue up again on its own (the worker loop kicks it next cycle).
   */
  run(job: ScanJob, turn: ScanTurn): Promise<boolean>;
  /** SCAN_CONCURRENCY. */
  concurrency: number;
  /** A failed probe parks this provider with exponential backoff; no scan or mirror starts. */
  ready?(job: ScanJob): Promise<void>;
  providerKey?(job: ScanJob): string;
  parkProvider?(provider: string, error: string, retryAt: string): Promise<void>;
  now?(): number;
  log?: (msg: string, extra?: object) => void;
};

/** Agentic scans at once: the codex runner takes one job at a time, and a CLI agent per repo is heavy. */
const AGENTIC_SLOTS = 1;
/**
 * Jobs one fill passes over (no free slot, or the agentic one taken) while it looks behind them for an empty project
 * or a per-file job that can start, so a long queue costs few queries.
 */
const MAX_PASSED_OVER = 20;
/** A scan with no code files finishes without a model call: nothing to give way for. */
const NO_TURN: ScanTurn = { waiting: async () => false };

/**
 * Scans beside the worker cycle: up to `concurrency` at once, agentic ones one at a time, so a queue of 70 projects
 * no longer waits for one scan per cycle behind classification. kick() fills free slots and returns at once; a slot
 * that frees up fills itself. Jobs are claimed one at a time (fill is never concurrent), so no job runs twice.
 * Fair across projects: a sharded scan asks after each shard whether another scan waits for its slot (ScanTurn) and,
 * when one does, goes back in the queue behind it, so a 40-shard scan takes turns with small ones instead of holding
 * the agentic slot for hours.
 */
export class ScanRunner {
  private readonly d: ScanRunnerDeps;
  private readonly active = new Map<string, { agentic: boolean; done: Promise<void> }>();
  private filling: Promise<void> | null = null;
  private refill = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Jobs already found to have files, so a job waiting for a slot is not listed again on every fill. */
  private readonly blocked = new Map<string, { until: number; failures: number }>();
  private readonly hasFiles = new Set<string>();
  /**
   * Jobs that gave way (waiting() said true), with whether they held the agentic slot: passed over while any other job
   * can be had, so a job that gave way never gets its slot straight back while another waits, whatever the queue's
   * order. Dropped when it starts again, or once another job takes the kind of slot it gave up.
   */
  private readonly yielded = new Map<string, boolean>();

  constructor(d: ScanRunnerDeps) {
    this.d = d;
  }

  /** Independent of sync/ingest latency; kick serializes queue fills. */
  startPolling(intervalMs = 2_000): void {
    if (this.stopped || this.timer) return;
    this.kick();
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref?.();
  }

  /** Ids of the scans running now, in the order they started. */
  running(): string[] {
    return [...this.active.keys()];
  }

  /** Fill free slots from the queue. Never throws; nothing waits for it. */
  kick(): void {
    if (this.stopped) return;
    if (this.filling) {
      this.refill = true;
      return;
    }
    this.filling = this.fill()
      .catch((err) => this.d.log?.('scan runner: could not read the queue', { error: String(err) }))
      .finally(() => {
        this.filling = null;
        if (this.refill && !this.stopped) {
          this.refill = false;
          this.kick();
        }
      });
  }

  /** Resolves when nothing is being claimed or run (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.filling || this.active.size) {
      await this.filling;
      await Promise.all([...this.active.values()].map((a) => a.done));
    }
  }

  /** Nothing new starts; resolves once the scans running now have finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.idle();
  }

  private async fill(): Promise<void> {
    const passedOver: string[] = [];
    while (!this.stopped) {
      const taken = [...this.active.keys(), ...passedOver];
      // waiting() asked for the next job other than the one running; this asks the same, so a yield goes to it.
      let job = await this.d.next([...taken, ...this.yielded.keys()]);
      if (!job && this.yielded.size) job = await this.d.next(taken);
      if (!job || this.stopped) return;
      if (!this.hasFiles.has(job.id)) {
        if (await this.d.empty(job).catch(() => false)) {
          // Finishes without a model call: no slot, and the queue moves on at once.
          await this.d.run(job, NO_TURN).catch((err) => this.d.log?.('scan runner: a scan threw', { project: job.projectKey, error: String(err) }));
          continue;
        }
        this.hasFiles.add(job.id);
      }
      if (this.d.ready) {
        const key = this.d.providerKey?.(job) || job.provider?.trim() || 'default';
        const blocked = this.blocked.get(key);
        const now = this.d.now?.() ?? Date.now();
        if (blocked && now < blocked.until) {
          passedOver.push(job.id);
          if (passedOver.length >= MAX_PASSED_OVER) return;
          continue;
        }
        try { await this.d.ready(job); this.blocked.delete(key); }
        catch (err) {
          const failures = (blocked?.failures ?? 0) + 1;
          const delay = Math.min(30 * 60_000, 120_000 * 2 ** Math.min(failures - 1, 4));
          this.blocked.set(key, { until: now + delay, failures });
          await this.d.parkProvider?.(key, String(err), new Date(now + delay).toISOString());
          this.d.log?.('scan provider parked; readiness will be checked without copying repositories', { provider: key, retryAt: new Date(now + delay).toISOString(), error: String(err) });
          passedOver.push(job.id);
          if (passedOver.length >= MAX_PASSED_OVER) return;
          continue;
        }
      }
      const agentic = this.d.agentic(job);
      const full = this.active.size >= Math.max(1, this.d.concurrency);
      if (full || (agentic && [...this.active.values()].filter((a) => a.agentic).length >= AGENTIC_SLOTS)) {
        passedOver.push(job.id);
        if (passedOver.length >= MAX_PASSED_OVER) return;
        continue;
      }
      this.hasFiles.delete(job.id);
      this.start(job, agentic);
    }
  }

  /** ScanTurn.waiting for the running job `id`. */
  private async waiting(id: string): Promise<boolean> {
    if (this.stopped) return true;
    const self = this.active.get(id);
    const exclude = [...this.active.keys()];
    for (let i = 0; i < MAX_PASSED_OVER; i++) {
      const other = await this.d.next(exclude).catch(() => null);
      if (!other || this.stopped) return this.stopped;
      exclude.push(other.id);
      const agentic = this.d.agentic(other);
      const full = this.active.size >= Math.max(1, this.d.concurrency);
      // It needs the slot this job holds: the agentic one, or any slot while all are taken. fill() serves it before
      // this job comes round again.
      if (full || (agentic && self?.agentic)) {
        this.yielded.set(id, !!self?.agentic);
        return true;
      }
      // A free slot can run it: start it there and go on.
      if (!agentic) this.kick();
    }
    return false;
  }

  private start(job: ScanJob, agentic: boolean) {
    this.yielded.delete(job.id);
    // Another job took a slot of the kind those gave up (any slot for one that gave way because all were taken).
    for (const [id, heldAgentic] of this.yielded) if (agentic || !heldAgentic) this.yielded.delete(id);
    const turn: ScanTurn = { waiting: () => this.waiting(job.id) };
    const done = (async () => {
      let progressed = false;
      try {
        progressed = await this.d.run(job, turn);
      } catch (err) {
        this.d.log?.('scan runner: a scan threw', { project: job.projectKey, error: String(err) });
      } finally {
        this.active.delete(job.id);
      }
      if (progressed) this.kick();
    })();
    this.active.set(job.id, { agentic, done });
  }
}
