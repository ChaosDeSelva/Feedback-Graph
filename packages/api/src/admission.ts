/**
 * Admission control for slow model calls (check_before_done's judge): at most `concurrency` run at once, the rest wait
 * in arrival order. Every call answers by `timeoutMs` (waiting plus running): past it the caller gets ok: false at once
 * and can say so, rather than holding an agent for minutes. A call is handed the deadline it must answer by (to fit its
 * own timeouts in it) and a signal that fires when the caller gives up: a call that honours it (the HTTP providers)
 * ends at once. A call that times out while running keeps its slot until it really ends, so the model is never asked
 * more than `concurrency` things at a time.
 */
export type Turn = { signal: AbortSignal; deadline: number };

export type Admitted<T> =
  | { ok: true; value: T; ahead: number; waitedMs: number }
  | { ok: false; ahead: number; waitedMs: number; ran: boolean };

export class Admission {
  readonly concurrency: number;
  readonly timeoutMs: number;
  #running = 0;
  readonly #queue: (() => void)[] = [];

  constructor(o: { concurrency: number; timeoutMs: number }) {
    this.concurrency = Math.max(1, Math.trunc(o.concurrency));
    this.timeoutMs = o.timeoutMs;
  }

  get running(): number {
    return this.#running;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /** `ahead`: the checks running or waiting in front of this one when it arrived (0 when it started at once). */
  async run<T>(fn: (turn: Turn) => Promise<T>): Promise<Admitted<T>> {
    const started = Date.now();
    const gaveUp = new AbortController();
    const ahead = this.#running < this.concurrency && !this.#queue.length ? 0 : this.#running + this.#queue.length;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), this.timeoutMs); });
    try {
      if (ahead) {
        let go!: () => void;
        const turn = new Promise<'go'>((r) => { go = () => r('go'); });
        this.#queue.push(go);
        if ((await Promise.race([turn, deadline])) === 'timeout') {
          const i = this.#queue.indexOf(go);
          if (i >= 0) this.#queue.splice(i, 1);
          else this.#release(); // its turn came in the same instant: hand the slot on
          return { ok: false, ahead, waitedMs: Date.now() - started, ran: false };
        }
      } else {
        this.#running++;
      }
      const waitedMs = Date.now() - started;
      const call = Promise.resolve().then(() => fn({ signal: gaveUp.signal, deadline: started + this.timeoutMs })).finally(() => this.#release());
      const r = await Promise.race([call.then((value) => ({ value })), deadline]);
      if (r === 'timeout') {
        call.catch(() => {});
        gaveUp.abort(new Error(`gave up after ${Math.round(this.timeoutMs / 1000)} s`));
        return { ok: false, ahead, waitedMs, ran: true };
      }
      return { ok: true, value: r.value, ahead, waitedMs };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A slot is free: the longest waiting call takes it (the count stays), else it is given back. */
  #release() {
    const next = this.#queue.shift();
    if (next) next();
    else this.#running--;
  }
}
