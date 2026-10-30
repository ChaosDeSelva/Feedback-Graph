/** Bounded FIFO admission. Timed-out callers leave the queue; uncooperative running calls keep their real slot. */
export type Turn = { signal: AbortSignal; deadline: number };
export type QueueState = 'waiting' | 'running' | 'completed' | 'retry_required';
export type QueueInfo = {
  state: QueueState; capacity: number; running: number; waiting: number;
  /** 1 is next waiting; null means this request holds no waiting position. */
  position: number | null; nextRetryPosition: number; arrivalAhead: number | null; retained: boolean;
  estimate: { scope: 'judge'; source: 'observed' | 'response_budget' | 'measured'; samples: number; startMs: [number, number | null]; completionMs: [number, number | null]; medianStartMs?: number | null; medianCompletionMs?: number | null; overdue: boolean };
  retryAfterMs: number | null;
  observed?: { waitedMs: number; serviceMs: number };
  retryPriority?: { retained: boolean; restored: boolean; remainingMs: number };
};
export type Admitted<T> =
  | { ok: true; value: T; ahead: number; waitedMs: number }
  | { ok: false; ahead: number; waitedMs: number; ran: boolean };
type Ticket = { go: () => void; notify?: (info: QueueInfo) => void; ahead: number; removed?: boolean; ordinal: number; retryKey?: string; priorityUntil?: number; restored?: boolean; queued?: boolean; started?: boolean };

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
  constructor(o: { concurrency: number; timeoutMs: number; retryPriorityMs?: number; retryPriorityLimit?: number }) {
    this.concurrency = Math.max(1, Math.trunc(o.concurrency));
    this.timeoutMs = o.timeoutMs;
    this.#priorityMs = Math.max(1, o.retryPriorityMs ?? 120000);
    this.#priorityLimit = Math.max(1, o.retryPriorityLimit ?? 1024);
  }
  get running(): number { return this.#running; }
  get waiting(): number { return this.#queue.length; }

  /** Estimate the next retry's place from live capacity. Windows are scenarios, never guaranteed upper bounds. */
  snapshot(state: QueueState = 'retry_required', position: number | null = null, arrivalAhead: number | null = null, retryPosition?: number): QueueInfo {
    const samples = [...this.#durations].sort((a, b) => a - b);
    const observed = samples.length > 0;
    const low = observed ? samples[Math.floor((samples.length - 1) * .25)] : 0;
    const high = observed ? samples[Math.ceil((samples.length - 1) * .9)] : this.timeoutMs;
    const median = observed ? samples[Math.floor((samples.length - 1) / 2)] : 0;
    const now = Date.now();
    let overdue = false;
    const available = [[], [], []] as number[][];
    for (const active of this.#active.values()) {
      const elapsed = Math.max(0, now - active.started);
      const unknown = elapsed > high || now >= active.deadline;
      if (now >= active.deadline) overdue = true;
      available[0].push(Math.max(0, low - elapsed));
      available[1].push(unknown ? Infinity : Math.max(0, high - elapsed));
      available[2].push(now >= active.deadline ? Infinity : (elapsed >= median ? median : Math.max(0, median - elapsed)));
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
      estimate: { scope: 'judge', source: observed ? 'observed' : 'response_budget', samples: samples.length, startMs, completionMs, ...(observed && { medianStartMs: Number.isFinite(starts[2]) ? starts[2] : null, medianCompletionMs: Number.isFinite(starts[2]) ? starts[2] + median : null }), overdue },
      retryAfterMs: state === 'retry_required' ? Math.max(1000, Math.min(60_000, Math.ceil((startMs[1] ?? this.timeoutMs) / 2))) : null };
  }
  #notifyWaiting() {
    this.#queue.forEach((ticket, index) => ticket.notify?.(this.#info(ticket, 'waiting', index + 1)));
  }
  #prune() { for (const [key, value] of this.#priorities) if (value.expiresAt <= Date.now()) this.#priorities.delete(key); }
  #retain(ticket: Ticket) {
    if (!ticket.retryKey || !ticket.queued || ticket.started) return;
    this.#prune();
    const expiresAt = ticket.priorityUntil ?? Date.now() + this.#priorityMs;
    ticket.priorityUntil = expiresAt;
    if (expiresAt <= Date.now()) return;
    this.#priorities.set(ticket.retryKey, { ordinal: ticket.ordinal, expiresAt });
    while (this.#priorities.size > this.#priorityLimit) this.#priorities.delete(this.#priorities.keys().next().value!);
  }
  #info(ticket: Ticket, state: QueueState, position: number | null = null): QueueInfo {
    this.#prune();
    const priority = ticket.retryKey ? this.#priorities.get(ticket.retryKey) : undefined;
    const retryPosition = priority ? this.#queue.filter(other => other.ordinal < priority.ordinal).length + 1 : undefined;
    return { ...this.snapshot(state, position, ticket.ahead, retryPosition), ...(ticket.retryKey && { retryPriority: {
      retained: !!priority, restored: !!ticket.restored, remainingMs: priority ? Math.max(0, priority.expiresAt - Date.now()) : 0,
    } }) };
  }
  async run<T>(fn: (turn: Turn) => Promise<T>, options: { signal?: AbortSignal; deadline?: number; onState?: (info: QueueInfo) => void; retryKey?: string } = {}): Promise<Admitted<T>> {
    const started = Date.now();
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, (options.deadline ?? Infinity) - started));
    const gaveUp = new AbortController();
    let ahead = this.#running < this.concurrency && !this.#queue.length ? 0 : this.#running + this.#queue.length;
    this.#prune();
    const key = options.retryKey && !this.#requests.has(options.retryKey) ? options.retryKey : undefined;
    const priority = key ? this.#priorities.get(key) : undefined;
    if (key) this.#priorities.delete(key);
    const ticket: Ticket = { go: () => {}, ahead, notify: options.onState, ordinal: priority?.ordinal ?? ++this.#ordinal,
      retryKey: key, priorityUntil: priority?.expiresAt, restored: !!priority };
    if (key) this.#requests.set(key, ticket);
    let timer: NodeJS.Timeout | undefined;
    let stop!: () => void;
    let timedOut = false;
    const expired = () => timedOut || options.signal?.aborted || Date.now() >= started + timeoutMs;
    const cancelledBeforeStart = new Error('admission cancelled before service started');
    const deadline = new Promise<'timeout'>((r) => { stop = () => {
      timedOut = true;
      const at = this.#queue.indexOf(ticket);
      if (at >= 0) { this.#queue.splice(at, 1); ticket.removed = true; this.#notifyWaiting(); }
      this.#retain(ticket); ticket.notify?.(this.#info(ticket, 'retry_required'));
      r('timeout');
    }; timer = setTimeout(stop, timeoutMs); });
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    try {
      if (timedOut) { ticket.notify?.(this.#info(ticket, 'retry_required')); return { ok: false, ahead, waitedMs: 0, ran: false }; }
      if (ahead) {
        const turn = new Promise<'go'>((r) => { ticket.go = () => r('go'); });
        ticket.queued = true;
        const at = this.#queue.findIndex(other => other.ordinal > ticket.ordinal);
        ahead = this.#running + (at < 0 ? this.#queue.length : at); ticket.ahead = ahead;
        if (at < 0) this.#queue.push(ticket); else this.#queue.splice(at, 0, ticket);
        this.#notifyWaiting();
        if ((await Promise.race([turn, deadline])) === 'timeout') {
          const i = this.#queue.indexOf(ticket);
          if (i >= 0) this.#queue.splice(i, 1); else if (!ticket.removed) this.#release();
          this.#notifyWaiting(); ticket.notify?.(this.#info(ticket, 'retry_required'));
          return { ok: false, ahead, waitedMs: Date.now() - started, ran: false };
        }
      } else this.#running++;
      const waitedMs = Date.now() - started;
      if (expired()) {
        this.#release(); ticket.notify?.(this.#info(ticket, 'retry_required'));
        return { ok: false, ahead, waitedMs, ran: false };
      }
      const serviceStarted = Date.now();
      let called = false;
      this.#active.set(ticket, { started: serviceStarted, deadline: started + timeoutMs });
      ticket.notify?.(this.#info(ticket, 'running'));
      if (expired()) {
        this.#active.delete(ticket); this.#release(); ticket.notify?.(this.#info(ticket, 'retry_required'));
        return { ok: false, ahead, waitedMs, ran: false };
      }
      const call = Promise.resolve().then(() => {
        if (expired()) throw cancelledBeforeStart;
        called = true; ticket.started = true;
        return fn({ signal: gaveUp.signal, deadline: started + timeoutMs });
      }).finally(() => {
        if (called) {
          this.#durations.push(Math.max(1, Date.now() - serviceStarted));
          if (this.#durations.length > 64) this.#durations.shift();
        }
        this.#active.delete(ticket); this.#release();
      });
      const r = await Promise.race([call.then((value) => ({ value })), deadline]);
      if (r === 'timeout') {
        call.catch(() => {}); gaveUp.abort(new Error(`gave up after ${Math.round(this.timeoutMs / 1000)} s`));
        ticket.notify?.(this.#info(ticket, 'retry_required'));
        return { ok: false, ahead, waitedMs, ran: called };
      }
      const serviceMs = Math.max(0, Date.now() - serviceStarted);
      const completed = this.#info(ticket, 'completed');
      ticket.notify?.({ ...completed, observed: { waitedMs, serviceMs }, estimate: { ...completed.estimate, source: 'measured', startMs: [waitedMs, waitedMs], completionMs: [waitedMs + serviceMs, waitedMs + serviceMs], medianStartMs: waitedMs, medianCompletionMs: waitedMs + serviceMs } });
      return { ok: true, value: r.value, ahead, waitedMs };
    } catch (error) {
      if (error === cancelledBeforeStart) { ticket.notify?.(this.#info(ticket, 'retry_required')); return { ok: false, ahead, waitedMs: Date.now() - started, ran: false }; }
      ticket.notify?.(this.#info(ticket, 'retry_required'));
      throw error;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', stop);
      if (ticket.retryKey && this.#requests.get(ticket.retryKey) === ticket) this.#requests.delete(ticket.retryKey);
    }
  }
  #release() {
    const next = this.#queue.shift();
    if (next) next.go(); else this.#running--;
    this.#notifyWaiting();
  }
}
