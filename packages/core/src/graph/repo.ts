import neo4j, { type Driver, type Record as NeoRecord } from 'neo4j-driver';
import type {
  Candidate,
  CandidateStatus,
  Classification,
  Commit,
  HumanTurn,
  ParsedSession,
  Project,
  WorkerStatus,
} from '../types.ts';
import type { GraphStore } from '../store.ts';
import { candidateProvenance, matchReport, REPORT_MERGE_MINUTES } from '../dedupe.ts';
import { MAX_POSTMORTEM_ATTEMPTS } from './knowledge.ts';
import { SCHEMA } from './schema.ts';

export type ClassifiableTurn = HumanTurn & { projectKey: string };

export type CandidateDetail = {
  candidate: Candidate;
  turn: HumanTurn;
  before: HumanTurn[];
  after: HumanTurn[];
  commits: Commit[];
  /** Null until you confirm it; then whether the post-mortem ran, is waiting to retry, or gave up. */
  postmortem: { done: boolean; attempts: number; lastError: string | null; retryAt: string | null; gaveUp: boolean } | null;
};

export type StatsRow = { projectKey: string; week: string; humanTurns: number; pushback: number };

export type CandidateFilter = { status?: CandidateStatus; projectKey?: string; limit?: number };

const CANDIDATE_LABELS = ['pushback', 'correction'];
export const MAX_CLASSIFY_ATTEMPTS = 3;

export class GraphRepo implements GraphStore {
  readonly driver: Driver;

  constructor(driver: Driver) {
    this.driver = driver;
  }

  static async connect(url: string, user: string, password: string): Promise<GraphRepo> {
    const driver = neo4j.driver(url, neo4j.auth.basic(user, password), { disableLosslessIntegers: true });
    await driver.verifyConnectivity();
    return new GraphRepo(driver);
  }

  close() {
    return this.driver.close();
  }

  async run(cypher: string, params: Record<string, unknown> = {}): Promise<NeoRecord[]> {
    const res = await this.driver.executeQuery(cypher, params);
    return res.records;
  }

