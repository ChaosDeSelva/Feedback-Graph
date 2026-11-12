import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActivityRepo } from '../graph/activity.ts';
import { GraphRepo } from '../graph/repo.ts';
import { neo4jStore } from '../graph/neo4j-store.ts';
import type { Store } from '../store.ts';
import type { EmbeddedSeed, PreDoneCheckRow, ProbeKind, StaleTextSeed, StoreProbe } from './probe.ts';

const IDENTITY: Partial<Record<ProbeKind, string>> = { Project: 'key', Cause: 'key', SyncCursor: 'key', Turn: 'uuid', Commit: 'sha' };
const label = (kind: ProbeKind) => `\`${kind}\``;
/** The stale decision seedStaleText writes (both probes): its before-snapshot holds the text in a lesson's rule. */
export const staleSnapshot = (text: string) => [{ kind: 'lesson', id: 'lesson:stale', fields: { rule: text }, fingerprint: 'f'.repeat(64) }];
export const STALE_CONFIDENCE = { p: 0.5, lower: 0.1, n: 0, band: 2 };

export class Neo4jProbe implements StoreProbe {
  readonly g: GraphRepo;
  /** The store's background work (the Activity target upgrade ensureSchema starts), settled before a wipe. */
  readonly settle: () => Promise<unknown>;
  constructor(g: GraphRepo, settle: () => Promise<unknown> = async () => {}) {
    this.g = g;
    this.settle = settle;
  }

  async wipe() {
    // A wipe beside the upgrade's pages deadlocks on the nodes both touch.
    await this.settle();
    return this.g.wipeForTests();
  }

  async work(fn: () => Promise<unknown>): Promise<number> {
    const g = this.g;
    const run = g.run;
    let hits = 0;
    const sum = (p: { dbHits: number; children: unknown[] }): number => p.dbHits + p.children.reduce<number>((n, c) => n + sum(c as typeof p), 0);
    // Plans for the data as it is now. A plan cached while a label held a few nodes (an earlier test's) may scan it, as
    // may one made from an index sample taken then: Neo4j resamples and replans only after a while of its own.
    await g.run('CALL db.resampleOutdatedIndexes()');
    await g.run('CALL db.awaitIndexes(300)');
    await g.run('CALL db.clearQueryCaches()');
    // Only fn's own queries: a background task of the store (the Activity target upgrade) runs outside its context.
    const mine = new AsyncLocalStorage<true>();
    g.run = async (cypher, params = {}) => {
      if (!mine.getStore()) return run.call(g, cypher, params);
      const session = g.driver.session();
      try {
        const r = await session.run(`PROFILE ${cypher}`, params);
        hits += r.summary.profile ? sum(r.summary.profile as never) : 0;
        return r.records;
      } finally {
        await session.close();
      }
    };
    try {
      await mine.run(true, fn);
    } finally {
      g.run = run;
    }
    return hits;
  }

  async count(kind: ProbeKind): Promise<number> {
    return this.g.count(kind);
  }

  async ids(kind: ProbeKind): Promise<string[]> {
    const rows = await this.g.run(`MATCH (n:${label(kind)}) RETURN n.${IDENTITY[kind] ?? 'id'} AS id ORDER BY id`);
    return rows.map((r) => r.get('id'));
  }

  async rows(kind: ProbeKind): Promise<Record<string, unknown>[]> {
    const rows = await this.g.run(`MATCH (n:${label(kind)}) RETURN properties(n) AS p`);
    return rows.map((r) => {
      const { embedding: _, ...rest } = r.get('p');
      return rest;
    });
  }

  async project(key: string) {
    const [r] = await this.g.run('MATCH (p:Project {key: $key}) RETURN p.key AS key, p.remote AS remote, p.aliases AS aliases, p.repoPath AS repoPath', { key });
    return r ? { key: r.get('key'), remote: r.get('remote') ?? null, aliases: r.get('aliases') ?? [], repoPath: r.get('repoPath') ?? null } : null;
  }

