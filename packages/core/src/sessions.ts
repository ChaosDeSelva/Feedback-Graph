/**
 * Session summaries, shared by both stores and the worker: the shape a model must return, the markdown served from
 * it, and the timing rules (backoff after a failed update, a session's last activity).
 *
 * A summary is derived from a transcript, so it is treated like one: redacted before it is stored, never exported,
 * never sent by a team sync.
 */
import { z } from 'zod';
import type { FinalReply, SessionSource, SessionState, SessionSummary, SummaryCursor } from './types.ts';

const ITEM_CHARS = 300;
const TEXT_CHARS = 600;
const MAX_ITEMS = 15;
const MAX_FILES = 40;

const text = (max: number) => z.string().transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max));
const items = (max: number) =>
  z
    .array(z.string())
    .default([])
    .transform((xs) => [...new Set(xs.map((x) => x.replace(/\s+/g, ' ').trim().slice(0, ITEM_CHARS)).filter(Boolean))].slice(0, max));

/** What a summary model must return (markdown is rendered here, not by the model). */
export const SessionSummarySchema = z.object({
  goal: text(TEXT_CHARS).pipe(z.string().min(1, 'goal is empty')),
  done: items(MAX_ITEMS),
  decisions: items(MAX_ITEMS),
  openThreads: items(MAX_ITEMS),
  filesTouched: items(MAX_FILES),
  pushback: items(MAX_ITEMS),
  outcome: text(TEXT_CHARS).default(''),
});
export type SummaryFields = Omit<SessionSummary, 'markdown'>;

/** The JSON schema handed to providers for structured output (the same fields as SessionSummarySchema). */
export const SESSION_SUMMARY_JSON_SCHEMA = {
  type: 'object',
  required: ['goal', 'done', 'decisions', 'openThreads', 'filesTouched', 'pushback', 'outcome'],
  properties: {
    goal: { type: 'string', description: 'What the developer was trying to get done in this session, one or two sentences' },
    done: { type: 'array', items: { type: 'string' }, description: 'What was actually built, changed or verified, one short item each' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Choices made and why, one short item each' },
    openThreads: { type: 'array', items: { type: 'string' }, description: 'What is unfinished, broken or still to decide' },
    filesTouched: { type: 'array', items: { type: 'string' }, description: 'Files edited or created (repo-relative where possible)' },
    pushback: { type: 'array', items: { type: 'string' }, description: 'Where the developer corrected or pushed back on the agent, a few words each' },
    outcome: { type: 'string', description: 'Where the session stands now, one sentence' },
  },
};

/** Files from the model and from the delta's edits together, deduplicated, capped. */
export function mergeFiles(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b].map((f) => f.trim()).filter(Boolean))].slice(0, MAX_FILES);
}

/** The short markdown rendering served with the structured summary (and to agents). */
export function summaryMarkdown(s: SummaryFields): string {
  const section = (title: string, xs: string[]) => (xs.length ? [`**${title}**`, ...xs.map((x) => `- ${x}`), ''] : []);
  return [
    `**Goal:** ${s.goal}`,
    '',
    ...section('Done', s.done),
    ...section('Decisions', s.decisions),
    ...section('Open threads', s.openThreads),
    ...section('Pushback', s.pushback),
    ...section('Files touched', s.filesTouched.map((f) => `\`${f.replace(/`/g, "'")}\``)),
    s.outcome ? `**Outcome:** ${s.outcome}` : '',
  ]
    .join('\n')
    .trim();
}

export const withMarkdown = (s: SummaryFields): SessionSummary => ({ ...s, markdown: summaryMarkdown(s) });

/** A stored summary read back: whatever is missing is empty, so an older or damaged row never breaks a page. */
export function readSummary(raw: unknown): SessionSummary | null {
  if (!raw) return null;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []);
  const s: SummaryFields = {
    goal: typeof o.goal === 'string' ? o.goal : '',
    done: list(o.done),
    decisions: list(o.decisions),
    openThreads: list(o.openThreads),
    filesTouched: list(o.filesTouched),
    pushback: list(o.pushback),
    outcome: typeof o.outcome === 'string' ? o.outcome : '',
  };
  return { ...s, markdown: typeof o.markdown === 'string' ? o.markdown : summaryMarkdown(s) };
}