  /** Several statements as one transaction: all of them land, or none do. */
  async runInTransaction(statements: [cypher: string, params: Record<string, unknown>][]): Promise<void> {
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        for (const [cypher, params] of statements) await tx.run(cypher, params);
      });
    } finally {
      await session.close();
    }
  }

  async ensureSchema() {
    for (const stmt of SCHEMA) {
      try {
        await this.run(stmt);
      } catch (err) {
        // The worker and the api start together; Neo4j can refuse IF NOT EXISTS when the other just created the rule.
        if ((err as { code?: string }).code !== 'Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists') throw err;
      }
    }
  }

  async wipeForTests() {
    await this.run('MATCH (n) DETACH DELETE n');
  }

  async count(label: string): Promise<number> {
    const [r] = await this.run(`MATCH (n:\`${label.replace(/`/g, '')}\`) RETURN count(n) AS c`);
    return r.get('c');
  }

  async upsertSession(project: Project, s: ParsedSession, commits: Commit[]) {
    await this.run(
      `MERGE (p:Project {key: $project.key})
         SET p.name = $project.name, p.repoPath = $project.repoPath, p.remote = coalesce($project.remote, p.remote)
       MERGE (s:Session {id: $s.sessionId})
         SET s.sourceFile = $s.sourceFile, s.source = $source, s.cwd = $s.cwd, s.gitBranch = $s.gitBranch,
             s.startedAt = $s.startedAt, s.endedAt = $s.endedAt
       MERGE (s)-[:IN]->(p)
       WITH s
       UNWIND $turns AS t
         MERGE (turn:Turn {uuid: t.uuid})
           SET turn.sessionId = t.sessionId, turn.ts = t.ts, turn.index = t.index, turn.text = t.text,
               turn.precedingAssistantText = t.precedingAssistantText, turn.toolCalls = t.toolCalls
         MERGE (s)-[:HAS_TURN]->(turn)`,
      {
        project: { ...project, remote: project.remote ?? null },
        s: { ...s, turns: undefined, toolCalls: undefined },
        source: s.source ?? 'claude',
        turns: s.turns.map((t) => ({ ...t, toolCalls: JSON.stringify(t.precedingToolCalls), precedingToolCalls: undefined })),
      },
    );
    if (commits.length) {
      await this.run(
        `MATCH (s:Session {id: $id})
         UNWIND $commits AS c
           MERGE (k:Commit {sha: c.sha}) SET k.ts = c.ts, k.subject = c.subject
           MERGE (s)-[:DURING]->(k)`,
        { id: s.sessionId, commits },
      );
    }
  }

  /**
   * The project a folder's sessions belong to. A folder that is not yet a project, whose remote an existing project
   * already has, is another clone of it: it becomes that project's alias. Projects that already exist are never
   * merged, so nothing recorded under a key moves.
   */
  async canonicalProject(folder: Project, o: { dryRun?: boolean } = {}): Promise<{ project: Project; aliasedNow: boolean }> {
    const alias = await this.projectByAlias(folder.key);
    if (alias) return { project: alias, aliasedNow: false };
    const [own] = await this.run('MATCH (p:Project {key: $key}) RETURN p', { key: folder.key });
    if (own || !folder.remote) return { project: folder, aliasedNow: false };
    if (o.dryRun) {
      const [would] = await this.run(
        'MATCH (o:Project {remote: $remote}) WHERE o.key <> $key RETURN o ORDER BY o.key LIMIT 1',
        { key: folder.key, remote: folder.remote },
      );
      return { project: would ? projectOf(would.get('o').properties) : folder, aliasedNow: false };
    }
    const [other] = await this.run(
      `MATCH (o:Project {remote: $remote}) WHERE o.key <> $key AND NOT $key IN coalesce(o.aliases, [])
       WITH o ORDER BY o.key LIMIT 1
       SET o.aliases = coalesce(o.aliases, []) + $key
       RETURN o`,
      { key: folder.key, remote: folder.remote },
    );
    return other ? { project: projectOf(other.get('o').properties), aliasedNow: true } : { project: folder, aliasedNow: false };
  }

  /** The project a folder key is an alias of, if any. */
  async projectByAlias(key: string): Promise<Project | null> {
    const [r] = await this.run('MATCH (p:Project) WHERE $key IN coalesce(p.aliases, []) RETURN p ORDER BY p.key LIMIT 1', { key });
    return r ? projectOf(r.get('p').properties) : null;
  }

  /** Projects ingested before remotes were recorded (or whose folder had none yet). */
  async projectsMissingRemote(): Promise<Project[]> {
    const rows = await this.run('MATCH (p:Project) WHERE p.remote IS NULL AND p.repoPath IS NOT NULL RETURN p ORDER BY p.key');
    return rows.map((r) => projectOf(r.get('p').properties));
  }

  async setProjectRemote(key: string, remote: string) {
    await this.run('MATCH (p:Project {key: $key}) SET p.remote = $remote', { key, remote });
  }

  /**
   * Turns still to classify, newest first so fresh feedback is not stuck behind the history backfill.
   * projectKeys undefined: every project; an empty list: none (nothing is selected).
   */
  async unclassifiedTurns(limit: number, projectKeys?: string[], excludeKeys?: string[]): Promise<ClassifiableTurn[]> {
    const rows = await this.run(
      `MATCH (p:Project)<-[:IN]-(:Session)-[:HAS_TURN]->(t:Turn)
       WHERE t.label IS NULL AND t.index > 0 AND ($keys IS NULL OR p.key IN $keys) AND NOT p.key IN $exclude
         AND coalesce(t.classifyAttempts, 0) < $maxAttempts
       RETURN t, p.key AS projectKey ORDER BY t.ts DESC LIMIT $limit`,
      { limit: neo4j.int(limit), keys: projectKeys ?? null, exclude: excludeKeys ?? [], maxAttempts: MAX_CLASSIFY_ATTEMPTS },
    );
    return rows.map((r) => ({ ...toTurn(r.get('t').properties), projectKey: r.get('projectKey') }));
  }

  /** A classification that failed (timeout, unparseable answer). After MAX_CLASSIFY_ATTEMPTS the turn is skipped for good. */
  async recordClassifyFailure(turnUuid: string) {
    await this.run(`MATCH (t:Turn {uuid: $uuid}) SET t.classifyAttempts = coalesce(t.classifyAttempts, 0) + 1`, { uuid: turnUuid });
  }

  async givenUpTurns(): Promise<number> {
    const [r] = await this.run(
      `MATCH (t:Turn) WHERE t.label IS NULL AND coalesce(t.classifyAttempts, 0) >= $maxAttempts RETURN count(t) AS n`,
      { maxAttempts: MAX_CLASSIFY_ATTEMPTS },
    );
    return Number(r.get('n'));
  }

  async requeueGivenUpTurns(): Promise<number> {
    const [r] = await this.run(
      `MATCH (t:Turn) WHERE t.label IS NULL AND coalesce(t.classifyAttempts, 0) >= $maxAttempts
       SET t.classifyAttempts = 0 RETURN count(t) AS n`,
      { maxAttempts: MAX_CLASSIFY_ATTEMPTS },
    );
    return Number(r.get('n'));
  }

  async saveClassification(turnUuid: string, c: Classification, makeCandidate: boolean): Promise<string | null> {
    await this.run(
      `MATCH (t:Turn {uuid: $uuid}) SET t.label = $c.label, t.confidence = $c.confidence, t.summary = $c.summary, t.signals = $c.signals`,
      { uuid: turnUuid, c },
    );
    if (!makeCandidate) return null;
    const merged = await this.mergeIntoReport(turnUuid);
    if (merged) return merged;
    await this.run(
      `MATCH (t:Turn {uuid: $uuid})
       WITH t WHERE $makeCandidate
       MATCH (p:Project)<-[:IN]-(s:Session)-[:HAS_TURN]->(t)
       MERGE (k:Candidate {id: t.uuid})
         ON CREATE SET k.status = 'pending', k.createdAt = $now, k.decidedAt = null, k.note = null
       SET k.turnUuid = t.uuid, k.sessionId = s.id, k.projectKey = p.key, k.ts = t.ts, k.source = coalesce(s.source, 'claude')
       MERGE (k)-[:FLAGS]->(t)`,
      { uuid: turnUuid, makeCandidate, now: new Date().toISOString() },
    );
    return turnUuid;
  }

  /**
   * An agent already reported this miss (report_feedback): a pending report moves onto this turn (the post-mortem then
   * sees the real session) and its manual stand-in session goes; a decided one only records the detector. Returns the
   * report's Inbox id if merged, else null.
   */
  private async mergeIntoReport(turnUuid: string): Promise<string | null> {
    const [turn] = await this.run(
      `MATCH (p:Project)<-[:IN]-(s:Session)-[:HAS_TURN]->(t:Turn {uuid: $uuid})
       WHERE NOT EXISTS { MATCH (:Candidate {id: t.uuid}) } AND t.ts IS NOT NULL
       RETURN t.ts AS ts, t.text AS text, s.id AS sessionId, p.key AS projectKey`,
      { uuid: turnUuid },
    );
    if (!turn || Number.isNaN(Date.parse(turn.get('ts')))) return null;
    const t0 = Date.parse(turn.get('ts'));
    const rows = await this.run(
      `MATCH (k:Candidate {projectKey: $key, manual: true})-[:FLAGS]->(mt:Turn)
       WHERE NOT coalesce(k.detected, false) AND k.status <> 'rejected'
         AND datetime(k.createdAt) >= datetime($from) AND datetime(k.createdAt) <= datetime($to)
       RETURN k, mt`,
      {
        key: turn.get('projectKey'),
        from: new Date(t0 - REPORT_MERGE_MINUTES * 60_000).toISOString(),
        to: new Date(t0 + REPORT_MERGE_MINUTES * 60_000).toISOString(),
      },
    );
    const reports = rows.map((r) => {
      const k = r.get('k').properties;
      const { agentReport } = candidateProvenance({
        manual: true, detected: false, agentReport: k.agentReport ? JSON.parse(k.agentReport) : null,
        turnText: r.get('mt').properties.text, turnWhatWasDone: r.get('mt').properties.precedingAssistantText, createdAt: k.createdAt,
      });
      return { id: k.id as string, status: k.status as CandidateStatus, report: agentReport!, ts: k.createdAt as string, text: agentReport!.text, sessionId: agentReport!.sessionId };
    });
    const hit = matchReport({ ts: turn.get('ts'), text: turn.get('text') ?? '', sessionId: turn.get('sessionId') }, reports);
    if (!hit) return null;
    if (hit.status !== 'pending') {
      await this.run(`MATCH (k:Candidate {id: $id}) SET k.detected = true, k.detectedTurnUuid = $uuid`, { id: hit.id, uuid: turnUuid });
      return hit.id;
    }
    await this.run(
      `MATCH (k:Candidate {id: $id})-[r:FLAGS]->(old:Turn)
       MATCH (p:Project)<-[:IN]-(s:Session)-[:HAS_TURN]->(t:Turn {uuid: $uuid})
       DELETE r
       MERGE (k)-[:FLAGS]->(t)
       SET k.turnUuid = t.uuid, k.sessionId = s.id, k.ts = t.ts, k.source = coalesce(s.source, 'claude'), k.detected = true,
           k.agentReport = $report
       WITH old
       OPTIONAL MATCH (ms:Session {manual: true})-[:HAS_TURN]->(old)
       DETACH DELETE old, ms`,
      { id: hit.id, uuid: turnUuid, report: JSON.stringify(hit.report) },
    );
    return hit.id;
  }

  async listCandidates(f: CandidateFilter = {}): Promise<Candidate[]> {
    const rows = await this.run(
      `MATCH (k:Candidate)-[:FLAGS]->(t:Turn)
       WHERE ($status IS NULL OR k.status = $status) AND ($projectKey IS NULL OR k.projectKey = $projectKey)
       RETURN k, t ORDER BY t.ts DESC LIMIT $limit`,
      { status: f.status ?? null, projectKey: f.projectKey ?? null, limit: neo4j.int(f.limit ?? 200) },
    );
    return rows.map((r) => toCandidate(r.get('k').properties, r.get('t').properties));
  }

  async candidateDetail(id: string): Promise<CandidateDetail | null> {
    const [r] = await this.run(
      `MATCH (k:Candidate {id: $id})-[:FLAGS]->(t:Turn)<-[:HAS_TURN]-(s:Session)
       OPTIONAL MATCH (s)-[:HAS_TURN]->(n:Turn) WHERE n.index >= t.index - 2 AND n.index <= t.index + 2 AND n <> t
       WITH k, t, s, n ORDER BY n.index
       WITH k, t, s, collect(n) AS near
       OPTIONAL MATCH (s)-[:DURING]->(c:Commit)
       WITH k, t, near, c ORDER BY datetime(c.ts)
       WITH k, t, near, collect(c) AS commits
       OPTIONAL MATCH (f:Feedback {id: k.id})
       RETURN k, t, near, commits, f, EXISTS { MATCH (f)<-[:EXPLAINS]-(:Miss) } AS done`,
      { id },
    );
    if (!r) return null;
    const t = toTurn(r.get('t').properties);
    const near = (r.get('near') as { properties: Record<string, unknown> }[]).map((n) => toTurn(n.properties));
    return {
      candidate: toCandidate(r.get('k').properties, r.get('t').properties),
      turn: t,
      before: near.filter((n) => n.index < t.index),
      after: near.filter((n) => n.index > t.index),
      commits: (r.get('commits') as { properties: Commit }[]).map((c) => ({
        sha: c.properties.sha,
        ts: c.properties.ts,
        subject: c.properties.subject,
      })),
      postmortem: postmortemState(r.get('f')?.properties, r.get('done')),
    };
  }

  async decide(id: string, status: 'confirmed' | 'rejected', note: string | null) {
    await this.run(
      `MATCH (k:Candidate {id: $id})-[:FLAGS]->(t:Turn)
       SET k.status = $status, k.note = $note, k.decidedAt = $now
       WITH k, t WHERE $status = 'confirmed'
       MERGE (f:Feedback {id: k.id})
         ON CREATE SET f.status = 'open', f.createdAt = $now, f.projectKey = k.projectKey, f.text = t.text
       SET f.status = CASE f.status WHEN 'rejected' THEN 'open' ELSE f.status END
       MERGE (f)-[:FROM_TURN]->(t)`,
      { id, status, note, now: new Date().toISOString() },
    );
    if (status === 'rejected') {
      // Changing your mind after confirming: stop the post-mortem and withdraw lessons you have not approved yet.
      await this.run(
        `MATCH (f:Feedback {id: $id}) SET f.status = 'rejected'
         WITH f OPTIONAL MATCH (l:Lesson {status: 'proposed'})-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(f)
         SET l.status = 'rejected'`,
        { id },
      );
    }
  }

  /**
   * TURN_RETENTION_DAYS: drop the words of classified turns older than the cutoff that nothing points at.
   * Flagged turns and the turns around them stay (they are the evidence for candidates, feedback and post-mortems).
   */
  async pruneTurnText(before: Date, limit = 5000): Promise<number> {
    const [r] = await this.run(
      `MATCH (s:Session)-[:HAS_TURN]->(t:Turn)
       WHERE t.ts < $before AND (t.label IS NOT NULL OR t.index = 0) AND t.text IS NOT NULL
         AND NOT EXISTS { MATCH (s)-[:HAS_TURN]->(:Turn)<-[:FLAGS]-(:Candidate) }
       WITH t LIMIT $limit
       SET t.text = null, t.precedingAssistantText = null, t.toolCalls = '[]', t.prunedAt = $now
       RETURN count(t) AS n`,
      { before: before.toISOString(), limit: neo4j.int(limit), now: new Date().toISOString() },
    );
    return r?.get('n') ?? 0;
  }

  async ping(): Promise<boolean> {
    try {
      await this.run('RETURN 1');
      return true;
    } catch {
      return false;
    }
  }

  async heartbeat(s: WorkerStatus) {
    await this.run(`MERGE (w:WorkerStatus {id: 'worker'}) SET w.json = $json, w.lastBeat = $beat`, { json: JSON.stringify(s), beat: s.lastBeat });
  }

  async workerStatus(): Promise<WorkerStatus | null> {
    const [r] = await this.run(`MATCH (w:WorkerStatus {id: 'worker'}) RETURN w.json AS json`);
    return r ? (JSON.parse(r.get('json')) as WorkerStatus) : null;
  }

  async stats(): Promise<StatsRow[]> {
    const rows = await this.run(
      `MATCH (p:Project)<-[:IN]-(:Session)-[:HAS_TURN]->(t:Turn) WHERE t.index > 0
       WITH p.key AS projectKey, date(datetime(t.ts)) AS d, t
       WITH projectKey, toString(d.weekYear) + '-W' + right('0' + toString(d.week), 2) AS week, t
       RETURN projectKey, week, count(t) AS humanTurns,
              sum(CASE WHEN t.label IN $labels THEN 1 ELSE 0 END) AS pushback
       ORDER BY week, projectKey`,
      { labels: CANDIDATE_LABELS },
    );
    return rows.map((r) => ({
      projectKey: r.get('projectKey'),
      week: r.get('week'),
      humanTurns: r.get('humanTurns'),
      pushback: r.get('pushback'),
    }));
  }
}

