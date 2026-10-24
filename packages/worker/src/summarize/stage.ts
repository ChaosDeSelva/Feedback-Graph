/**
 * The worker's "summarize" stage: keeps a running summary of each session of the selected projects. It runs beside
 * ingest (kick() starts a pass and returns; one pass at a time) and is bounded per pass.
 *
 * Each session has a cursor: the last turn its summary covers. When turns arrive after it and the session has been
 * quiet for SUMMARY_QUIET_MINUTES (or SUMMARY_MAX_DELTA_TURNS are waiting), only those turns are sent, with the
 * previous summary, and the model returns the merged summary; the cursor then moves to the last turn sent. A session
 * quiet for SESSION_IDLE_MINUTES and summarized to its last turn is idle ("complete for now"); a new turn makes it
 * active again and the summary is extended. Sessions from before summaries are backfilled a few per pass, newest first.
 *
 * The agent's final reply (after the last turn) goes with the update that reaches the last turn. When it is stored
 * only after that (a SUMMARY_MAX_DELTA_TURNS update ran while the agent was still answering), the session is listed
 * again once quiet, and that reply alone is sent as the delta; the cursor stays on the last turn.
 */
import { finalReplyDue, providerUnavailableReason, redactSecrets, type ActivityStore, type HumanTurn, type LlmProvider, type SessionsStore, type SessionState, type SummaryWork } from '@fb/core';
import { InvalidSummaryError, summarizeDelta, summarizeFinalReply } from './summarize.ts';

export type SummarizeDeps = {
  sessions: Pick<SessionsStore, 'work' | 'turns' | 'save' | 'recordFailure' | 'setState'>;
  /** Null: no model could be built; nothing is summarized (and nothing is charged). */
  llm: LlmProvider | null;
  activity?: Pick<ActivityStore, 'record'>;
  /** The selected projects, read at the start of each pass. */
  projects: () => string[] | Promise<string[]>;
  excludeProjects?: string[];
  quietMinutes: number;
  idleMinutes: number;
  maxDeltaTurns: number;
  backfillPerCycle: number;
  /** Updates of live sessions per pass (default 5). */
  perPass?: number;
  /** Turns sent per update at most (default 80): a longer delta is taken in over several passes. */
  maxTurnsPerUpdate?: number;
  /** A delta bigger than this is summarized in parts, then merged (default 20 turns, 24,000 characters). */
  chunkTurns?: number;
  chunkChars?: number;
  now?: () => number;
  log?: (msg: string, extra?: object) => void;
};

export type SummarizeResult = {
  summarized: number;
  idled: number;
  reactivated: number;
  failed: number;
  /** Why the model could not be asked; the pass stopped there and no cursor moved. */
  unavailable?: string;
};

const MIN = 60_000;
const DEFAULT_PER_PASS = 5;
const DEFAULT_MAX_TURNS = 80;
const DEFAULT_CHUNK_TURNS = 20;
const DEFAULT_CHUNK_CHARS = 24_000;

class Unavailable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const short = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export async function runSummaries(d: SummarizeDeps): Promise<SummarizeResult> {
  const out: SummarizeResult = { summarized: 0, idled: 0, reactivated: 0, failed: 0 };
  const keys = await d.projects();
  if (!keys.length) return out;
  const now = d.now?.() ?? Date.now();
  const base = {
    projectKeys: keys,
    excludeKeys: d.excludeProjects,
    quietBefore: new Date(now - d.quietMinutes * MIN),
    idleBefore: new Date(now - d.idleMinutes * MIN),
    maxDeltaTurns: d.maxDeltaTurns,
    now: new Date(now),
  };
  const perPass = d.perPass ?? DEFAULT_PER_PASS;
  const idleBefore = base.idleBefore.getTime();
  const quiet = (w: SummaryWork) => !w.lastActivityAt || Date.parse(w.lastActivityAt) < base.quietBefore.getTime();
  const idleByTime = (w: SummaryWork) => !w.lastActivityAt || Date.parse(w.lastActivityAt) < idleBefore;

