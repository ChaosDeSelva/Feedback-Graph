import { utcDay, type DocsStore, type LlmProvider } from '@fb/core';

/** Today's INTAKE_LLM_CALLS_PER_DAY are used: the call was not made, and the source waits for tomorrow. */
export class IntakeBudgetSpent extends Error {
  readonly perDay: number;
  constructor(perDay: number, what = 'intake model calls are used (INTAKE_LLM_CALLS_PER_DAY): the source goes on tomorrow') {
    super(`today's ${perDay} ${what}`);
    this.name = 'IntakeBudgetSpent';
    this.perDay = perDay;
  }
}

export const INTAKE_BUDGET_CURSOR = 'intake-budget';
/** Contradiction detection's judge calls (CONFLICT_LLM_CALLS_PER_DAY), metered apart from extraction's. */
export const CONFLICT_BUDGET_CURSOR = 'conflict-budget';
type Cursors = Pick<DocsStore, 'getCursor' | 'setCursor'>;
/** The day's spend (UTC day). */
export type IntakeSpend = { day: string; llmCalls: number };

export function parseIntakeSpend(raw: string | null, now: number): IntakeSpend {
  const day = utcDay(now);
  try {
    const o = JSON.parse(raw ?? 'null') as Partial<IntakeSpend> | null;
    const n = Number(o?.llmCalls);
    return o?.day === day && Number.isInteger(n) && n >= 0 ? { day, llmCalls: n } : { day, llmCalls: 0 };
  } catch {
    return { day, llmCalls: 0 };
  }
}

/**
 * Intake's daily model-call meter, kept in the store (as loop/budget.ts keeps the loop's) so a restart does not reset
 * it. Reservations are serialized, so two calls at once cannot both take the last one. cursor: the meter's key
 * (default extraction's); spent: what IntakeBudgetSpent says once it is used.
 */
export class IntakeBudget {
  private d: { cursors: Cursors; perDay: number; now: () => number; cursor?: string; spent?: string };
  private tail: Promise<unknown> = Promise.resolve();

  constructor(d: IntakeBudget['d']) {
    this.d = d;
  }

  private get key() {
    return this.d.cursor ?? INTAKE_BUDGET_CURSOR;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Today's spend, and the cap. */
  async read(): Promise<IntakeSpend & { perDay: number }> {
    return { ...parseIntakeSpend(await this.d.cursors.getCursor(this.key), this.d.now()), perDay: this.d.perDay };
  }

  async spent(): Promise<boolean> {
    const b = await this.read();
    return b.llmCalls >= this.d.perDay;
  }

  /** Take one model call from today's budget, or throw IntakeBudgetSpent. */
  reserve(): Promise<void> {
    return this.serialized(async () => {
      const b = parseIntakeSpend(await this.d.cursors.getCursor(this.key), this.d.now());
      if (b.llmCalls >= this.d.perDay) throw new IntakeBudgetSpent(this.d.perDay, this.d.spent);
      await this.d.cursors.setCursor(this.key, JSON.stringify({ ...b, llmCalls: b.llmCalls + 1 }));
    });
  }
}

/** Intake's model with each call (a retry included) taken from the day's budget first. */
export const budgetedLlm = (p: LlmProvider, budget: IntakeBudget): LlmProvider => ({
  ...p,
  json: async (task) => {
    await budget.reserve();
    return p.json(task);
  },
});
