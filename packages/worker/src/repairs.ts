import { INVALID_SUMMARY, threadTaskTitle, type ActivityStore, type DocsStore, type GraphStore, type InboxText, type KnowledgeStore, type SessionsStore } from '@fb/core';
import { turnHash } from './ingest/fingerprint.ts';
import { COMPACTION_SUMMARY } from './ingest/parseTranscript.ts';

/**
 * One-off repairs of data earlier versions stored wrong, each run once (its cursor holds the version done) at worker
 * start and logged in Activity with what it changed. A failure is logged and the repair runs again at the next start.
 */
export type RepairDeps = {
  knowledge: Pick<KnowledgeStore, 'threadTasks' | 'setTaskTitle'>;
  graph: Pick<GraphStore, 'inboxTexts' | 'skipPendingItem'>;
  activity: Pick<ActivityStore, 'record'>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  sessions?: Pick<SessionsStore, 'retryFailedSummaries'>;
  log?: (msg: string, extra?: object) => void;
};

const MAX_TARGETS = 200;

/** Runs `fn` once per `version` under `cursor`; null when it ran already. */
async function once<T>(d: Pick<RepairDeps, 'cursors'>, cursor: string, version: number, fn: () => Promise<T>): Promise<T | null> {
  const stamp = `v${version}`;
  if ((await d.cursors.getCursor(cursor)) === stamp) return null;
  const r = await fn();
  await d.cursors.setCursor(cursor, stamp);
  return r;
}

export const THREAD_TASKS_CURSOR = 'repair-thread-task-titles';

/**
 * Up to 0.8.2 a PR's or issue's task took the post-mortem model's name for the work session it was matched to, so one
 * session matched to many PRs synced together gave them all one title (10 unrelated PRs on one install). Each thread's
 * task is retitled from the thread itself (threadTaskTitle). Tasks were never one node across threads (one per thread),
 * so nothing is split.
 */
export async function retitleThreadTasks(d: RepairDeps): Promise<{ examined: number; retitled: number } | null> {
  return once(d, THREAD_TASKS_CURSOR, 1, async () => {
    const tasks = await d.knowledge.threadTasks();
    const changed: { id: string; from: string | null; to: string }[] = [];
    for (const t of tasks) {
      const to = threadTaskTitle(t.external);
      if (t.title === to || !(await d.knowledge.setTaskTitle(t.id, to))) continue;
      changed.push({ id: t.id, from: t.title, to });
    }
    if (changed.length) {
      await d.activity.record({
        kind: 'misses_reclassified', actor: 'repair', projectKey: null,
        subject: `${changed.length} PR and issue task${changed.length === 1 ? '' : 's'} retitled from their thread`,
        why: 'each took the name of the work session it was matched to, which several unrelated PRs could share',
        details: { repair: THREAD_TASKS_CURSOR, version: 1, changed: changed.slice(0, MAX_TARGETS) },
        targets: changed.slice(0, MAX_TARGETS).map((c) => c.id),
      });
      d.log?.('PR and issue tasks retitled from their threads', { retitled: changed.length });
    }
    return { examined: tasks.length, retitled: changed.length };
  });
}

export const DUPLICATE_ITEMS_CURSOR = 'repair-duplicate-inbox-items';
/** Who the duplicate repair records as deciding: never the owner, so no quality number or calibration counts it. */
export const DUPLICATE_DECIDER = 'repair:duplicate';
const PAGE = 1000;

