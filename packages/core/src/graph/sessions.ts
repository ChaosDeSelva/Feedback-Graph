import neo4j from 'neo4j-driver';
import { redactDeep, redactSecrets } from '../redact.ts';
import { latestTime, readSummary, summaryRetryAt, summarySnippet, type SessionCursor, type SummaryWork, type SummaryWorkQuery, type SummaryWrite } from '../sessions.ts';
import type { SessionsStore } from '../store.ts';
import type { CandidateStatus, HumanTurn, LessonStatus, SessionDetail, SessionListItem, SessionSource, SessionState, SummaryCursor, SummaryUpdate } from '../types.ts';
import type { GraphRepo } from './repo.ts';

/**
 * Session summaries live on the (:Session) node: summaryJson (the redacted summary), summarizedThroughIndex/Ts (the
 * cursor), summaryVersion, summaryModel, summaryUpdatedAt, state, the backoff fields, and summaryHistory (one JSON
 * string per update, the newest HISTORY_KEEP), and finalReplySummarizedTs (the time of the final reply the summary took in). Deleting the session (a project delete) deletes them with it.
 * upsertSession keeps turnCount, lastTurnIndex, lastTurnTs and lastActivityAt current (refreshSessionStats).
 */
const HISTORY_KEEP = 200;
const ERROR_CHARS = 500;

/** After a session's turns were written: its turn count, last turn and last activity (which only moves forward). */
export async function refreshSessionStats(g: GraphRepo, sessionId: string, activity: string | null): Promise<void> {
  await g.run(
    `MATCH (s:Session {id: $id})
     OPTIONAL MATCH (s)-[:HAS_TURN]->(t:Turn)
     WITH s, t ORDER BY t.index DESC
     WITH s, collect(t)[0] AS last, count(t) AS n
     SET s.turnCount = n, s.lastTurnIndex = last.index, s.lastTurnTs = last.ts,
         s.lastActivityAt = CASE WHEN $activity IS NULL THEN s.lastActivityAt
                                 WHEN s.lastActivityAt IS NULL OR s.lastActivityAt < $activity THEN $activity
                                 ELSE s.lastActivityAt END`,
    { id: sessionId, activity },
  );
}

const BACKFILL_BATCH = 500;

/** Sessions stored before summaries existed get their stats once (ensureSchema). Times are normalized here, in JS. */
export async function backfillSessionStats(g: GraphRepo): Promise<number> {
  let done = 0;
  for (;;) {
    const rows = await g.run(
      `MATCH (s:Session) WHERE s.lastTurnIndex IS NULL AND s.statsChecked IS NULL
       WITH s LIMIT $batch
       OPTIONAL MATCH (s)-[:HAS_TURN]->(t:Turn)
       WITH s, t ORDER BY t.index DESC
       WITH s, collect(t)[0] AS last
       RETURN s.id AS id, s.endedAt AS endedAt, last.ts AS ts`,
      { batch: neo4j.int(BACKFILL_BATCH) },
    );
    if (!rows.length) return done;
    for (const r of rows) {
      await refreshSessionStats(g, r.get('id'), latestTime(r.get('endedAt'), r.get('ts')));
      // A session with no turns keeps a null lastTurnIndex: mark it so the loop does not pick it again.
      await g.run('MATCH (s:Session {id: $id}) SET s.statsChecked = true', { id: r.get('id') });
    }
    done += rows.length;
  }
}

type Props = Record<string, unknown>;

const cursorOf = (index: unknown, ts: unknown): SummaryCursor | null =>
  index === null || index === undefined ? null : { index: Number(index), ts: (ts as string) ?? '' };

