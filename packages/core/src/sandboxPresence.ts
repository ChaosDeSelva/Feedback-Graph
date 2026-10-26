/**
 * Whether the store holds any sandbox record (a sandbox run's lesson, miss, fact, document, link or report), so the
 * searches can leave out the per-record sandbox filter when there is none: the answer is the same, and the common
 * store (no sandbox run ever) pays nothing for the feature.
 *
 * A sandbox write in this process marks it at once (mark), and a run cleanup asks again (recheck). Another process
 * (the worker, a second api) can write one too, so "none" is believed only briefly (NONE_MS) and "some" for a minute
 * (SOME_MS: after a cleanup elsewhere the filter is skipped again). A check that fails answers "some": filtering is
 * always correct, skipping it only when there is none.
 */
const NONE_MS = 5_000;
const SOME_MS = 60_000;

export class SandboxPresence {
  readonly #check: () => Promise<boolean>;
  readonly #now: () => number;
  #known: boolean | null = null;
  #at = 0;
  /** Bumped by mark and recheck: a check that started before either does not store its answer. */
  #gen = 0;
  #pending: Promise<boolean> | null = null;

  constructor(check: () => Promise<boolean>, o: { now?: () => number } = {}) {
    this.#check = check;
    this.#now = o.now ?? Date.now;
  }

  async any(): Promise<boolean> {
    if (this.#known !== null && this.#now() - this.#at < (this.#known ? SOME_MS : NONE_MS)) return this.#known;
    if (this.#pending) return this.#pending;
    const gen = this.#gen;
    this.#pending = this.#check()
      .then((v) => {
        if (gen === this.#gen) this.#remember(v);
        return v || this.#known === true;
      })
      .catch(() => true)
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }

  /**
   * Before a store write: marks when it writes sandbox records, given the writing run (RunTag) or the sandbox flag read
   * from the record it derives from. Every write that can set sandbox: true goes through this, before the write, so a
   * search right after it never skips the run filter on a cached "none". Fails closed: anything it does not recognise
   * as "not a sandbox" (no run, false, a run tag whose sandbox is unset or false) marks, since filtering when unsure only
   * costs time and skipping could show a sandbox record to another caller.
   */
  wrote(run: { id?: string; sandbox?: boolean | null } | boolean | null | undefined): void {
    if (run === null || run === undefined || run === false) return;
    if (typeof run === 'object' && typeof run.id === 'string' && (run.sandbox === undefined || run.sandbox === null || run.sandbox === false)) return;
    this.mark();
  }

  /** A sandbox record was just written here. */
  mark(): void {
    this.#gen++;
    this.#remember(true);
  }

  /** Sandbox records were removed (a run cleanup): ask the store next time. */
  recheck(): void {
    this.#gen++;
    this.#known = null;
  }

  #remember(v: boolean) {
    this.#known = v;
    this.#at = this.#now();
  }
}