  async sessionSource(id: string): Promise<string | null> {
    const [r] = await this.g.run('MATCH (s:Session {id: $id}) RETURN s.source AS source', { id });
    return r?.get('source') ?? null;
  }

  async turn(uuid: string) {
    const [r] = await this.g.run('MATCH (t:Turn {uuid: $uuid}) RETURN t.text AS text, t.precedingAssistantText AS before', { uuid });
    return r ? { text: r.get('text') ?? null, precedingAssistantText: r.get('before') ?? null } : null;
  }

  async feedbackStatus(id: string): Promise<string | null> {
    const [r] = await this.g.run('MATCH (f:Feedback {id: $id}) RETURN f.status AS s', { id });
    return r?.get('s') ?? null;
  }

  async factVersions(statement: string) {
    const rows = await this.g.run(
      'MATCH (x:Fact {statement: $statement}) RETURN x.current AS current, x.validTo IS NOT NULL AS closed ORDER BY x.createdAt',
      { statement },
    );
    return rows.map((r) => ({ current: r.get('current') === true, closed: r.get('closed') }));
  }

  async preDoneChecks(): Promise<PreDoneCheckRow[]> {
    const rows = await this.g.run(
      `MATCH (x:PreDoneCheck)
       OPTIONAL MATCH (x)-[c:CHECKED]->(l:Lesson)
       WITH x, l, c ORDER BY l.id
       RETURN x, [i IN collect({lessonId: l.id, gap: c.gap}) WHERE i.lessonId IS NOT NULL] AS lessons
       ORDER BY x.ts`,
    );
    return rows.map((r) => {
      const x = r.get('x').properties;
      return { projectKey: x.projectKey, task: x.task, checked: x.checked, gaps: x.gaps, lessons: r.get('lessons'), ...(x.sessionId ? { sessionId: x.sessionId } : {}) };
    });
  }

  async filedUnder(key: string): Promise<ProbeKind[]> {
    const rows = await this.g.run(
      `MATCH (n) WHERE n.projectKey = $key OR n.originProjectKey = $key OR (n:Project AND n.key = $key)
       RETURN DISTINCT labels(n)[0] AS kind ORDER BY kind`,
      { key },
    );
    return rows.map((r) => r.get('kind'));
  }

  async embeddings(): Promise<Record<string, number[] | null>> {
    const rows = await this.g.run(
      'MATCH (n) WHERE (n:Lesson OR n:Miss OR n:Fact OR n:Chunk) AND n.id IS NOT NULL RETURN n.id AS id, n.embedding AS v ORDER BY id',
    );
    return Object.fromEntries(rows.map((r) => [r.get('id'), r.get('v') ?? null]));
  }

  async setProject(key: string, fields: { remote?: string | null; aliases?: string[] }) {
    await this.g.run('MATCH (p:Project {key: $key}) SET p += $fields', { key, fields });
  }

  async setLessonCreatedAt(ids: string[], at: string) {
    await this.g.run('MATCH (l:Lesson) WHERE l.id IN $ids SET l.createdAt = $at', { ids, at });
  }

  async setDecisionCreatedAt(ids: string[], at: string) {
    await this.g.run('MATCH (d:Decision) WHERE d.id IN $ids SET d.createdAt = $at', { ids, at });
  }

  async seedOrphan(row: { kind: 'Lesson' | 'Doc'; id: string; projectKey: string }) {
    const extra = row.kind === 'Lesson' ? ", status: 'approved'" : '';
    await this.g.run(`CREATE (:${row.kind} {id: $id, projectKey: $projectKey${extra}})`, { id: row.id, projectKey: row.projectKey });
  }

  async seedEmbedded(row: EmbeddedSeed) {
    const { kind, ...props } = row;
    await this.g.run(`CREATE (n:${label(kind)}) SET n = $props`, { props });
  }

  async seedOwnerMark(lessonId: string) {
    await this.g.run('MATCH (l:Lesson {id: $id}) SET l.decidedByYou = true', { id: lessonId });
  }