function listItem(s: Props, projectKey: string): SessionListItem {
  const summary = readSummary(s.summaryJson);
  const through = cursorOf(s.summarizedThroughIndex, s.summarizedThroughTs);
  const last = s.lastTurnIndex === null || s.lastTurnIndex === undefined ? -1 : Number(s.lastTurnIndex);
  return {
    id: s.id as string,
    projectKey,
    source: ((s.source as SessionSource) ?? 'claude'),
    cwd: (s.cwd as string) ?? null,
    gitBranch: (s.gitBranch as string) ?? null,
    startedAt: (s.startedAt as string) ?? null,
    lastActivityAt: (s.lastActivityAt as string) ?? null,
    turnCount: Number(s.turnCount ?? 0),
    state: ((s.state as SessionState) ?? 'active'),
    snippet: summarySnippet(summary),
    summarizedThrough: through,
    summaryUpdatedAt: (s.summaryUpdatedAt as string) ?? null,
    summaryVersion: Number(s.summaryVersion ?? 0),
    pendingTurns: Math.max(0, last - (through?.index ?? -1)),
  };
}

function history(raw: unknown): SummaryUpdate[] {
  return ((raw as string[] | null) ?? []).flatMap((x) => {
    try {
      return [JSON.parse(x) as SummaryUpdate];
    } catch {
      return [];
    }
  });
}

function toTurn(p: Props): HumanTurn {
  return {
    uuid: p.uuid as string,
    sessionId: p.sessionId as string,
    ts: p.ts as string,
    index: p.index as number,
    text: (p.text as string) ?? '',
    precedingAssistantText: (p.precedingAssistantText as string) ?? '',
    precedingToolCalls: JSON.parse((p.toolCalls as string) ?? '[]'),
  };
}

