/** Bounded FIFO admission. Timed-out callers leave the queue; uncooperative running calls keep their real slot. */
export type Turn = { signal: AbortSignal; deadline: number };
export type QueueState = 'waiting' | 'running' | 'completed' | 'retry_required';
export type QueueInfo = {
  state: QueueState; capacity: number; running: number; waiting: number;
  /** 1 is next waiting; null means this request holds no waiting position. */
  position: number | null; nextRetryPosition: number; arrivalAhead: number | null; retained: boolean;
  estimate: { scope: 'judge'; source: 'observed' | 'response_budget'; samples: number; startMs: [number, number | null]; completionMs: [number, number | null]; overdue: boolean };
  retryAfterMs: number | null;
};
export type Admitted<T> =
  | { ok: true; value: T; ahead: number; waitedMs: number }
  | { ok: false; ahead: number; waitedMs: number; ran: boolean };
type Ticket = { go: () => void; notify?: (info: QueueInfo) => void; ahead: number; removed?: boolean };

export class Admission {
  readonly concurrency: number;
  readonly timeoutMs: number;
  #running = 0;
  readonly #queue: Ticket[] = [];
  readonly #active = new Map<Ticket, { started: number; deadline: number }>();
  readonly #durations: number[] = [];
  constructor(o: { concurrency: number; timeoutMs: number }) {
    this.concurrency = Math.max(1, Math.trunc(o.concurrency));
    this.timeoutMs = o.timeoutMs;
  }
  get running(): number { return this.#running; }
  get waiting(): number { return this.#queue.length; }

  /** Estimate the next retry's place from live capacity. Windows are scenarios, never guaranteed upper bounds. */
  snapshot(state: QueueState = 'retry_required', position: number | null = null, arrivalAhead: number | null = null): QueueInfo {
    const samples = [...this.#durations].sort((a, b) => a - b);
    const observed = samples.length > 0;
    const low = observed ? samples[Math.floor((samples.length - 1) * .25)] : 0;
    const high = observed ? samples[Math.ceil((samples.length - 1) * .9)] : this.timeoutMs;
    const now = Date.now();
    let overdue = false;
    const available = [[], []] as number[][];
    for (const active of this.#active.values()) {
      const elapsed = Math.max(0, now - active.started);
      const unknown = elapsed > high || now >= active.deadline;
      if (unknown) overdue = true;
      available[0].push(Math.max(0, low - elapsed));
      available[1].push(unknown ? Infinity : Math.max(0, high - elapsed));
    }
    while (available[0].length < this.concurrency) { available[0].push(0); available[1].push(0); }
    const order = position ?? this.waiting + 1;
    const starts = available.map((allSlots, side) => {
      const slots = allSlots.filter(Number.isFinite);
      if (!slots.length) return Infinity;
      slots.sort((a, b) => a - b);
      // Each slot's remaining scenario is within one service duration, so FIFO waves interleave in this order.
      return slots[(order - 1) % slots.length] + Math.floor((order - 1) / slots.length) * (side ? high : low);
    });
    const started = state === 'running' || state === 'completed';
    const startMs: [number, number | null] = started ? [0, 0] : [starts[0], Number.isFinite(starts[1]) ? starts[1] : null];
    const completionMs: [number, number | null] = state === 'completed' ? [0, 0] : [startMs[0] + low, startMs[1] === null ? null : startMs[1] + high];
    return { state, capacity: this.concurrency, running: this.running, waiting: this.waiting,
      position: state === 'waiting' ? position : null, nextRetryPosition: this.waiting + 1, arrivalAhead, retained: state === 'waiting' || state === 'running',
      estimate: { scope: 'judge', source: observed ? 'observed' : 'response_budget', samples: samples.length, startMs, completionMs, overdue },
      retryAfterMs: state === 'retry_required' ? Math.max(1000, Math.min(60_000, Math.ceil((startMs[1] ?? this.timeoutMs) / 2))) : null };
  }
  #notifyWaiting() {
    this.#queue.forEach((ticket, index) => ticket.notify?.(this.snapshot('waiting', index + 1, ticket.ahead)));
  }
  async run<T>(fn: (turn: Turn) => Promise<T>, options: { signal?: AbortSignal; deadline?: number; onState?: (info: QueueInfo) => void } = {}): Promise<Admitted<T>> {
    const started = Date.now();
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, (options.deadline ?? Infinity) - started));
    const gaveUp = new AbortController();
    const ahead = this.#running < this.concurrency && !this.#queue.length ? 0 : this.#running + this.#queue.length;
    const ticket: Ticket = { go: () => {}, ahead, notify: options.onState };
    let timer: NodeJS.Timeout | undefined;
    let stop!: () => void;
    let timedOut = false;
    const expired = () => timedOut || options.signal?.aborted || Date.now() >= started + timeoutMs;
    const cancelledBeforeStart = new Error('admission cancelled before service started');
    const deadline = new Promise<'timeout'>((r) => { stop = () => {
      timedOut = true;
      const at = this.#queue.indexOf(ticket);
      if (at >= 0) { this.#queue.splice(at, 1); ticket.removed = true; this.#notifyWaiting(); }
      r('timeout');
    }; timer = setTimeout(stop, timeoutMs); });
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    try {
      if (timedOut) { ticket.notify?.(this.snapshot('retry_required', null, ahead)); return { ok: false, ahead, waitedMs: 0, ran: false }; }
      if (ahead) {
        const turn = new Promise<'go'>((r) => { ticket.go = () => r('go'); });
        this.#queue.push(ticket); this.#notifyWaiting();
        if ((await Promise.race([turn, deadline])) === 'timeout') {
          const i = this.#queue.indexOf(ticket);
          if (i >= 0) this.#queue.splice(i, 1); else if (!ticket.removed) this.#release();
          this.#notifyWaiting(); ticket.notify?.(this.snapshot('retry_required', null, ahead));
          return { ok: false, ahead, waitedMs: Date.now() - started, ran: false };
        }
      } else this.#running++;
      const waitedMs = Date.now() - started;
      if (expired()) {
        this.#release(); ticket.notify?.(this.snapshot('retry_required', null, ahead));
        return { ok: false, ahead, waitedMs, ran: false };
      }
      const serviceStarted = Date.now();
      let called = false;
      this.#active.set(ticket, { started: serviceStarted, deadline: started + timeoutMs });
      ticket.notify?.(this.snapshot('running', null, ahead));
      if (expired()) {
        this.#active.delete(ticket); this.#release(); ticket.notify?.(this.snapshot('retry_required', null, ahead));
        return { ok: false, ahead, waitedMs, ran: false };
      }
      const call = Promise.resolve().then(() => {
        if (expired()) throw cancelledBeforeStart;
        called = true;
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
        ticket.notify?.(this.snapshot('retry_required', null, ahead));
        return { ok: false, ahead, waitedMs, ran: called };
      }
      ticket.notify?.(this.snapshot('completed', null, ahead));
      return { ok: true, value: r.value, ahead, waitedMs };
    } catch (error) {
      if (error === cancelledBeforeStart) { ticket.notify?.(this.snapshot('retry_required', null, ahead)); return { ok: false, ahead, waitedMs: Date.now() - started, ran: false }; }
      ticket.notify?.(this.snapshot('retry_required', null, ahead));
      throw error;
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); }
  }
  #release() {
    const next = this.#queue.shift();
    if (next) next.go(); else this.#running--;
    this.#notifyWaiting();
  }
}
