/** Bounded FIFO admission. Timed-out callers leave the queue; uncooperative running calls keep their real slot. */
export type Turn = { signal: AbortSignal; deadline: number };
export type QueueState = 'waiting' | 'running' | 'completed' | 'retry_required';
export type QueueInfo = {
  state: QueueState; capacity: number; running: number; waiting: number;
  /** 1 is next waiting; null means this request holds no waiting position. */
  position: number | null; nextRetryPosition: number; arrivalAhead: number | null; retained: boolean;
  estimate: { scope: 'judge'; source: 'observed' | 'response_budget' | 'measured'; samples: number; startMs: [number, number | null]; completionMs: [number, number | null]; medianStartMs?: number | null; medianCompletionMs?: number | null; overdue: boolean };
  retryAfterMs: number | null;
  /** shared: this request made no judge call of its own; it joined an identical running call or reused its kept result. */
  observed?: { waitedMs: number; serviceMs: number; shared?: 'joined' | 'reused' };
  /** An identical retry joins this judge call, still running elapsedMs after it started, instead of queueing anew. */
  inFlight?: { elapsedMs: number };
  retryPriority?: { retained: boolean; restored: boolean; remainingMs: number };
};
export type Admitted<T> =
  | { ok: true; value: T; ahead: number; waitedMs: number }
  | { ok: false; ahead: number; waitedMs: number; ran: boolean };
type Ticket = { go: () => void; notify?: (info: QueueInfo) => void; ahead: number; ordinal: number; retryKey?: string; restored?: boolean; started?: boolean; result?: Promise<unknown>; ready?: Promise<{ result: Promise<unknown> } | null>; readyResolve?: (value: { result: Promise<unknown> } | null) => void; serviceStarted?: number; finishedAt?: number; lease?: ReturnType<typeof setTimeout>; leaseUntil?: number; abandon?: () => void; overran?: boolean };

/** A kept-alive call that ran to its service deadline (maxServiceMs) without an answer: a result, not a busy queue. */
export class ServiceOverrun extends Error {}

/** Observed services before the queue decides from them whether a call can finish in time (as #service's p90 needs). */
export const PLANNING_SAMPLES = 10;
/** How far past its service deadline a kept-alive call's provider may run: the lease ends it first, as overran. */
export const OVERRUN_GRACE_MS = 1000;