/** A transcript segment (`<id>#2`) is its session's; a PR thread's id (`github:acme/shop#7`) is its own. */
const sessionRoot = (i: InboxText) => (i.source === 'claude' || i.source === 'codex' ? i.sessionId.replace(/#\d+$/, '') : i.sessionId);

/**
 * The pending Inbox items earlier versions filed twice, each with the item it repeats:
 * - the same turn re-read under a new id (a Codex record with its ordinal once and without it once, `…:2311` and
 *   `…:L2312`): the same words in the same session as an item already decided;
 * - a Codex import of a Claude Code conversation read as Codex's own: the same turn (turnHash) as an item of a Claude
 *   Code session of the project, already decided;
 * - the same words twice in one session or PR thread, both pending: the later repeats the earlier.
 */
export function duplicateItems(items: InboxText[]): { id: string; of: string; why: string }[] {
  const compaction = compactionItems(items);
  const ids = new Set(compaction.map((c) => c.id));
  return [...repeatedItems(items).filter((r) => !ids.has(r.id)), ...compaction].sort((a, b) => a.id.localeCompare(b.id));
}

/** Pending items flagged on a compaction summary Claude Code wrote as a user message: the model's words, not feedback. */
function compactionItems(items: InboxText[]): { id: string; of: string; why: string }[] {
  return items.filter((i) => i.status === 'pending' && i.source === 'claude' && i.text.trimStart().startsWith(COMPACTION_SUMMARY))
    .map((i) => ({ id: i.id, of: i.sessionId, why: 'a compaction summary Claude Code wrote, stored as a human turn' }));
}

function repeatedItems(items: InboxText[]): { id: string; of: string; why: string }[] {
  const ordered = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const bySession = new Map<string, InboxText>();
  const decidedClaude = new Map<string, InboxText>();
  for (const i of ordered) {
    if (i.status !== 'pending' && i.source === 'claude') {
      const h = turnHash(i.text);
      if (h && !decidedClaude.has(`${i.projectKey}\n${h}`)) decidedClaude.set(`${i.projectKey}\n${h}`, i);
    }
  }
  const out: { id: string; of: string; why: string }[] = [];
  // Decided items first, so a pending one meets the decision it repeats whatever their order.
  for (const i of [...ordered.filter((x) => x.status !== 'pending'), ...ordered.filter((x) => x.status === 'pending')]) {
    const key = `${i.projectKey}\n${sessionRoot(i)}\n${i.text.trim()}`;
    const first = bySession.get(key);
    if (i.status === 'pending') {
      if (first) {
        out.push({ id: i.id, of: first.id, why: first.status === 'pending' ? 'the same words again in the same session or thread' : `the same turn read again under a new id; that one is ${first.status}` });
        continue;
      }
      const h = i.source === 'codex' ? turnHash(i.text) : null;
      const original = h ? decidedClaude.get(`${i.projectKey}\n${h}`) : undefined;
      if (original) {
        out.push({ id: i.id, of: original.id, why: `a Codex copy of a Claude Code turn; that one is ${original.status}` });
        continue;
      }
    }
    if (!first) bySession.set(key, i);
  }
  return out;
}

/**
 * Up to 0.8.2 a re-read Codex turn could be flagged again under a new id, a Codex import of a Claude Code conversation
 * with turns of its own was read as Codex's own, the same words twice in one thread were two items, and a compaction
 * summary without its flag was read as a human turn. Each such pending item is rejected (decided by DUPLICATE_DECIDER,
 * with a note naming the item it repeats, or the session whose summary it is).
 */
export async function rejectDuplicateItems(d: RepairDeps): Promise<{ examined: number; rejected: number } | null> {
  return once(d, DUPLICATE_ITEMS_CURSOR, 1, async () => {
    const items: InboxText[] = [];
    for (let after: string | null = null; ;) {
      const page = await d.graph.inboxTexts({ limit: PAGE, afterId: after });
      items.push(...page);
      if (page.length < PAGE) break;
      after = page.at(-1)!.id;
    }
    const rejected: { id: string; of: string; why: string }[] = [];
    for (const dup of duplicateItems(items)) {
      if (await d.graph.skipPendingItem(dup.id, { rule: 'duplicate', note: `duplicate of ${dup.of}: ${dup.why}`, by: DUPLICATE_DECIDER })) rejected.push(dup);
    }
    if (rejected.length) {
      await d.activity.record({
        kind: 'comments_skipped', actor: 'repair', projectKey: null,
        subject: `${rejected.length} duplicate Inbox item${rejected.length === 1 ? '' : 's'} rejected`,
        why: 'earlier versions filed the same turn twice (re-read under a new id, copied by Codex from Claude Code, or said twice in one thread) or read a compaction summary as a human turn',
        details: { repair: DUPLICATE_ITEMS_CURSOR, version: 1, rejected: rejected.slice(0, MAX_TARGETS) },
        targets: rejected.slice(0, MAX_TARGETS).map((r) => r.id),
      });
      d.log?.('duplicate Inbox items rejected', { rejected: rejected.length });
    }
    return { examined: items.length, rejected: rejected.length };
  });
}

/** Every repair, in order; each one's failure is logged and leaves it to run again at the next start. */
export const INVALID_SUMMARIES_CURSOR = 'repair-invalid-summaries';

/**
 * Up to 0.9.0 a summary answer was refused unless it was exactly the schema's object, and a local model often wraps
 * it in a list (`[{...}]`), so a session's summary failed on every try and waited out a backoff of up to six hours
 * between them. The answer is now read tolerantly (tolerantSummary): those sessions are tried again at once.
 */
export async function retryInvalidSummaries(d: RepairDeps): Promise<{ retried: number } | null> {
  const sessions = d.sessions;
  if (!sessions) return null;
  return once(d, INVALID_SUMMARIES_CURSOR, 1, async () => {
    const ids = await sessions.retryFailedSummaries(INVALID_SUMMARY);
    if (ids.length) {
      await d.activity.record({
        kind: 'session_summarized', actor: 'repair', projectKey: null,
        subject: `${ids.length} session summar${ids.length === 1 ? 'y' : 'ies'} that failed on the model's answer tried again`,
        why: 'the summary model\'s answers were refused for their shape (a list around the summary, say), which is now read',
        details: { repair: INVALID_SUMMARIES_CURSOR, version: 1, sessions: ids.slice(0, MAX_TARGETS) },
        targets: ids.slice(0, MAX_TARGETS).map((id) => `session:${id}`),
      });
      d.log?.('session summaries that failed on the answer\'s shape tried again', { sessions: ids.length });
    }
    return { retried: ids.length };
  });
}

export async function runRepairs(d: RepairDeps): Promise<void> {
  const failed = (what: string) => (err: unknown) => d.log?.(`${what} failed`, { error: String(err) });
  await retryInvalidSummaries(d).catch(failed('retrying failed session summaries'));
  await retitleThreadTasks(d).catch(failed('retitling PR and issue tasks'));
  await rejectDuplicateItems(d).catch(failed('rejecting duplicate Inbox items'));
}