  async function update(w: SummaryWork, why: string): Promise<void> {
    if (!d.llm) throw new Unavailable('no summary model could be built (see the provider log line at startup)');
    // Every turn is summarized but the final reply after them is not: it alone is the delta.
    const replyOnly = finalReplyDue(w) && w.pending <= 0 && !!w.summary;
    let turns: HumanTurn[] = [];
    if (!replyOnly) {
      const after = w.rebuild ? -1 : (w.summarizedThrough?.index ?? -1);
      turns = await d.sessions.turns(w.id, after, d.maxTurnsPerUpdate ?? DEFAULT_MAX_TURNS);
      if (!turns.length) return;
    }
    const previous = w.rebuild ? null : w.summary;
    const through = w.rebuild ? null : (w.summarizedThrough?.index ?? null);
    // The agent's last answer comes after the last turn: it belongs to the update that reaches that turn.
    const reply = replyOnly || turns.at(-1)!.index >= w.lastTurn.index ? w.finalReply : null;
    let result: Awaited<ReturnType<typeof summarizeDelta>>;
    try {
      result = replyOnly
        ? await summarizeFinalReply(d.llm, w.summary!, w.summarizedThrough!.index, w.finalReply!)
        : await summarizeDelta(d.llm, previous, through, turns, w.cwd, {
            chunkTurns: d.chunkTurns ?? DEFAULT_CHUNK_TURNS,
            chunkChars: d.chunkChars ?? DEFAULT_CHUNK_CHARS,
            finalReply: reply,
          });
    } catch (err) {
      const reason = providerUnavailableReason(err);
      if (reason) throw new Unavailable(reason);
      // An unusable answer (or a request the provider refused): the summary and cursor stay, the session backs off.
      const message = err instanceof InvalidSummaryError ? err.message : redactSecrets(String(err));
      const { attempts, retryAt } = await d.sessions.recordFailure(w.id, message, new Date(now));
      d.log?.('session summary failed, backing off', { session: w.id, attempts, retryAt, error: message.slice(0, 300) });
      out.failed++;
      return;
    }
    const last = turns.at(-1);
    const to = last ? { index: last.index, ts: last.ts } : w.summarizedThrough!;
    const caughtUp = to.index >= w.lastTurn.index;
    const state: SessionState = caughtUp && idleByTime(w) ? 'idle' : 'active';
    const saved = await d.sessions.save(w.id, {
      summary: result.summary,
      prevVersion: w.summaryVersion,
      rebuild: w.rebuild,
      from: w.rebuild ? null : w.summarizedThrough,
      to,
      deltaTurns: turns.length,
      model: d.llm.id,
      state,
      at: new Date(now),
      // Marks the reply as taken in, so a later one (and only a later one) is sent again.
      finalReplyTs: reply ? reply.ts : null,
    });
    if (!saved) {
      d.log?.('session summary not saved: the session changed meanwhile (a rebuild was asked for); it is redone next pass', { session: w.id });
      return;
    }
    out.summarized++;
    if (state === 'idle') out.idled++;
    const from = w.rebuild ? null : w.summarizedThrough;
    await d.activity?.record({
      kind: 'session_summarized',
      actor: d.llm.id,
      projectKey: w.projectKey,
      subject: replyOnly
        ? `extended the summary of session ${short(w.id)} with the agent's final reply after turn ${to.index}${state === 'idle' ? ', now idle' : ''}`
        : `${w.rebuild ? 'rebuilt the summary of' : from ? 'extended the summary of' : 'summarized'} session ${short(w.id)}: turns ${from ? from.index + 1 : 0} to ${to.index} (${turns.length} new)${state === 'idle' ? ', now idle' : ''}`,
      why,
      details: {
        sessionId: w.id,
        source: w.source,
        from,
        to,
        deltaTurns: turns.length,
        finalReply: !!reply,
        pendingAfter: Math.max(0, w.lastTurn.index - to.index),
        chunks: result.chunks,
        modelCalls: result.calls,
        version: w.summaryVersion + 1,
        rebuild: w.rebuild,
        state,
      },
      targets: [`session:${w.id}`],
    });
  }

  try {
    let updates = 0;
    for (const w of await d.sessions.work({ ...base, backfill: false, limit: perPass * 4 })) {
      if (w.pending > 0 && w.state === 'idle') {
        // New turns in a session that was complete for now: it is active again, and the summary will be extended.
        await d.sessions.setState(w.id, 'active');
        w.state = 'active';
        out.reactivated++;
      }
      const due = !w.retryAt || Date.parse(w.retryAt) <= now;
      if (!w.rebuild && w.pending <= 0) {
        if (finalReplyDue(w) && due && updates < perPass && (quiet(w) || w.state === 'idle')) {
          updates++;
          await update(w, `the agent's final reply arrived after the summary had reached the last turn, and the session had been quiet for ${d.quietMinutes} minutes`);
          continue;
        }
        if (w.state !== 'idle' && idleByTime(w)) {
          await d.sessions.setState(w.id, 'idle');
          out.idled++;
        }
        continue;
      }
      if (!due || updates >= perPass) continue;
      const why = w.rebuild
        ? 'you asked for the summary to be rebuilt from the first turn'
        : w.pending >= d.maxDeltaTurns
          ? `${w.pending} turns were waiting, more than SUMMARY_MAX_DELTA_TURNS (${d.maxDeltaTurns})`
          : quiet(w)
            ? `the session had been quiet for ${d.quietMinutes} minutes with ${w.pending} new turn${w.pending === 1 ? '' : 's'}`
            : null;
      if (!why) continue;
      updates++;
      await update(w, why);
    }
    if (d.backfillPerCycle > 0) {
      for (const w of await d.sessions.work({ ...base, backfill: true, limit: d.backfillPerCycle })) {
        await update(w, 'backfill: a session from before summaries (a few per cycle, newest first)');
      }
    }
  } catch (err) {
    if (!(err instanceof Unavailable)) throw err;
    // Not the session's fault: nothing is charged, no cursor moves, and the next pass tries again.
    out.unavailable = err.reason;
    d.log?.('summary model unavailable, pausing until next cycle', { reason: err.reason });
  }
  return out;
}

/** runSummaries beside the main loop: kick() starts a pass unless one is running, and never throws. */
export class SummarizeStage {
  private readonly d: SummarizeDeps;
  private running: Promise<void> | null = null;
  last: SummarizeResult | null = null;

  constructor(d: SummarizeDeps) {
    this.d = d;
  }

  kick(): void {
    if (this.running) return;
    this.running = runSummaries(this.d)
      .then((r) => {
        this.last = r;
        if (r.summarized || r.idled || r.reactivated || r.failed) this.d.log?.('sessions summarized', { ...r });
      })
      .catch((err) => this.d.log?.('summary pass failed', { error: redactSecrets(String(err)) }))
      .finally(() => {
        this.running = null;
      });
  }

  /** Resolves when no pass is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
}
