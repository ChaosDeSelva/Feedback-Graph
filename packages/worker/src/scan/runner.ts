import { providerUnavailableReason, SCAN_PARK_GAVE_UP, type FactsStore, type ScanJob } from '@fb/core';

/** A scan whose model has failed every readiness probe for this long is failed with the reason, not parked again. */
export const SCAN_PARK_LIMIT_MS = 24 * 3600_000;
const PARKED = /^scan parked on ([^:]+):/;

/** The provider a queued job's park message names, or null when it is not parked. */
export const parkedOn = (job: Pick<ScanJob, 'error'>): string | null => job.error?.match(PARKED)?.[1]?.trim() ?? null;

/**
 * Refresh even old/future parked jobs so every project explains the same provider outage. A job parked for more than
 * SCAN_PARK_LIMIT_MS (from when its first probe failed, across restarts) is failed with the reason instead: a provider
 * down for a day needs the owner, and a queued job never counts an attempt, so it would otherwise wait for good.
 */
export async function parkScanProvider(facts: Pick<FactsStore, 'scanQueue' | 'updateScanJob'>, provider: string, fallback: string, reason: string, retryAt: string, now = Date.now()): Promise<void> {
  const clean = reason.trim().replace(/[.;:\s]+$/, '');
  const error = `scan parked on ${provider}: ${clean}. Readiness will be checked again with backoff before the repository is copied.`;
  for (const job of await facts.scanQueue()) {
    if (job.status !== 'queued' || (job.provider?.trim() || fallback) !== provider) continue;
    const since = job.parkedAt ?? new Date(now).toISOString();
    if (now - Date.parse(since) > SCAN_PARK_LIMIT_MS) {
      await facts.updateScanJob(job.id, {
        status: 'failed', retryAt: null, parkedAt: null,
        error: `${SCAN_PARK_GAVE_UP}${provider} (since ${since}): ${clean}. Fix it, or choose another scan model (SCAN_LLM, or the project's scan model), then scan again.`,
      });
      continue;
    }
    // The error names the resolved default even when the immutable request field is null, so the UI can avoid it.
    await facts.updateScanJob(job.id, { error, retryAt, parkedAt: since });
  }
}

/**
 * Queued jobs parked on a provider they no longer resolve to (SCAN_LLM changed since): the old park reason, its
 * backoff and its park time are cleared, so each runs now on the current model and no page shows the old outage.
 */
export async function clearStaleParks(facts: Pick<FactsStore, 'scanQueue' | 'updateScanJob'>, resolve: (job: ScanJob) => string): Promise<number> {
  let n = 0;
  for (const job of await facts.scanQueue()) {
    const on = parkedOn(job);
    if (job.status !== 'queued' || !on || on === resolve(job)) continue;
    await facts.updateScanJob(job.id, { error: null, retryAt: null, parkedAt: null });
    n++;
  }
  return n;
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
  /** The job's model answered its readiness probe: a park reason or park time it still carries is cleared. */
  unpark?(job: ScanJob): Promise<void>;
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
          const reason = providerUnavailableReason(err) ?? (err instanceof Error ? err.message : String(err));
          await this.d.parkProvider?.(key, reason, new Date(now + delay).toISOString());
          this.d.log?.('scan provider parked; readiness will be checked without copying repositories', { provider: key, retryAt: new Date(now + delay).toISOString(), error: reason });
          passedOver.push(job.id);
          if (passedOver.length >= MAX_PASSED_OVER) return;
          continue;
        }
        // It answers now (or the job resolves to another model since): the old outage no longer explains this job.
        if (job.parkedAt || parkedOn(job)) await this.d.unpark?.(job);
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