export class Admission {
  readonly concurrency: number;
  readonly timeoutMs: number;
  #running = 0;
  readonly #queue: Ticket[] = [];
  readonly #active = new Map<Ticket, { started: number; deadline: number }>();
  readonly #durations: number[] = [];
  #ordinal = 0;
  readonly #priorities = new Map<string, { ordinal: number; expiresAt: number }>();
  readonly #requests = new Map<string, Ticket>();
  readonly #priorityMs: number;
  readonly #priorityLimit: number;
  readonly #maxServiceMs: number;
  /**
   * maxServiceMs: the longest a kept-alive (retry-keyed) call may run (CHECK_WAIT_SECONDS), as long as identical retries
   * keep coming for it; one nobody came back for within the retry window is abandoned sooner. Default: the retry window.
   */
  constructor(o: { concurrency: number; timeoutMs: number; retryPriorityMs?: number; retryPriorityLimit?: number; maxServiceMs?: number }) {
    this.concurrency = Math.max(1, Math.trunc(o.concurrency));
    this.timeoutMs = o.timeoutMs;
    this.#priorityMs = Math.max(1, o.retryPriorityMs ?? 120000);
    this.#priorityLimit = Math.max(1, o.retryPriorityLimit ?? 1024);
    this.#maxServiceMs = Math.max(this.timeoutMs, this.#priorityMs, o.maxServiceMs ?? 0);
  }
  get running(): number { return this.#running; }
  get waiting(): number { return this.#queue.length; }

  /** Observed service scenarios: p25, the upper tail and the median; the response budget before any observation. */
  #service() {
    const samples = [...this.#durations].sort((a, b) => a - b);
    const observed = samples.length > 0;
    const low = observed ? samples[Math.floor((samples.length - 1) * .25)] : 0;
    // With enough history, one pathological provider call must not inflate every planning window: the p90 is the
    // upper scenario once ten observations exist. During cold sampling, 2.5x the slowest call stands in for it.
    const high = !observed ? this.timeoutMs : samples.length < 10 ? Math.ceil(samples.at(-1)! * 2.5) : Math.max(low, samples[Math.floor((samples.length - 1) * .9)]);
    const median = observed ? samples[Math.floor((samples.length - 1) / 2)] : 0;
    return { samples: samples.length, observed, low, high, median };
  }

  /**
   * What is left of a call already `elapsed` into its service, from the observed services that lasted longer (p25,
   * median, p90; before ten observations, 2.5 times the slowest as in #service). A call slower than every
   * observation has shown itself slow: as long again as it has run is the guess, never past its deadline. Without
   * observations: nothing to go on below the deadline. A call twenty minutes in is never "6 s from done" because the
   * calls that did finish took 6 s.
   */
  #left(elapsed: number, untilDeadline: number) {
    const { observed, high } = this.#service();
    const longer = this.#durations.filter((s) => s > elapsed).sort((a, b) => a - b);
    const at = (f: number) => longer[Math.floor((longer.length - 1) * f)] - elapsed;
    const cap = (ms: number) => Math.max(0, Math.min(ms, untilDeadline));
    if (!observed) return { low: 0, median: cap(untilDeadline), high: cap(untilDeadline) };
    if (!longer.length) return { low: 0, median: cap(elapsed), high: cap(untilDeadline) };
    return { low: cap(at(.25)), median: cap(at(.5)), high: cap(Math.max(longer.length < 10 ? high - elapsed : at(.9), at(.5))) };
  }

  /** Estimate the next retry's place from live capacity. Windows are scenarios, never guaranteed upper bounds. */
  snapshot(state: QueueState = 'retry_required', position: number | null = null, arrivalAhead: number | null = null, retryPosition?: number): QueueInfo {
    const { samples, observed, low, high, median } = this.#service();
    const now = Date.now();
    let overdue = false;
    const available = [[], [], []] as number[][];
    for (const active of this.#active.values()) {
      const past = now >= active.deadline;
      if (past) overdue = true;
      // Each running call's remaining service given how long it has run (#left); it still ends by its own service
      // deadline, so only one past it is unknown.
      const left = this.#left(Math.max(0, now - active.started), active.deadline - now);
      available[0].push(left.low);
      available[1].push(past ? Infinity : left.high);
      available[2].push(past ? Infinity : left.median);
    }
    while (available[0].length < this.concurrency) { available[0].push(0); available[1].push(0); available[2].push(0); }
    const order = position ?? retryPosition ?? this.waiting + 1;
    const starts = available.map((allSlots, side) => {
      const slots = allSlots.filter(Number.isFinite);
      if (!slots.length) return Infinity;
      slots.sort((a, b) => a - b);
      // Each slot's remaining scenario is within one service duration, so FIFO waves interleave in this order.
      return slots[(order - 1) % slots.length] + Math.floor((order - 1) / slots.length) * ([low, high, median][side]);
    });
    const started = state === 'running' || state === 'completed';
    const startMs: [number, number | null] = started ? [0, 0] : [starts[0], Number.isFinite(starts[1]) ? starts[1] : null];
    const completionMs: [number, number | null] = state === 'completed' ? [0, 0] : [startMs[0] + low, startMs[1] === null ? null : startMs[1] + high];
    return { state, capacity: this.concurrency, running: this.running, waiting: this.waiting,
      position: state === 'waiting' ? position : null, nextRetryPosition: retryPosition ?? this.waiting + 1, arrivalAhead, retained: state === 'waiting' || state === 'running',
      estimate: { scope: 'judge', source: observed ? 'observed' : 'response_budget', samples, startMs, completionMs, ...(observed && { medianStartMs: Number.isFinite(starts[2]) ? starts[2] : null, medianCompletionMs: Number.isFinite(starts[2]) ? starts[2] + median : null }), overdue },
      retryAfterMs: state === 'retry_required' ? Math.max(1000, Math.min(60_000, Math.ceil(Number.isFinite(starts[2]) ? starts[2] : (startMs[0] || this.timeoutMs)))) : null };
  }
  #notifyWaiting() {
    this.#queue.forEach((ticket, index) => ticket.notify?.(this.#info(ticket, 'waiting', index + 1)));
  }
  #prune() { for (const [key, value] of this.#priorities) if (value.expiresAt <= Date.now()) this.#priorities.delete(key); }
  #retain(ticket: Ticket) {
    if (!ticket.retryKey) return;
    this.#prune();
    this.#priorities.set(ticket.retryKey, { ordinal: ticket.ordinal, expiresAt: Date.now() + this.#priorityMs });
    while (this.#priorities.size > this.#priorityLimit) this.#priorities.delete(this.#priorities.keys().next().value!);
  }
  #info(ticket: Ticket, state: QueueState, position: number | null = null): QueueInfo {
    this.#prune();
    const priority = ticket.retryKey ? this.#priorities.get(ticket.retryKey) : undefined;
    const retryPosition = priority ? (() => {
      const ahead = new Set<number>();
      for (const other of this.#queue) if (other.ordinal < priority.ordinal) ahead.add(other.ordinal);
      for (const other of this.#priorities.values()) if (other.ordinal < priority.ordinal) ahead.add(other.ordinal);
      return ahead.size + 1;
    })() : undefined;
    const info: QueueInfo = { ...this.snapshot(state, position, ticket.ahead, retryPosition), ...(ticket.retryKey && { retryPriority: {
      retained: !!priority, restored: !!ticket.restored, remainingMs: priority ? Math.max(0, priority.expiresAt - Date.now()) : 0,
    } }) };
    // A kept-alive call still in service: an identical retry joins it, so what matters is its remaining service, not
    // a fresh place in the queue.
    const active = state === 'retry_required' && ticket.started && this.#requests.get(ticket.retryKey!) === ticket ? this.#active.get(ticket) : undefined;
    const now = Date.now();
    if (!active || now >= active.deadline) return info;
    const elapsed = Math.max(0, now - active.started);
    const left = this.#left(elapsed, active.deadline - now);
    return { ...info, inFlight: { elapsedMs: elapsed }, estimate: { ...info.estimate, startMs: [0, 0], completionMs: [left.low, left.high], medianStartMs: 0, medianCompletionMs: left.median },
      retryAfterMs: Math.max(1000, Math.min(60_000, Math.ceil(left.median))) };
  }
  /** arrivedAt: when this request reached the queue, kept when a released joiner competes again. */
  async run<T>(fn: (turn: Turn) => Promise<T>, options: { signal?: AbortSignal; deadline?: number; onState?: (info: QueueInfo) => void; retryKey?: string } = {}, arrivedAt = Date.now()): Promise<Admitted<T>> {
    const started = arrivedAt;
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, (options.deadline ?? Infinity) - started));
    const remainingMs = Math.max(1, started + timeoutMs - Date.now());
    const existing = options.retryKey ? this.#requests.get(options.retryKey) : undefined;
    if (existing && (existing.result || existing.ready)) {
      const reused = existing.finishedAt !== undefined;
      // Someone came back for it: keep it running through this request's wait and the retry window after it.
      if (!reused) this.#lease(existing, remainingMs + this.#priorityMs);
      if (!reused) options.onState?.(this.#info(existing, existing.started ? 'running' : 'waiting', existing.started ? null : this.#queue.indexOf(existing) + 1));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), remainingMs); });
      const joined = existing.result ?? existing.ready!.then(box => box?.result ?? null);
      const completed = await Promise.race([joined.then(value => ({ value })), timeout]);
      clearTimeout(timer);
      if (completed === 'timeout') {
        this.#retain(existing); options.onState?.(this.#info(existing, 'retry_required'));
        return { ok: false, ahead: existing.ahead, waitedMs: Date.now() - started, ran: !!existing.started };
      }
      // The original queued request expired before service. Its joiners are released to compete normally with the
      // time remaining on their own response deadline instead of waiting forever on an unresolved promise; their
      // reported wait still counts from their own arrival.
      if (completed.value === null) return this.run(fn, options, started);
      // A joiner did not make the call: its wait runs to the shared call's start (or none), its service to the result.
      const finished = reused ? started : Date.now();
      // A call with a result has started service.
      const serviceStart = Math.max(started, existing.serviceStarted!);
      const observed = { waitedMs: Math.max(0, serviceStart - started), serviceMs: Math.max(0, finished - serviceStart), shared: reused ? 'reused' as const : 'joined' as const };
      const done = this.#info(existing, 'completed');
      const totalMs = observed.waitedMs + observed.serviceMs;
      options.onState?.({ ...done, observed, estimate: { ...done.estimate, source: 'measured', startMs: [observed.waitedMs, observed.waitedMs], completionMs: [totalMs, totalMs], medianStartMs: observed.waitedMs, medianCompletionMs: totalMs } });
      return { ok: true, value: completed.value as T, ahead: existing.ahead, waitedMs: observed.waitedMs };
    }
    const gaveUp = new AbortController();
    let ahead = this.#running < this.concurrency && !this.#queue.length ? 0 : this.#running + this.#queue.length;
    this.#prune();
    const key = options.retryKey && !this.#requests.has(options.retryKey) ? options.retryKey : undefined;
    const priority = key ? this.#priorities.get(key) : undefined;
    if (key) this.#priorities.delete(key);
    const ticket: Ticket = { go: () => {}, ahead, notify: options.onState, ordinal: priority?.ordinal ?? ++this.#ordinal,
      retryKey: key, restored: !!priority };
    if (key) {
      ticket.ready = new Promise(resolve => { ticket.readyResolve = resolve; });
      this.#requests.set(key, ticket);
    }
    let timer: NodeJS.Timeout | undefined;
    let stop!: () => void;
    let timedOut = false;
    const expired = () => timedOut || options.signal?.aborted || Date.now() >= started + timeoutMs;
    const cancelledBeforeStart = new Error('admission cancelled before service started');
    const deadline = new Promise<'timeout'>((r) => { stop = () => {
      timedOut = true;
      const at = this.#queue.indexOf(ticket);
      if (at >= 0) { this.#queue.splice(at, 1); this.#notifyWaiting(); }
      this.#retain(ticket); ticket.notify?.(this.#info(ticket, 'retry_required'));
      r('timeout');
    }; timer = setTimeout(stop, remainingMs); });
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    try {
      if (timedOut) { ticket.notify?.(this.#info(ticket, 'retry_required')); return { ok: false, ahead, waitedMs: 0, ran: false }; }
      if (ahead) {
        const turn = new Promise<'go'>((r) => { ticket.go = () => r('go'); });
        const at = this.#queue.findIndex(other => other.ordinal > ticket.ordinal);
        ahead = this.#running + (at < 0 ? this.#queue.length : at); ticket.ahead = ahead;
        if (at < 0) this.#queue.push(ticket); else this.#queue.splice(at, 0, ticket);
        this.#notifyWaiting();
        // The deadline wins only while the ticket is still queued (a granted turn settles first): stop() took it out
        // of the queue and told it and the waiters.
        if ((await Promise.race([turn, deadline])) === 'timeout') return { ok: false, ahead, waitedMs: Date.now() - started, ran: false };
      } else this.#running++;
      const waitedMs = Date.now() - started;
      if (expired()) {
        this.#release(); ticket.notify?.(this.#info(ticket, 'retry_required'));
        return { ok: false, ahead, waitedMs, ran: false };
      }
      const serviceStarted = Date.now();
      // A provider call with only a few milliseconds left cannot produce a verdict and poisons the duration sample.
      // Retain the retry's priority instead of starting work that is certain to be aborted.
      if (ticket.retryKey && waitedMs > 0 && started + timeoutMs - serviceStarted < 250) {
        this.#retain(ticket); this.#release(); ticket.notify?.(this.#info(ticket, 'retry_required'));
        return { ok: false, ahead, waitedMs, ran: false };
      }
      // A call that cannot finish in what is left of the response budget, judged by the services observed (once there
      // are PLANNING_SAMPLES of them, so one odd call decides nothing): an unkeyed one (cancelled at the response
      // deadline) is not started once this request has waited, since even the fast scenario (p25) overruns; a
      // retry-keyed one starts, but the response does not wait out a budget its median cannot fit: it answers now, and
      // the retry joins the call.
      const service = this.#service();
      const planned = service.samples >= PLANNING_SAMPLES;
      const budgetLeft = started + timeoutMs - serviceStarted;
      if (!ticket.retryKey && planned && waitedMs > 0 && budgetLeft < service.low) {
        this.#release(); ticket.notify?.(this.#info(ticket, 'retry_required'));
        return { ok: false, ahead, waitedMs, ran: false };
      }
      const hopeless = !!ticket.retryKey && planned && budgetLeft < service.median;
      ticket.serviceStarted = serviceStarted;
      let called = false;
      // A check response may have to return at ~50 s, but identical retries must be able to join the in-flight
      // provider result. A service window of one response budget ended the call just as the advised retry arrived
      // (a model as slow as the budget never finished, and each retry started it again); one of the retry window did
      // the same to a model slower than two minutes, so its checks stayed queued for good. Admitted retry-keyed work
      // runs up to maxServiceMs while identical retries keep coming back for it (#lease), and is abandoned once none
      // has for a retry window.
      const serviceDeadline = ticket.retryKey ? serviceStarted + this.#maxServiceMs : started + timeoutMs;
      this.#active.set(ticket, { started: serviceStarted, deadline: serviceDeadline });
      ticket.notify?.(this.#info(ticket, 'running'));
      if (expired()) {
        this.#active.delete(ticket); this.#release(); ticket.notify?.(this.#info(ticket, 'retry_required'));
        return { ok: false, ahead, waitedMs, ran: false };
      }
      let begun!: () => void;
      const begins = new Promise<void>((resolve) => { begun = resolve; });
      const call = Promise.resolve().then(() => {
        begun();
        if (expired()) throw cancelledBeforeStart;
        called = true; ticket.started = true;
        // The provider gets a little past the service deadline, so the lease (#lease) is what ends an overrun call,
        // and the failure can say so.
        return fn({ signal: gaveUp.signal, deadline: ticket.retryKey ? serviceDeadline + OVERRUN_GRACE_MS : serviceDeadline });
      }).catch((error: unknown) => {
        if (!ticket.overran) throw error;
        throw new ServiceOverrun(`no answer within ${Math.round(this.#maxServiceMs / 1000)} s, CHECK_WAIT_SECONDS`);
      });
      if (ticket.retryKey) {
        ticket.abandon = () => gaveUp.abort(new Error(ticket.overran ? 'past the service deadline' : 'no identical retry came back for this judge call'));
        this.#lease(ticket, Math.max(0, started + timeoutMs - Date.now()) + this.#priorityMs);
      }
      const settle = (ok: boolean) => {
        clearTimeout(ticket.lease);
        ticket.finishedAt = Date.now();
        if (called) {
          this.#durations.push(Math.max(1, Date.now() - serviceStarted));
          if (this.#durations.length > 64) this.#durations.shift();
        }
        this.#active.delete(ticket); this.#release();
        if (!ticket.retryKey) return;
        // Keep a completed result through the advertised retry window: an obedient retry should receive it, not lose
        // priority and start the same provider call again. So is a call that ran to its service deadline (maxServiceMs):
        // the retry gets that failure, not a fresh call certain to overrun the same way (each one started anew kept a
        // check queued for good). Any other failure (a provider error) is dropped at once, even when its own caller
        // already got a queued reply, so a retry starts afresh.
        const drop = () => { if (this.#requests.get(ticket.retryKey!) === ticket) this.#requests.delete(ticket.retryKey!); };
        if (ok || ticket.overran) setTimeout(drop, this.#priorityMs).unref?.(); else drop();
      };
      call.then(() => settle(true), () => settle(false));
      ticket.result = call;
      ticket.readyResolve?.({ result: call });
      // A hopeless call answers once it has started (or was cancelled before it could: that throws here).
      if (hopeless) await begins.then(() => (called ? null : call));
      const r = hopeless ? 'timeout' as const : await Promise.race([call.then((value) => ({ value })), deadline]);
      if (r === 'timeout') {
        call.catch(() => {});
        // The response deadline is not the provider deadline. Keep retry-keyed work alive so the advertised retry
        // can join it; unkeyed callers retain the old cancellation behaviour.
        if (!ticket.retryKey) gaveUp.abort(new Error(`gave up after ${Math.round(this.timeoutMs / 1000)} s`));
        ticket.notify?.(this.#info(ticket, 'retry_required'));
        return { ok: false, ahead, waitedMs, ran: called };
      }
      const serviceMs = Math.max(0, Date.now() - serviceStarted);
      const completed = this.#info(ticket, 'completed');
      ticket.notify?.({ ...completed, observed: { waitedMs, serviceMs }, estimate: { ...completed.estimate, source: 'measured', startMs: [waitedMs, waitedMs], completionMs: [waitedMs + serviceMs, waitedMs + serviceMs], medianStartMs: waitedMs, medianCompletionMs: waitedMs + serviceMs } });
      return { ok: true, value: r.value, ahead, waitedMs };
    } catch (error) {
      ticket.notify?.(this.#info(ticket, 'retry_required'));
      if (error !== cancelledBeforeStart) throw error;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', stop);
      if (!ticket.started && ticket.retryKey && this.#requests.get(ticket.retryKey) === ticket) {
        this.#requests.delete(ticket.retryKey);
        ticket.readyResolve?.(null);
      }
    }
    // Only a call cancelled before it started gets here.
    return { ok: false, ahead, waitedMs: Date.now() - started, ran: false };
  }
  /**
   * Keep a started retry-keyed call alive for at least `ms` more (never past its service deadline): each request that
   * starts or joins it extends this. When it runs out, nobody is coming back for the call (abandoned) or the call has
   * reached its deadline (overran); either way it is aborted.
   */
  #lease(ticket: Ticket, ms: number) {
    const active = this.#active.get(ticket);
    if (!active || !ticket.abandon) return;
    const until = Math.min(Math.max(Date.now() + ms, ticket.leaseUntil ?? 0), active.deadline);
    ticket.leaseUntil = until;
    clearTimeout(ticket.lease);
    ticket.lease = setTimeout(() => {
      ticket.overran = until >= active.deadline;
      ticket.abandon!();
    }, Math.max(0, until - Date.now()));
    ticket.lease.unref?.();
  }
  #release() {
    const next = this.#queue.shift();
    if (next) next.go(); else this.#running--;
    this.#notifyWaiting();
  }
}