export class SessionsRepo implements SessionsStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async list(q: { projectKeys: string[]; state?: SessionState; limit: number; after?: SessionCursor | null; summarizedOnly?: boolean }) {
    const rows = await this.g.run(
      `MATCH (p:Project)<-[:IN]-(s:Session)
       WHERE p.key IN $keys AND NOT coalesce(s.manual, false) AND s.lastTurnIndex IS NOT NULL
         AND ($state IS NULL OR coalesce(s.state, 'active') = $state)
         AND (NOT $summarized OR s.summaryJson IS NOT NULL)
         AND ($afterAt IS NULL OR coalesce(s.lastActivityAt, '') < $afterAt OR (coalesce(s.lastActivityAt, '') = $afterAt AND s.id > $afterId))
       RETURN s, p.key AS projectKey ORDER BY coalesce(s.lastActivityAt, '') DESC, s.id LIMIT $limit`,
      {
        keys: q.projectKeys,
        state: q.state ?? null,
        summarized: !!q.summarizedOnly,
        afterAt: q.after?.at ?? null,
        afterId: q.after?.id ?? '',
        limit: neo4j.int(q.limit + 1),
      },
    );
    const items = rows.map((r) => listItem(r.get('s').properties, r.get('projectKey')));
    const page = items.slice(0, q.limit);
    const last = page.at(-1);
    return { sessions: page, next: items.length > q.limit && last ? { at: last.lastActivityAt ?? '', id: last.id } : null };
  }

  async detail(id: string): Promise<SessionDetail | null> {
    const [r] = await this.g.run(
      `MATCH (p:Project)<-[:IN]-(s:Session {id: $id}) WHERE NOT coalesce(s.manual, false)
       CALL { WITH s OPTIONAL MATCH (s)-[:HAS_TURN]->(pt:Turn) WHERE pt.prunedAt IS NOT NULL RETURN count(pt) AS pruned }
       CALL {
         WITH s
         OPTIONAL MATCH (k:Candidate {sessionId: s.id})-[:FLAGS]->(t:Turn)
         OPTIONAL MATCH (l:Lesson)-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(:Feedback {id: k.id})
         WITH k, t, l ORDER BY t.ts, k.id
         RETURN collect(CASE WHEN k IS NULL THEN null ELSE {id: k.id, status: k.status, label: t.label, summary: t.summary, lessonId: l.id, lessonStatus: l.status} END) AS inbox
       }
       RETURN s, p.key AS projectKey, pruned, inbox`,
      { id },
    );
    if (!r) return null;
    const s = r.get('s').properties as Props;
    return {
      ...listItem(s, r.get('projectKey')),
      summary: readSummary(s.summaryJson),
      summaryModel: (s.summaryModel as string) ?? null,
      history: history(s.summaryHistory),
      rebuildRequested: !!s.summaryRebuild,
      prunedTurns: Number(r.get('pruned')),
      summaryError: (s.summaryError as string) ?? null,
      summaryRetryAt: (s.summaryRetryAt as string) ?? null,
      inbox: (r.get('inbox') as Props[]).map((k) => ({
        id: k.id as string,
        status: k.status as CandidateStatus,
        label: (k.label as string) ?? null,
        summary: (k.summary as string) ?? null,
        lessonId: (k.lessonId as string) ?? null,
        lessonStatus: (k.lessonStatus as LessonStatus) ?? null,
      })),
    };
  }

  async work(q: SummaryWorkQuery): Promise<SummaryWork[]> {
    const rows = await this.g.run(
      `MATCH (p:Project)<-[:IN]-(s:Session)
       WHERE p.key IN $keys AND NOT p.key IN $exclude AND NOT coalesce(s.manual, false) AND s.lastTurnIndex IS NOT NULL
       WITH s, p, s.lastTurnIndex - coalesce(s.summarizedThroughIndex, -1) AS pending, coalesce(s.lastActivityAt, '') AS act,
            coalesce(s.summaryRebuild, false) AS rebuild, (s.summaryRetryAt IS NULL OR s.summaryRetryAt <= $now) AS due
       WITH s, p, pending, act, rebuild, due, (s.summarizedThroughIndex IS NULL AND NOT rebuild AND act < $idleBefore) AS history,
            (s.finalReplyText IS NOT NULL AND NOT rebuild AND s.summarizedThroughIndex IS NOT NULL AND pending <= 0
             AND (s.finalReplySummarizedTs IS NULL OR s.finalReplySummarizedTs <> coalesce(s.finalReplyTs, ''))) AS reply
       WHERE CASE WHEN $backfill THEN history AND due
             ELSE NOT history AND (
               ((rebuild OR pending > 0) AND due AND (rebuild OR act < $quietBefore OR pending >= $maxDelta OR s.state = 'idle'))
               OR (pending > 0 AND s.state = 'idle')
               OR (reply AND due AND (act < $quietBefore OR s.state = 'idle'))
               OR (pending <= 0 AND coalesce(s.state, 'active') = 'active' AND act < $idleBefore))
             END
       RETURN s, p.key AS projectKey, pending, rebuild ORDER BY act DESC, s.id LIMIT $limit`,
      {
        keys: q.projectKeys,
        exclude: q.excludeKeys ?? [],
        now: (q.now ?? new Date()).toISOString(),
        quietBefore: q.quietBefore.toISOString(),
        idleBefore: q.idleBefore.toISOString(),
        maxDelta: neo4j.int(q.maxDeltaTurns),
        backfill: q.backfill,
        limit: neo4j.int(q.limit),
      },
    );
    return rows.map((r) => {
      const s = r.get('s').properties as Props;
      return {
        id: s.id as string,
        projectKey: r.get('projectKey'),
        source: (s.source as SessionSource) ?? 'claude',
        cwd: (s.cwd as string) ?? null,
        lastTurn: { index: Number(s.lastTurnIndex), ts: (s.lastTurnTs as string) ?? '' },
        lastActivityAt: (s.lastActivityAt as string) ?? null,
        turnCount: Number(s.turnCount ?? 0),
        state: (s.state as SessionState) ?? null,
        summary: readSummary(s.summaryJson),
        summarizedThrough: cursorOf(s.summarizedThroughIndex, s.summarizedThroughTs),
        summaryVersion: Number(s.summaryVersion ?? 0),
        rebuild: !!r.get('rebuild'),
        retryAt: (s.summaryRetryAt as string) ?? null,
        pending: Math.max(0, Number(r.get('pending'))),
        finalReply: typeof s.finalReplyText === 'string' ? { text: s.finalReplyText, ts: (s.finalReplyTs as string) ?? '' } : null,
        finalReplySummarizedTs: (s.finalReplySummarizedTs as string) ?? null,
      };
    });
  }

  async turns(sessionId: string, afterIndex: number, limit: number): Promise<HumanTurn[]> {
    const rows = await this.g.run(
      `MATCH (s:Session {id: $id})-[:HAS_TURN]->(t:Turn) WHERE t.index > $after RETURN t ORDER BY t.index LIMIT $limit`,
      { id: sessionId, after: neo4j.int(afterIndex), limit: neo4j.int(limit) },
    );
    return rows.map((r) => toTurn(r.get('t').properties));
  }

  async save(sessionId: string, w: SummaryWrite): Promise<boolean> {
    const at = (w.at ?? new Date()).toISOString();
    const version = w.prevVersion + 1;
    const entry: SummaryUpdate = { version, from: w.from, to: w.to, deltaTurns: w.deltaTurns, model: w.model, at, rebuild: w.rebuild };
    const rows = await this.g.run(
      `MATCH (s:Session {id: $id})
       WHERE coalesce(s.summaryVersion, 0) = $prev AND coalesce(s.summaryRebuild, false) = $rebuild
       SET s.summaryJson = $json, s.summarizedThroughIndex = $to.index, s.summarizedThroughTs = $to.ts,
           s.summaryUpdatedAt = $at, s.summaryModel = $model, s.summaryVersion = $version, s.state = $state,
           s.summaryRebuild = false, s.summaryAttempts = 0, s.summaryRetryAt = null, s.summaryError = null,
           s.finalReplySummarizedTs = CASE WHEN $replyTs IS NOT NULL THEN $replyTs WHEN $rebuild THEN null ELSE s.finalReplySummarizedTs END,
           s.summaryHistory = (coalesce(s.summaryHistory, []) + $entry)[-${HISTORY_KEEP}..]
       RETURN s.id AS id`,
      {
        id: sessionId,
        prev: neo4j.int(w.prevVersion),
        rebuild: w.rebuild,
        json: JSON.stringify(redactDeep(w.summary)),
        to: { index: neo4j.int(w.to.index), ts: w.to.ts },
        at,
        model: w.model,
        version: neo4j.int(version),
        state: w.state,
        entry: JSON.stringify(entry),
        replyTs: w.finalReplyTs ?? null,
      },
    );
    return rows.length > 0;
  }

  async recordFailure(sessionId: string, error: string, now: Date = new Date()) {
    const [r] = await this.g.run(
      `MATCH (s:Session {id: $id}) SET s.summaryAttempts = coalesce(s.summaryAttempts, 0) + 1, s.summaryError = $error
       RETURN s.summaryAttempts AS n`,
      { id: sessionId, error: redactSecrets(error).slice(0, ERROR_CHARS) },
    );
    const attempts = Number(r?.get('n') ?? 1);
    const retryAt = summaryRetryAt(attempts, now);
    await this.g.run('MATCH (s:Session {id: $id}) SET s.summaryRetryAt = $retryAt', { id: sessionId, retryAt });
    return { attempts, retryAt };
  }

  async setState(sessionId: string, state: SessionState) {
    await this.g.run('MATCH (s:Session {id: $id}) SET s.state = $state', { id: sessionId, state });
  }

  async requestRebuild(sessionId: string): Promise<boolean> {
    const rows = await this.g.run(
      `MATCH (s:Session {id: $id}) WHERE NOT coalesce(s.manual, false)
       SET s.summaryRebuild = true, s.summaryAttempts = 0, s.summaryRetryAt = null, s.summaryError = null
       RETURN s.id AS id`,
      { id: sessionId },
    );
    return rows.length > 0;
  }
}
