import { storeTimeLeft, storeRequestSignal, StoreDeadlineError } from '../storeDeadline.ts';
import { reviewPatterns } from '../reviewFilters.ts';
import neo4j, { type Driver, type Record as NeoRecord } from 'neo4j-driver';
import type {
  Candidate,
  CandidateStatus,
  Classification,
  Commit,
  HumanTurn,
  ParsedSession,
  PendingExternalItem,
  PendingSessionItem,
  Project,
  ToolCall,
  WorkerStatus,
} from '../types.ts';
import type { ExternalThread, GraphStore, WorkSession } from '../store.ts';
import { EXTERNAL_SOURCES, type ExternalRef, type FeedbackSource, type SessionSource } from '../types.ts';
import { redactDeep } from '../redact.ts';
import { candidateProvenance, matchReport, REPORT_MERGE_MINUTES } from '../dedupe.ts';
import { MAX_POSTMORTEM_ATTEMPTS } from './knowledge.ts';
import { VISIBLE_TO_RUN } from './runs.ts';
import { SCHEMA } from './schema.ts';
import { REDACT_PAGE, redactSecrets, redactStoredRow } from '../redact.ts';
import { latestTime } from '../sessions.ts';
import { sessionWork, trailingToolCalls } from '../codegraph.ts';
import { refreshSessionStats } from './sessions.ts';
import { SandboxPresence } from '../sandboxPresence.ts';

export type ClassifiableTurn = HumanTurn & { projectKey: string };

/**
 * What the agent did after a turn, as recorded so far: the tool calls of the later turns and those after the last one,
 * oldest first; how many turns came later; and the session's last recorded time.
 */
export type CallsAfter = { calls: ToolCall[]; laterTurns: number; endedAt: string | null };

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

/** projectKeys: only these projects (an empty list finds nothing); the limit counts what is left. */
/** source: where the flagged comment came from (a candidate saved before sources were recorded is claude). */
/** offset: skip that many (newest first), for paging. */
/** run: the asking run (RunTag.id): a sandbox run's Inbox items are listed only to it; unset or null, to no one. */
export type CandidateFilter = { status?: CandidateStatus; projectKey?: string; projectKeys?: string[]; source?: FeedbackSource; pr?: number; author?: string; limit?: number; offset?: number; run?: string | null };

const CANDIDATE_LABELS = ['pushback', 'correction'];
export const MAX_CLASSIFY_ATTEMPTS = 3;

/** The labels a sandbox run's records carry `sandbox: true` on (a document's chunks go with their Doc). */
const SANDBOX_LABELS = ['Candidate', 'Lesson', 'Miss', 'Fact', 'Doc', 'ProjectLink'];

export class GraphRepo implements GraphStore {
  readonly driver: Driver;
  /** Whether any sandbox record exists: the searches skip the per-record run filter when none does (SandboxPresence). */
  readonly sandbox: SandboxPresence;

  constructor(driver: Driver) {
    this.driver = driver;
    this.sandbox = new SandboxPresence(async () => {
      // Through each label's run index: a sandbox record always has its run.
      const [r] = await this.run(`RETURN ${SANDBOX_LABELS.map((l) => `EXISTS { MATCH (x:${l}) WHERE x.run IS NOT NULL AND x.sandbox = true }`).join(' OR ')} AS any`);
      return r?.get('any') === true;
    });
  }

  static async connect(url: string, user: string, password: string): Promise<GraphRepo> {
    const driver = neo4j.driver(url, neo4j.auth.basic(user, password), { disableLosslessIntegers: true, connectionAcquisitionTimeout: 5000, connectionTimeout: 5000, maxTransactionRetryTime: 0 });
    await driver.verifyConnectivity();
    return new GraphRepo(driver);
  }

  close() {
    return this.driver.close();
  }

  async run(cypher: string, params: Record<string, unknown> = {}): Promise<NeoRecord[]> {
    const timeout = storeTimeLeft();
    const session = this.driver.session();
    const signal = storeRequestSignal();
    const cancel = () => { void session.close().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await session.run(cypher, params, { timeout });
      if (signal?.aborted) throw new StoreDeadlineError();
      return result.records;
    } finally { signal?.removeEventListener('abort', cancel); await session.close(); }
  }

