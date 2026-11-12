import { seedLoopSettings, writeLoopSettings, type Activity, type ActivityStore, type Decision, type LlmProvider, type LoopConfig, type Store } from '@fb/core';
import { runLoopRound, SETTLE_MS } from '../engine.ts';
import type { LoopExecutor } from '../executor.ts';
import type { LoopType } from '../plugin.ts';
import { ownerActions, replayReport, scoreCut, type CutResult, type ReplayReport, type ReplaySplit } from './score.ts';
import { LessonHistory, memoryCursors, ReplayReadOnly, timeTravel, TT_READ } from './timeTravel.ts';

export * from './score.ts';
export * from './timeTravel.ts';

/**
 * The held-out time-split replay (scripts/loop-replay.ts): for each cut T0, the loop runs in observe
 * over a restored store as it was at T0 (timeTravel.ts), and its would-be decisions are scored against what the owner
 * did after T0 (score.ts). The restored store is only read.
 */

export type ReplayStore = Pick<Store, 'knowledge' | 'facts' | 'graph' | 'codegraph' | 'insights' | 'decisions' | 'activity' | 'intake' | 'links' | 'docs'>;
export type ReplayDeps = {
  store: ReplayStore;
  /** The types to replay; default every registered type. */
  types?: readonly LoopType[];
  /** Projects the loop may act in; default all. */
  inScope?: (projectKey: string | null) => boolean;
  /** A model for the types that need one (LOOP_LLM); null: those types find nothing. */
  llm?: LlmProvider | null;
  /** Model calls each cut may make. */
  llmCalls?: number;
  pageSize?: number;
  /** Rounds a cut may take (MAX_ROUNDS). */
  maxRounds?: number;
  log?: (msg: string, extra?: object) => void;
};
export type ReplayOptions = {
  /** The cuts (ms). */
  cuts: number[];
  /** Owner actions count up to this long after a cut; null: to the end of the log. */
  horizonMs: number | null;
  split: ReplaySplit;
};

/** A cut that never ends its rounds is a bug in a type, not a long log. */
export const MAX_ROUNDS = 10_000;
const LOG_PAGE = 1000;

/** The whole Activity log outside runs, oldest first. */
export async function readLog(activity: Pick<ActivityStore, 'since'>): Promise<Activity[]> {
  const out: Activity[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await activity.since({ after, limit: LOG_PAGE, unlabelled: true });
    out.push(...page.entries);
    if (page.entries.length < LOG_PAGE) return out;
    after = page.next;
  }
}

/** The loop in observe at T0: every decision it would have recorded. */
/** The loop only observes in a replay: an apply would be a bug, and nothing it applied has targets to compare. */
export const readOnlyExecutor: LoopExecutor = { apply: async () => { throw new ReplayReadOnly('apply'); }, changed: async () => null };

export async function wouldBeDecisions(d: ReplayDeps, t0: number, history: LessonHistory): Promise<Decision[]> {
  const tt = timeTravel(d.store, t0, history);
  const cursors = memoryCursors();
  await writeLoopSettings(cursors, seedLoopSettings({ mode: 'observe' }));
  const config: LoopConfig = {
    mode: 'observe', disabled: false, llm: null, llmCallsPerDay: d.llmCalls ?? 40, autoPerDay: 0, autoPerProject: 0, syncHoldDays: 0, holdout: 0, types: null,
  };
  const max = d.maxRounds ?? MAX_ROUNDS;
  for (let round = 0; ; round++) {
    if (round >= max) throw new Error(`the replay at ${new Date(t0).toISOString()} did not finish in ${max} rounds`);
    const r = await runLoopRound({
      store: tt.store, cursors, config, tokenless: false, inScope: d.inScope ?? (() => true),
      executor: readOnlyExecutor, llm: d.llm ?? null,
      // The engine reads up to SETTLE_MS before its clock: the clock is T0 + SETTLE_MS, so it reads up to T0.
      now: () => t0 + SETTLE_MS, log: d.log ?? (() => {}), types: d.types, pageSize: d.pageSize,
    });
    if (!r.more) break;
  }
  return [...tt.decisions.decisions.values()].filter((x) => x.status === 'observed');
}

/** The owner's actions after T0 (within the horizon) on records that existed at T0. */
async function actionsAfter(d: ReplayDeps, log: Activity[], t0: number, horizonMs: number | null) {
  const from = new Date(t0).toISOString();
  const to = horizonMs === null ? null : new Date(t0 + horizonMs).toISOString();
  const existed = new Map<string, boolean>();
  const out = [];
  for (const a of ownerActions(log.filter((e) => e.ts >= from && (to === null || e.ts < to)))) {
    if (a.kind !== 'kept_decision' && a.kind !== 'undid_decision') {
      if (!existed.has(a.target)) {
        const created = a.target.startsWith('lesson:')
          ? (await d.store.knowledge.lessonDetail(a.target))?.lesson.createdAt
          : (await d.store.graph.candidateDetail(a.target))?.candidate.createdAt;
        existed.set(a.target, !!created && created < from);
      }
      if (!existed.get(a.target)) continue;
    }
    out.push(a);
  }
  return out;
}

/** One cut, scored. `log` and `decisions`: the whole Activity log and the store's real decisions (read once per replay). */
export async function replayCut(d: ReplayDeps, t0: number, o: Omit<ReplayOptions, 'cuts'>, log: Activity[], decisions: Decision[]): Promise<CutResult> {
  const history = new LessonHistory(t0, log, decisions);
  const would = await wouldBeDecisions(d, t0, history);
  return scoreCut(new Date(t0).toISOString(), would, await actionsAfter(d, log, t0, o.horizonMs), o.split);
}

/** Every cut, and the report over them. */
export async function runReplay(d: ReplayDeps, o: ReplayOptions): Promise<{ cuts: CutResult[]; report: ReplayReport }> {
  const log = await readLog(d.store.activity);
  const decisions = await d.store.decisions.list({ limit: TT_READ });
  const cuts: CutResult[] = [];
  for (const t0 of [...o.cuts].sort((a, b) => a - b)) {
    d.log?.(`replaying the loop at ${new Date(t0).toISOString()}`);
    cuts.push(await replayCut(d, t0, o, log, decisions));
  }
  return { cuts, report: replayReport(cuts) };
}