/** Where a confirmed feedback's post-mortem stands, from the feedback's attempt fields and whether a miss explains it. */
export function postmortemState(f: Record<string, unknown> | undefined, done: boolean): CandidateDetail['postmortem'] {
  if (!f) return null;
  const attempts = Number(f.attempts ?? 0);
  return {
    done: !!done,
    attempts,
    lastError: (f.lastError as string) ?? null,
    retryAt: (f.retryAt as string) ?? null,
    gaveUp: !done && attempts >= MAX_POSTMORTEM_ATTEMPTS,
  };
}

function toTurn(p: Record<string, unknown>): HumanTurn {
  return {
    uuid: p.uuid as string,
    sessionId: p.sessionId as string,
    ts: p.ts as string,
    index: p.index as number,
    text: p.text as string,
    precedingAssistantText: (p.precedingAssistantText as string) ?? '',
    precedingToolCalls: JSON.parse((p.toolCalls as string) ?? '[]'),
  };
}

function toCandidate(k: Record<string, unknown>, t: Record<string, unknown>): Candidate {
  const provenance = candidateProvenance({
    manual: !!k.manual,
    detected: !!k.detected,
    agentReport: k.agentReport ? JSON.parse(k.agentReport as string) : null,
    turnText: t.text as string,
    turnWhatWasDone: t.precedingAssistantText as string,
    createdAt: k.createdAt as string,
  });
  return {
    id: k.id as string,
    turnUuid: k.turnUuid as string,
    sessionId: k.sessionId as string,
    projectKey: k.projectKey as string,
    source: (k.source as Candidate['source']) ?? 'claude',
    classification: {
      label: t.label as Classification['label'],
      confidence: t.confidence as number,
      summary: t.summary as string,
      signals: (t.signals as string[]) ?? [],
    },
    status: k.status as CandidateStatus,
    createdAt: k.createdAt as string,
    decidedAt: (k.decidedAt as string) ?? null,
    note: (k.note as string) ?? null,
    ...provenance,
  };
}

function projectOf(p: Record<string, unknown>): Project {
  const key = p.key as string;
  return { key, name: (p.name as string) ?? key, repoPath: (p.repoPath as string) ?? '', remote: (p.remote as string) ?? null };
}