  /** Several statements as one transaction: all of them land, or none do. Returns each statement's records. */
  async runInTransaction(statements: [cypher: string, params: Record<string, unknown>][]): Promise<NeoRecord[][]> {
    const session = this.driver.session();
    try {
      return await session.executeWrite(async (tx) => {
        const out: NeoRecord[][] = [];
        for (const [cypher, params] of statements) { storeTimeLeft(); out.push((await tx.run(cypher, params)).records); }
        storeTimeLeft();
        return out;
      }, { timeout: storeTimeLeft() });
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
    for (;;) {
      const [row] = await this.run('MATCH (n) WITH n LIMIT 1000 DETACH DELETE n RETURN count(*) AS removed');
      if (Number(row?.get('removed') ?? 0) < 1000) break;
    }
    this.sandbox.recheck();
  }

  async count(label: string): Promise<number> {
    const [r] = await this.run(`MATCH (n:\`${label.replace(/`/g, '')}\`) RETURN count(n) AS c`);
    return r.get('c');
  }

  async upsertSession(project: Project, s: ParsedSession, commits: Commit[]) {
    await this.run(
      `MERGE (binding:SessionRun {sessionId: $s.sessionId})
       SET binding.lock = coalesce(binding.lock, 0) + 1, binding.projectKey = $project.key
       WITH binding MERGE (p:Project {key: $project.key})
         SET p.name = $project.name, p.repoPath = $project.repoPath, p.remote = coalesce($project.remote, p.remote)
       MERGE (s:Session {id: $s.sessionId})
         SET s.sourceFile = $s.sourceFile, s.source = $source, s.cwd = $s.cwd, s.gitBranch = $s.gitBranch,
             s.startedAt = $s.startedAt, s.endedAt = $s.endedAt,
             s.finalReplyText = $finalReply.text, s.finalReplyTs = $finalReply.ts, s.finalToolCalls = $finalToolCalls,
             s.workEdits = $work.edits, s.workCommits = $work.commits, s.firstWorkAt = $work.firstAt, s.lastWorkAt = $work.lastAt,
             s.instructionFiles = $instructionFiles, s.run = binding.run, s.sandbox = coalesce(binding.sandbox, false)
       MERGE (s)-[:IN]->(p)
       WITH s
       UNWIND $turns AS t
         MERGE (turn:Turn {uuid: t.uuid})
           SET turn.sessionId = t.sessionId, turn.ts = t.ts, turn.index = t.index, turn.text = t.text,
               turn.precedingAssistantText = t.precedingAssistantText, turn.toolCalls = t.toolCalls, turn.run = s.run, turn.sandbox = s.sandbox
         MERGE (s)-[:HAS_TURN]->(turn)`,
      {
        project: { ...project, remote: project.remote ?? null },
        s: { ...s, turns: undefined, toolCalls: undefined, finalReply: undefined, instructionFiles: undefined },
        instructionFiles: s.instructionFiles ?? null,
        source: s.source ?? 'claude',
        work: sessionWork(s.toolCalls ?? []),
        finalToolCalls: JSON.stringify(trailingToolCalls(s)),
        // Redacted by the parser, and again here: it is stored like a turn's text.
        finalReply: s.finalReply ? { text: redactSecrets(s.finalReply.text), ts: s.finalReply.ts } : { text: null, ts: null },
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
    await refreshSessionStats(this, s.sessionId, latestTime(s.endedAt, s.turns.at(-1)?.ts));
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

  /** Records with no remote or no folder path (scans, code maps and uploads make them with neither). */
  async projectsMissingFolder(): Promise<Project[]> {
    const rows = await this.run(`MATCH (p:Project) WHERE p.remote IS NULL OR coalesce(p.repoPath, '') = '' RETURN p ORDER BY p.key`);
    return rows.map((r) => projectOf(r.get('p').properties));
  }

  /** Fill a record's folder path and remote where missing; one already set is never overwritten. */
  async fillProjectFolder(key: string, folder: { repoPath: string; remote: string | null }) {
    await this.run(
      `MATCH (p:Project {key: $key})
       SET p.repoPath = CASE WHEN coalesce(p.repoPath, '') = '' THEN $repoPath ELSE p.repoPath END, p.remote = coalesce(p.remote, $remote)`,
      { key, repoPath: folder.repoPath, remote: folder.remote },
    );
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

  async callsAfter(turnUuid: string): Promise<CallsAfter | null> {
    const [r] = await this.run(
      `MATCH (s:Session)-[:HAS_TURN]->(t:Turn {uuid: $uuid})
       OPTIONAL MATCH (s)-[:HAS_TURN]->(n:Turn) WHERE n.index > t.index
       WITH s, n ORDER BY n.index
       RETURN s.finalToolCalls AS final, s.endedAt AS endedAt, collect(n.toolCalls) AS later`,
      { uuid: turnUuid },
    );
    if (!r) return null;
    const later = (r.get('later') as (string | null)[]).map((j) => JSON.parse(j ?? '[]') as ToolCall[]);
    return { calls: [...later.flat(), ...(JSON.parse(r.get('final') ?? '[]') as ToolCall[])], laterTurns: later.length, endedAt: isoOrNull(r.get('endedAt')) };
  }

  async sessionInstructionFiles(sessionId: string): Promise<string[] | null> {
    const [r] = await this.run('MATCH (s:Session {id: $id}) RETURN s.instructionFiles AS f', { id: sessionId });
    const f = r?.get('f');
    return Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : null;
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
    this.sandbox.mark(); // A transcript-derived candidate may inherit a sandbox binding from another process.
    const merged = await this.mergeIntoReport(turnUuid);
    if (merged) return merged;
    await this.run(
      `MATCH (t:Turn {uuid: $uuid})
       WITH t WHERE $makeCandidate
       MATCH (p:Project)<-[:IN]-(s:Session)-[:HAS_TURN]->(t)
       MERGE (k:Candidate {id: t.uuid})
         ON CREATE SET k.status = 'pending', k.createdAt = $now, k.decidedAt = null, k.note = null
       SET k.turnUuid = t.uuid, k.sessionId = s.id, k.projectKey = p.key, k.ts = t.ts, k.source = coalesce(s.source, 'claude'), k.run = s.run, k.sandbox = coalesce(s.sandbox, false)
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
       WHERE NOT EXISTS { MATCH (:Candidate {id: t.uuid}) } AND t.ts IS NOT NULL AND NOT coalesce(s.source, 'claude') IN $external
       RETURN t.ts AS ts, t.text AS text, s.id AS sessionId, p.key AS projectKey, s.run AS run`,
      { uuid: turnUuid, external: EXTERNAL_SOURCES },
    );
    if (!turn || Number.isNaN(Date.parse(turn.get('ts')))) return null;
    const t0 = Date.parse(turn.get('ts'));
    const rows = await this.run(
      `MATCH (k:Candidate {projectKey: $key, manual: true})-[:FLAGS]->(mt:Turn)
       WHERE NOT coalesce(k.detected, false) AND k.status <> 'rejected'
         AND coalesce(k.run, '') = coalesce($run, '')
         AND datetime(k.createdAt) >= datetime($from) AND datetime(k.createdAt) <= datetime($to)
       RETURN k, mt`,
      {
        key: turn.get('projectKey'), run: turn.get('run') ?? null,
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
         AND ($projectKeys IS NULL OR k.projectKey IN $projectKeys) AND ($source IS NULL OR coalesce(k.source, 'claude') = $source)
         AND ($author IS NULL OR toLower(t.external) CONTAINS $author OR coalesce(t.text, '') + '\n' + coalesce(t.precedingAssistantText, '') + '\n' + coalesce(t.summary, '') + '\n' + coalesce(k.note, '') + '\n' + coalesce(k.agentReport, '') =~ $authorText)
         AND ($pr IS NULL OR t.external =~ $pr OR coalesce(t.text, '') + '\n' + coalesce(t.precedingAssistantText, '') + '\n' + coalesce(t.summary, '') + '\n' + coalesce(k.note, '') + '\n' + coalesce(k.agentReport, '') =~ $prText)
         AND ${VISIBLE_TO_RUN('k')}
       RETURN k, t ORDER BY t.ts DESC, k.id SKIP $offset LIMIT $limit`,
      { status: f.status ?? null, projectKey: f.projectKey ?? null, projectKeys: f.projectKeys ?? null, source: f.source ?? null, prText: f.pr ? `(?is).*${reviewPatterns(f.pr).pr}.*` : null, authorText: f.author ? `(?is).*${reviewPatterns(undefined, f.author).author}.*` : null,
        author: f.author ? `"author":${JSON.stringify(f.author.toLowerCase())}` : null, pr: f.pr ? `(?s).*"thread":"[^"]*#${f.pr}".*` : null, limit: neo4j.int(f.limit ?? 200), offset: neo4j.int(Math.max(0, Math.floor(f.offset ?? 0))), run: f.run ?? null },
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

  async pendingExternalItems(q: { limit: number; afterId?: string | null }): Promise<PendingExternalItem[]> {
    const rows = await this.run(
      `MATCH (k:Candidate {status: 'pending'})-[:FLAGS]->(t:Turn)
       WHERE t.external IS NOT NULL AND t.text IS NOT NULL AND ($afterId IS NULL OR k.id > $afterId)
       RETURN k.id AS id, t.uuid AS turnUuid, k.projectKey AS projectKey, t.text AS text, t.external AS external
       ORDER BY k.id LIMIT $limit`,
      { limit: neo4j.int(q.limit), afterId: q.afterId ?? null },
    );
    return rows.map((r) => ({ id: r.get('id'), turnUuid: r.get('turnUuid'), projectKey: r.get('projectKey'), text: r.get('text'), external: JSON.parse(r.get('external')) as ExternalRef }));
  }

  async setExternalLinks(turnUuid: string, linkedSessionIds: string[]): Promise<boolean> {
    const [r] = await this.run(`MATCH (t:Turn {uuid: $uuid}) WHERE t.external IS NOT NULL RETURN t.external AS external`, { uuid: turnUuid });
    if (!r) return false;
    const external = { ...(JSON.parse(r.get('external')) as ExternalRef), linkedSessionIds };
    await this.run(`MATCH (t:Turn {uuid: $uuid}) SET t.external = $external`, { uuid: turnUuid, external: JSON.stringify(external) });
    return true;
  }

  async redactStoredCandidates(): Promise<number> {
    let changed = 0;
    for (let after = ''; ;) {
      const rows = await this.run(
        `MATCH (k:Candidate) WHERE k.id > $after WITH k ORDER BY k.id LIMIT $page
         OPTIONAL MATCH (k)-[:FLAGS]->(t:Turn)
         WITH k, head(collect(t)) AS t
         RETURN k.id AS id, k.note AS note, k.agentReport AS agentReport, t.uuid AS uuid,
                t.text AS text, t.precedingAssistantText AS context, t.summary AS summary
         ORDER BY k.id LIMIT $page`,
        { after, page: neo4j.int(REDACT_PAGE) },
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].get('id');
      const page = rows.flatMap((r) => redactStoredRow(
        { id: r.get('id') as string, uuid: r.get('uuid') ?? null, note: r.get('note') ?? null, agentReport: r.get('agentReport') ?? null, text: r.get('text') ?? null, context: r.get('context') ?? null, summary: r.get('summary') ?? null },
        ['note', 'text', 'context', 'summary'], ['agentReport'],
      ) ?? []);
      if (!page.length) continue;
      await this.run(
        `UNWIND $page AS c MATCH (k:Candidate {id: c.id}) SET k.note = c.note, k.agentReport = c.agentReport
         WITH c WHERE c.uuid IS NOT NULL MATCH (t:Turn {uuid: c.uuid})
         SET t.text = c.text, t.precedingAssistantText = c.context, t.summary = c.summary`,
        { page },
      );
      changed += page.length;
    }
    return changed;
  }

  async pendingSessionItems(q: { limit: number; afterId?: string | null }): Promise<PendingSessionItem[]> {
    const rows = await this.run(
      `MATCH (k:Candidate {status: 'pending'})-[:FLAGS]->(t:Turn)
       WHERE t.external IS NULL AND t.text IS NOT NULL AND NOT coalesce(k.manual, false) AND k.agentReport IS NULL
         AND ($afterId IS NULL OR k.id > $afterId)
       RETURN k.id AS id, t.uuid AS turnUuid, k.projectKey AS projectKey, t.text AS text, t.toolCalls AS toolCalls
       ORDER BY k.id LIMIT $limit`,
      { limit: neo4j.int(q.limit), afterId: q.afterId ?? null },
    );
    return rows.map((r) => ({ id: r.get('id'), turnUuid: r.get('turnUuid'), projectKey: r.get('projectKey'), text: r.get('text'), precedingToolCalls: JSON.parse(r.get('toolCalls') ?? '[]') as ToolCall[] }));
  }

  async skipPendingItem(id: string, s: { rule: string; note: string; by: string }): Promise<boolean> {
    const [r] = await this.run(
      `MATCH (k:Candidate {id: $id, status: 'pending'})-[:FLAGS]->(t:Turn)
       SET k.status = 'rejected', k.note = $note, k.decidedAt = $now, k.decidedBy = $by,
           t.signals = CASE WHEN $signal IN coalesce(t.signals, []) THEN t.signals ELSE coalesce(t.signals, []) + $signal END
       RETURN count(k) AS n`,
      { id, note: s.note, by: s.by, signal: `skip:${s.rule}`, now: new Date().toISOString() },
    );
    return Number(r?.get('n') ?? 0) > 0;
  }

  async ruleSkippedItems(q: { rule: string; by: string; limit: number; afterId?: string | null }): Promise<PendingSessionItem[]> {
    const rows = await this.run(
      `MATCH (k:Candidate {status: 'rejected', decidedBy: $by})-[:FLAGS]->(t:Turn)
       WHERE $signal IN coalesce(t.signals, []) AND t.external IS NULL AND t.text IS NOT NULL AND NOT coalesce(k.manual, false)
         AND k.agentReport IS NULL AND ($afterId IS NULL OR k.id > $afterId)
       RETURN k.id AS id, t.uuid AS turnUuid, k.projectKey AS projectKey, t.text AS text, t.toolCalls AS toolCalls
       ORDER BY k.id LIMIT $limit`,
      { by: q.by, signal: `skip:${q.rule}`, limit: neo4j.int(q.limit), afterId: q.afterId ?? null },
    );
    return rows.map((r) => ({ id: r.get('id'), turnUuid: r.get('turnUuid'), projectKey: r.get('projectKey'), text: r.get('text'), precedingToolCalls: JSON.parse(r.get('toolCalls') ?? '[]') as ToolCall[] }));
  }

  async reopenRuleSkippedItem(id: string, s: { rule: string; by: string }): Promise<boolean> {
    const [r] = await this.run(
      `MATCH (k:Candidate {id: $id, status: 'rejected', decidedBy: $by})-[:FLAGS]->(t:Turn)
       SET k.status = 'pending', k.note = null, k.decidedAt = null, k.decidedBy = null,
           t.signals = [x IN coalesce(t.signals, []) WHERE x <> $signal]
       RETURN count(k) AS n`,
      { id, by: s.by, signal: `skip:${s.rule}` },
    );
    return Number(r?.get('n') ?? 0) > 0;
  }

  async decide(id: string, status: 'confirmed' | 'rejected', note: string | null, by = 'you') {
    await this.run(
      `MATCH (k:Candidate {id: $id})-[:FLAGS]->(t:Turn)
       SET k.status = $status, k.note = $note, k.decidedAt = $now, k.decidedBy = $by
       WITH k, t WHERE $status = 'confirmed'
       MERGE (f:Feedback {id: k.id})
         ON CREATE SET f.status = 'open', f.createdAt = $now, f.projectKey = k.projectKey, f.text = t.text
       SET f.status = CASE f.status WHEN 'rejected' THEN 'open' ELSE f.status END, f.run = k.run, f.sandbox = coalesce(k.sandbox, false)
       MERGE (f)-[:FROM_TURN]->(t)`,
      { id, status, note, by, now: new Date().toISOString() },
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
  async pruneTurnText(before: Date, limit = 5000, o: { keepUnsummarized?: boolean } = {}): Promise<number> {
    const [r] = await this.run(
      `MATCH (s:Session)-[:HAS_TURN]->(t:Turn)
       WHERE t.ts < $before AND (t.label IS NOT NULL OR t.index = 0) AND t.text IS NOT NULL
         AND NOT EXISTS { MATCH (s)-[:HAS_TURN]->(:Turn)<-[:FLAGS]-(:Candidate) }
         AND (NOT $keepUnsummarized OR (t.index <= s.summarizedThroughIndex AND NOT coalesce(s.summaryRebuild, false)))
       WITH t LIMIT $limit
       SET t.text = null, t.precedingAssistantText = null, t.toolCalls = '[]', t.prunedAt = $now
       RETURN count(t) AS n`,
      { before: before.toISOString(), limit: neo4j.int(limit), now: new Date().toISOString(), keepUnsummarized: !!o.keepUnsummarized },
    );
    // The agent's final reply goes with the session's turns: once the whole session is older than the cutoff, nothing
    // flagged it, and (keepUnsummarized) a summary covers its last turn.
    await this.run(
      `MATCH (s:Session) WHERE s.finalReplyText IS NOT NULL AND s.lastActivityAt < $before
         AND NOT EXISTS { MATCH (s)-[:HAS_TURN]->(:Turn)<-[:FLAGS]-(:Candidate) }
         AND (NOT $keepUnsummarized OR (s.lastTurnIndex <= s.summarizedThroughIndex AND NOT coalesce(s.summaryRebuild, false)))
       WITH s LIMIT $limit
       SET s.finalReplyText = null, s.finalReplyTs = null`,
      { before: before.toISOString(), limit: neo4j.int(limit), keepUnsummarized: !!o.keepUnsummarized },
    );
    return r?.get('n') ?? 0;
  }

  async upsertExternalThread(project: Project, t: ExternalThread): Promise<number> {
    if (!t.items.length) return 0;
    const items = redactDeep(t.items).map((i) => ({ ...i, external: JSON.stringify(i.external) }));
    const times = t.items.map((i) => i.ts).sort();
    const [r] = await this.run(
      `MERGE (p:Project {key: $project.key}) ON CREATE SET p.name = $project.name, p.repoPath = $project.repoPath
       MERGE (s:Session {id: $id})
         ON CREATE SET s.startedAt = $first, s.manual = true, s.sourceFile = $source, s.source = $source
       SET s.endedAt = CASE WHEN s.endedAt IS NULL OR s.endedAt < $last THEN $last ELSE s.endedAt END
       MERGE (s)-[:IN]->(p)
       WITH s
       UNWIND $items AS i
         OPTIONAL MATCH (old:Turn {uuid: i.uuid})
         WITH s, i, old IS NULL AS isNew
         MERGE (turn:Turn {uuid: i.uuid})
           SET turn.sessionId = $id, turn.ts = i.ts, turn.index = i.index, turn.text = i.text,
               turn.precedingAssistantText = i.context, turn.toolCalls = '[]', turn.external = i.external
         MERGE (s)-[:HAS_TURN]->(turn)
         WITH turn, isNew
         CALL (turn) { MATCH (l:Lesson)-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(turn) SET l.checksVersion = 0 }
       RETURN sum(CASE WHEN isNew THEN 1 ELSE 0 END) AS added`,
      { project: { key: project.key, name: project.name, repoPath: project.repoPath }, id: t.id, source: t.source, first: times[0], last: times.at(-1), items },
    );
    return Number(r?.get('added') ?? 0);
  }

  async workSessions(q: { projectKey: string; branch: string | null; before: string; after?: string | null; limit: number; run?: string | null }): Promise<WorkSession[]> {
    const rows = await this.run(
      `MATCH (p:Project {key: $key})<-[:IN]-(s:Session)
       WHERE (NOT coalesce(s.sandbox, false) OR coalesce(s.run = $run, false)) AND NOT coalesce(s.manual, false) AND s.startedAt IS NOT NULL AND datetime(s.startedAt) <= datetime($before)
         AND coalesce(s.workEdits, 0) + coalesce(s.workCommits, 0) > 0
         AND s.firstWorkAt IS NOT NULL AND datetime(s.firstWorkAt) <= datetime($before)
         AND CASE WHEN $branch IS NULL
               THEN $after IS NOT NULL AND datetime(s.lastWorkAt) >= datetime($after)
               ELSE s.gitBranch = $branch END
       RETURN s ORDER BY s.workEdits DESC, datetime(s.lastWorkAt) DESC, s.id LIMIT $limit`,
      { run: q.run ?? null, key: q.projectKey, branch: q.branch, before: q.before, after: q.after ?? null, limit: neo4j.int(q.limit) },
    );
    return rows.map((r) => {
      const s = r.get('s').properties;
      return {
        id: s.id,
        source: (s.source as SessionSource) ?? 'claude',
        gitBranch: s.gitBranch ?? null,
        cwd: s.cwd ?? null,
        startedAt: s.startedAt ?? null,
        lastActivityAt: s.lastActivityAt ?? s.endedAt ?? null,
        edits: Number(s.workEdits ?? 0),
        commits: Number(s.workCommits ?? 0),
      };
    });
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
      `MATCH (p:Project)<-[:IN]-(s:Session)-[:HAS_TURN]->(t:Turn) WHERE t.index > 0 AND NOT coalesce(s.source, 'claude') IN $external
         // A sandbox run's report is no one else's pushback.
         AND NOT EXISTS { MATCH (k:Candidate)-[:FLAGS]->(t) WHERE k.sandbox = true }
       WITH p.key AS projectKey, date(datetime(t.ts)) AS d, t
       WITH projectKey, toString(d.weekYear) + '-W' + right('0' + toString(d.week), 2) AS week, t
       RETURN projectKey, week, count(t) AS humanTurns,
              sum(CASE WHEN t.label IN $labels THEN 1 ELSE 0 END) AS pushback
       ORDER BY week, projectKey`,
      { labels: CANDIDATE_LABELS, external: EXTERNAL_SOURCES },
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

/** A stored time as the same ISO form the Postgres store returns; null when missing or unreadable. */
function isoOrNull(t: unknown): string | null {
  const ms = typeof t === 'string' ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toTurn(p: Record<string, unknown>): HumanTurn {
  return {
    uuid: p.uuid as string,
    ...(p.run ? { run: p.run as string } : {}),
    ...(p.sandbox ? { sandbox: true as const } : {}),
    sessionId: p.sessionId as string,
    ts: p.ts as string,
    index: p.index as number,
    text: p.text as string,
    precedingAssistantText: (p.precedingAssistantText as string) ?? '',
    precedingToolCalls: JSON.parse((p.toolCalls as string) ?? '[]'),
    ...(p.external ? { external: JSON.parse(p.external as string) as ExternalRef } : {}),
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
    ...(t.external ? { external: JSON.parse(t.external as string) as ExternalRef } : {}),
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
    decidedBy: (k.decidedBy as string) ?? null,
    ...provenance,
    ...(k.run ? { run: k.run as string } : {}),
    ...(k.sandbox === true && { sandbox: true as const }),
  };
}

function projectOf(p: Record<string, unknown>): Project {
  const key = p.key as string;
  return { key, name: (p.name as string) ?? key, repoPath: (p.repoPath as string) ?? '', remote: (p.remote as string) ?? null };
}