/** The list's one line: the goal, cut short. */
export const summarySnippet = (s: SessionSummary | null): string | null => (s ? (s.goal || s.outcome || '').slice(0, 200) || null : null);

/** A failed update waits 5 minutes, then twice as long each time, up to 6 hours. A success resets it. */
export function summaryRetryAt(attempts: number, now: Date = new Date()): string {
  const minutes = Math.min(360, 5 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/** The newest of the given times as an ISO string (unreadable ones ignored); null when none can be read. */
export function latestTime(...ts: (string | null | undefined)[]): string | null {
  const ms = ts.map((t) => (t ? Date.parse(t) : NaN)).filter((n) => !Number.isNaN(n));
  return ms.length ? new Date(Math.max(...ms)).toISOString() : null;
}

/** A session the summarize stage may work on (SessionsStore.work). */
export type SummaryWork = {
  run?: string;
  sandbox?: true;
  id: string;
  projectKey: string;
  source: SessionSource;
  cwd: string | null;
  lastTurn: SummaryCursor;
  lastActivityAt: string | null;
  turnCount: number;
  /** Null: never set (a session from before summaries), read as active. */
  state: SessionState | null;
  summary: SessionSummary | null;
  summarizedThrough: SummaryCursor | null;
  summaryVersion: number;
  rebuild: boolean;
  /** Backing off after a failed update until then (an idle session with new turns is listed anyway, to reactivate it). */
  retryAt: string | null;
  /** Turns after the cursor. */
  pending: number;
  /** The agent's reply after the last turn (redacted), taken in by the update that reaches the last turn. */
  finalReply: FinalReply | null;
  /**
   * The time of the final reply the summary has taken in (null: none). A reply stored after the summary already
   * reached the last turn (a SUMMARY_MAX_DELTA_TURNS update while the agent was still answering) differs from it,
   * and finalReplyDue says the session needs an update of that reply alone.
   */
  finalReplySummarizedTs: string | null;
};

/** The summary reached the last turn but not the agent's final reply after it: an update of that reply alone is due. */
export function finalReplyDue(w: Pick<SummaryWork, 'finalReply' | 'finalReplySummarizedTs' | 'summarizedThrough' | 'lastTurn' | 'rebuild'>): boolean {
  return !!w.finalReply && !w.rebuild && !!w.summarizedThrough && w.summarizedThrough.index >= w.lastTurn.index && w.finalReply.ts !== w.finalReplySummarizedTs;
}

export type SummaryWorkQuery = {
  /** Selected projects; an empty list finds nothing. */
  projectKeys: string[];
  excludeKeys?: string[];
  /** A session last active before this is quiet: its delta is summarized. */
  quietBefore: Date;
  /** Last active before this: idle once summarized; and a never-summarized one is backfill. */
  idleBefore: Date;
  /** A delta this big is summarized without waiting for the session to go quiet. */
  maxDeltaTurns: number;
  /**
   * true: sessions never summarized that went idle long ago (the history), newest first. false: everything else that
   * needs the stage (deltas due, rebuilds, final replies stored after the summary reached the last turn, idle sessions
   * with new turns, active ones to mark idle).
   */
  backfill: boolean;
  limit: number;
  now?: Date;
};

/** One summary update to store. Applies only while the session is still at prevVersion (and rebuild matches). */
export type SummaryWrite = {
  summary: SessionSummary;
  prevVersion: number;
  rebuild: boolean;
  from: SummaryCursor | null;
  to: SummaryCursor;
  deltaTurns: number;
  model: string;
  state: SessionState;
  at?: Date;
  /**
   * The time of the agent's final reply this update took in. Unset or null: the mark stays as it was, except that a rebuild
   * (which starts the summary over) clears it.
   */
  finalReplyTs?: string | null;
};

/** The newest-first list's position: the last row's activity time ('' when it had none) and id. */
export type SessionCursor = { at: string; id: string };

export function encodeSessionCursor(c: SessionCursor): string {
  return Buffer.from(JSON.stringify([c.at, c.id])).toString('base64url');
}

export function decodeSessionCursor(s: string): SessionCursor | null {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' ? { at: v[0], id: v[1] } : null;
  } catch {
    return null;
  }
}