  async seedStaleText(row: StaleTextSeed) {
    const now = new Date().toISOString();
    switch (row.kind) {
      case 'InboxItem':
        await this.g.run(
          `CREATE (s:Session {id: $id, projectKey: '__probe__'})
           CREATE (t:Turn {uuid: $id, sessionId: $id, index: 1, ts: $now, text: $r.text, precedingAssistantText: $r.context, summary: $r.summary})
           CREATE (s)-[:HAS_TURN]->(t)
           CREATE (k:Candidate {id: $id, status: 'pending', projectKey: '__probe__', createdAt: $now, note: $r.note, agentReport: $report})-[:FLAGS]->(t)
           CREATE (:Feedback {id: $id, status: 'open', projectKey: '__probe__', createdAt: $now, text: $r.feedbackText})
           CREATE (:Miss {id: 'miss:' + $id, projectKey: '__probe__', missed: $r.missed, causeExplanation: $r.causeExplanation})`,
          { id: row.id, now, r: row, report: row.agentReport ? JSON.stringify(row.agentReport) : null },
        );
        return;
      case 'Session':
        await this.g.run('CREATE (:Session {id: $id, projectKey: $p, summaryJson: $summary, finalReplyText: $reply})', { id: row.id, p: '__probe__', summary: JSON.stringify(row.summary), reply: row.finalReply });
        return;
      case 'Activity':
        await this.g.run(
          `CREATE (:Activity {id: $id, ts: $now, order: 0.0, kind: 'doc_added', actor: 'probe', projectKey: null, subject: $subject, why: $why, details: $details, targets: []})`,
          { id: row.id, now, subject: row.subject, why: row.why, details: JSON.stringify(row.details) },
        );
        return;
      case 'ChatTurns':
        await this.g.run(
          `CREATE (:ChatConversation {id: $id, projectKey: '__probe__', title: 't', provider: null, nextSeq: 3, createdAt: $now, updatedAt: $now})
           CREATE (:ChatTurn {id: $id + ':q', conversationId: $id, projectKey: '__probe__', seq: 1, role: 'user', text: $r.question, status: 'done',
                              error: null, answer: null, sources: '[]', provider: null, context: $r.context, createdAt: $now, startedAt: null, finishedAt: $now})
           CREATE (:ChatTurn {id: $id + ':a', conversationId: $id, projectKey: '__probe__', seq: 2, role: 'assistant', text: '', status: 'pending',
                              error: null, answer: $answer, sources: $sources, provider: null, createdAt: $now, startedAt: null, finishedAt: null})`,
          { id: row.id, now, r: row, answer: JSON.stringify(row.answer), sources: JSON.stringify(row.sources) },
        );
        return;
      case 'Decision':
        await this.g.run(
          `CREATE (d:Decision {id: $id, type: 'link_misses', status: 'proposed', tier: 'H', mode: 'propose', targets: '[]', targetIds: [],
                               before: $before, after: '[]', evidence: '[]', features: '{}', score: 0.5, confidence: $confidence, band: 2,
                               rationale: $text, model: 'deterministic', policyVersion: 1, dependsOn: [], createdAt: $now})
           CREATE (:DecisionNote {id: $id + ':note', decisionId: $id, ts: $now, by: 'you', text: $note})-[:ON]->(d)`,
          { id: row.id, now, text: row.text, note: row.note, before: JSON.stringify(staleSnapshot(row.text)), confidence: JSON.stringify(STALE_CONFIDENCE) },
        );
        return;
    }
  }
}

/** The Neo4j test database: NEO4J_TEST_URL (default: docker-compose.test.yml's neo4j-test). Never the real stack. */
export async function openNeo4jTestStore(): Promise<{ store: Store; probe: StoreProbe }> {
  const url = process.env.NEO4J_TEST_URL ?? 'bolt://127.0.0.1:7688';
  const g = await GraphRepo.connect(url, process.env.NEO4J_TEST_USER ?? 'neo4j', process.env.NEO4J_TEST_PASSWORD ?? 'testpassword');
  const store = neo4jStore(g);
  await store.ensureSchema();
  return { store, probe: new Neo4jProbe(g, () => (store.activity as ActivityRepo).targets!.settled()) };
}
