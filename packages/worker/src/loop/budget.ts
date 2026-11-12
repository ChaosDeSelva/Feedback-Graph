import { readLoopBudget, writeLoopBudget, type DocsStore, type LlmProvider, type LoopConfig } from '@fb/core';

/** The day's LOOP_LLM_CALLS_PER_DAY are used: the call was not made. */
export class LoopBudgetSpent extends Error {
  constructor(perDay: number) {
    super(`the learning loop's ${perDay} model calls for today are used`);
    this.name = 'LoopBudgetSpent';
  }
}

type Cursors = Pick<DocsStore, 'getCursor' | 'setCursor'>;

/**
 * The loop's daily budget, persisted in the store (loop-budget, the GitHub request budget's pattern) so a restart does
 * not reset it and the api shows the same numbers: model calls, and tier A decisions applied on their own (in all and
 * per project). Reservations are serialized, so two calls at once cannot both take the last one.
 */
export class LoopBudgetGate {
  private d: { cursors: Cursors; config: Pick<LoopConfig, 'llmCallsPerDay' | 'autoPerDay' | 'autoPerProject'>; now: () => number };
  private tail: Promise<unknown> = Promise.resolve();
  /** Model calls made through this gate (the round's). */
  llmCalls = 0;

  constructor(d: LoopBudgetGate['d']) {
    this.d = d;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Take one model call from today's budget, or throw LoopBudgetSpent. */
  reserveLlmCall(): Promise<void> {
    return this.serialized(async () => {
      const b = await readLoopBudget(this.d.cursors, this.d.now());
      if (b.llmCalls >= this.d.config.llmCallsPerDay) throw new LoopBudgetSpent(this.d.config.llmCallsPerDay);
      await writeLoopBudget(this.d.cursors, { ...b, llmCalls: b.llmCalls + 1 });
      this.llmCalls++;
    });
  }

  /** Whether today's caps leave a tier A auto-apply in this project (nothing taken). */
  hasAuto(projectKey: string | null): Promise<boolean> {
    return this.serialized(async () => this.room(await readLoopBudget(this.d.cursors, this.d.now()), projectKey ?? ''));
  }

  /**
   * Take one tier A auto-apply in this project from today's caps, just before the apply; false (nothing taken) when a
   * cap is reached. An apply that then does not happen gives it back (refundAuto).
   */
  reserveAuto(projectKey: string | null): Promise<boolean> {
    return this.serialized(async () => {
      const b = await readLoopBudget(this.d.cursors, this.d.now());
      const key = projectKey ?? '';
      if (!this.room(b, key)) return false;
      await writeLoopBudget(this.d.cursors, { ...b, auto: b.auto + 1, autoByProject: { ...b.autoByProject, [key]: (b.autoByProject[key] ?? 0) + 1 } });
      return true;
    });
  }

  /** Give back a slot reserveAuto took for an apply that did not happen. */
  refundAuto(projectKey: string | null): Promise<void> {
    return this.serialized(async () => {
      const b = await readLoopBudget(this.d.cursors, this.d.now());
      const key = projectKey ?? '';
      await writeLoopBudget(this.d.cursors, { ...b, auto: Math.max(0, b.auto - 1), autoByProject: { ...b.autoByProject, [key]: Math.max(0, (b.autoByProject[key] ?? 0) - 1) } });
    });
  }

  private room(b: Awaited<ReturnType<typeof readLoopBudget>>, key: string): boolean {
    return b.auto < this.d.config.autoPerDay && (b.autoByProject[key] ?? 0) < this.d.config.autoPerProject;
  }
}

/** The loop's model with each call taken from the day's budget first. */
export const meteredLlm = (p: LlmProvider, gate: LoopBudgetGate): LlmProvider => ({
  ...p,
  json: async (task) => {
    await gate.reserveLlmCall();
    return p.json(task);
  },
});
