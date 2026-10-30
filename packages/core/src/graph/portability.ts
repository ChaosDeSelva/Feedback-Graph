import { purgeRedactionOriginals } from '../redactionArchive.ts';
import neo4j from 'neo4j-driver';
import { VERSION } from '../config.ts';
import type { Cause, Lesson } from '../types.ts';
import type { Hotspot } from '../codegraph.ts';
import { DEMO_SOURCE, type PortabilityStore } from '../store.ts';
import { CodeGraphRepo } from './codegraph.ts';
import type { GraphRepo } from './repo.ts';

export const EXPORT_FORMAT = 'feedback-graph-export';

/**
 * The derived knowledge of one project (or all), with no raw transcripts and no vectors (the receiver re-embeds
 * with its own model). This is the shape a team sync would send; schemaVersion bumps on any breaking change.
 * Added fields are not breaking: a reader must ignore what it does not know, and treat a missing `projects` as [].
 */
export type ExportBundle = {
  format: typeof EXPORT_FORMAT;
  schemaVersion: 1;
  toolVersion: string;
  exportedAt: string;
  projectKey: string | null;
  /** remote = normalizeRemote(origin): the id that matches one repo across differently named folders and machines. */
  projects: { key: string; remote: string | null; /** Created exclusively for a demo fixture, not inferred from its name. */ demoCreated?: true }[];
  lessons: Lesson[];
  misses: {
    id: string;
    projectKey: string;
    missed: string;
    cause: Cause;
    causeExplanation: string;
    feedbackText: string;
    ts: string;
    contextItems: { kind: string; ref: string; excerpt: string; why: string }[];
  }[];
  facts: { path: string; lines: string | null; kind: string; statement: string; why: string; confidence: number; source: string; createdAt: string; projectKey: string }[];
  docs: { id: string; projectKey: string; source: string; ref: string; title: string; url: string | null }[];
  /** The code map's files with their hotspot numbers: paths and stats only, never source, symbols or edges. */
  codeFiles: ExportCodeFile[];
};

export type ExportCodeFile = { projectKey: string; path: string; lang: string; loc: number; isTest: boolean } & Omit<Hotspot, 'path'>;

/** Labels whose nodes belong to one project through their projectKey. */
const PROJECT_LABELS = ['Candidate', 'Feedback', 'Miss', 'Task', 'ContextItem', 'Fact', 'Symbol', 'Module', 'CodeMap', 'CodeFile', 'ScanJob', 'Doc', 'DocBlob', 'Chunk', 'Activity', 'PreDoneCheck', 'ChatTurn', 'ChatConversation'];

const BATCH = 5000;

export class PortabilityRepo implements PortabilityStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async restorePrivateProject(project: { key: string; remote: string | null }): Promise<void> {
    await this.g.run("MERGE (p:Project {key: $key}) ON CREATE SET p.name = $key, p.repoPath = '', p.remote = $remote, p.demoCreated = true", project);
  }

  async exportData(o: { projectKey?: string; projectKeys?: string[]; approvedOnly?: boolean } = {}): Promise<ExportBundle> {
    const key = o.projectKey ?? null;
    // null: no list to apply (one project by key, or everything).
    const keys = key === null && o.projectKeys ? o.projectKeys : null;
    const [projects, lessons, misses, facts, docs] = await Promise.all([
      this.g.run(`MATCH (p:Project) WHERE ($key IS NULL OR p.key = $key) AND ($keys IS NULL OR p.key IN $keys) RETURN p.key AS key, p.remote AS remote, p.demoCreated AS demoCreated ORDER BY p.key`, { key, keys }),
      this.g.run(
        `MATCH (l:Lesson)
         WHERE ($key IS NULL OR l.projectKey = $key OR (l.projectKey IS NULL AND l.originProjectKey = $key))
           AND ($keys IS NULL OR coalesce(l.projectKey, l.originProjectKey) IS NULL OR coalesce(l.projectKey, l.originProjectKey) IN $keys)
           AND (NOT $approvedOnly OR l.status = 'approved') AND NOT coalesce(l.sandbox, false) AND coalesce(l.source, '') <> $demo
         RETURN l ORDER BY l.createdAt, l.id`,
        { key, keys, approvedOnly: !!o.approvedOnly, demo: DEMO_SOURCE },
      ),
      this.g.run(
        `MATCH (m:Miss)-[:EXPLAINS]->(f:Feedback)
         WHERE ($key IS NULL OR m.projectKey = $key) AND ($keys IS NULL OR m.projectKey IN $keys) AND NOT coalesce(m.sandbox, false)
           AND NOT m.id STARTS WITH 'miss:demo:'
         OPTIONAL MATCH (ci:ContextItem)-[w:WOULD_HAVE_PREVENTED]->(m)
         WITH m, f, ci, w ORDER BY ci.ref, ci.id
         RETURN m, f.text AS feedbackText, f.createdAt AS ts,
                [x IN collect({kind: ci.kind, ref: ci.ref, excerpt: ci.excerpt, why: w.why}) WHERE x.ref IS NOT NULL] AS items
         ORDER BY ts, m.id`,
        { key, keys },
      ),
      this.g.run(
        `MATCH (x:Fact {current: true}) WHERE ($key IS NULL OR x.projectKey = $key) AND ($keys IS NULL OR x.projectKey IN $keys) AND x.docId IS NULL AND NOT coalesce(x.sandbox, false)
           AND coalesce(x.source, '') <> $demo
         RETURN x ORDER BY x.projectKey, x.path, x.statement, x.id`,
        { key, keys, demo: DEMO_SOURCE },
      ),
      this.g.run(`MATCH (d:Doc) WHERE ($key IS NULL OR d.projectKey = $key) AND ($keys IS NULL OR d.projectKey IN $keys) AND NOT coalesce(d.sandbox, false) RETURN d ORDER BY d.projectKey, d.id`, { key, keys }),
    ]);
    const codegraph = new CodeGraphRepo(this.g);
    const codeFiles = (await Promise.all(projects.map((r) => codegraph.exportFiles(r.get('key') as string)))).flat();
    const props = (r: { get(k: string): { properties: Record<string, unknown> } }, k: string) => r.get(k).properties;
    return {
      format: EXPORT_FORMAT,
      schemaVersion: 1,
      toolVersion: VERSION,
      exportedAt: new Date().toISOString(),
      projectKey: key,
      projects: projects.map((r) => ({ key: r.get('key') as string, remote: (r.get('remote') as string) ?? null, ...(r.get('demoCreated') === true ? { demoCreated: true as const } : {}) })),
      lessons: lessons.map((r) => {
        const l = props(r, 'l');
        return {
          id: l.id as string,
          projectKey: (l.projectKey as string) ?? null,
          title: l.title as string,
          rule: l.rule as string,
          appliesWhen: (l.appliesWhen as string) ?? '',
          scope: l.scope as Lesson['scope'],
          paths: (l.paths as string[]) ?? [],
          status: l.status as Lesson['status'],
          source: l.source as Lesson['source'],
          cause: (l.cause as Cause) ?? null,
          missId: (l.missId as string) ?? null,
          createdAt: l.createdAt as string,
          decidedAt: (l.decidedAt as string) ?? null,
          ...(typeof l.checks === 'string' && { checks: JSON.parse(l.checks) as NonNullable<Lesson['checks']> }),
        };
      }),
      misses: misses.map((r) => {
        const m = props(r, 'm');
        return {
          id: m.id as string,
          projectKey: m.projectKey as string,
          missed: m.missed as string,
          cause: m.cause as Cause,
          causeExplanation: (m.causeExplanation as string) ?? '',
          feedbackText: (r.get('feedbackText') as string) ?? '',
          ts: (r.get('ts') as string) ?? '',
          contextItems: r.get('items') as ExportBundle['misses'][number]['contextItems'],
        };
      }),
      facts: facts.map((r) => {
        const f = props(r, 'x');
        return {
          path: f.path as string,
          lines: (f.lines as string) ?? null,
          kind: f.kind as string,
          statement: f.statement as string,
          why: (f.why as string) ?? '',
          confidence: f.confidence as number,
          source: f.source as string,
          createdAt: f.createdAt as string,
          projectKey: f.projectKey as string,
        };
      }),
      docs: docs.map((r) => {
        const d = props(r, 'd');
        return { id: d.id as string, projectKey: d.projectKey as string, source: d.source as string, ref: d.ref as string, title: d.title as string, url: (d.url as string) ?? null };
      }),
      codeFiles,
    };
  }

  /** Remove a project and everything learned from it. Returns how many nodes were deleted. */
  async deleteProject(key: string): Promise<number> {
    const archiveRows = await this.g.run(`
      MATCH (n:Fact {projectKey: $key}) RETURN n.id AS id, 'fact' AS kind
      UNION ALL MATCH (n:Doc {projectKey: $key}) RETURN n.id AS id, 'doc' AS kind
      UNION ALL MATCH (n:Chunk {projectKey: $key}) RETURN n.id AS id, 'chunk' AS kind
      UNION ALL MATCH (n:Lesson) WHERE n.projectKey = $key OR n.originProjectKey = $key RETURN n.id AS id, 'lesson' AS kind
      UNION ALL MATCH (n:Feedback {projectKey: $key}) RETURN n.id AS id, 'feedback' AS kind`, { key });
    const archiveSelectors = [{ kind: 'project', id: key }, ...archiveRows.map(row => ({ kind: String(row.get('kind')), id: String(row.get('id')) }))];
    let removed = 0;
    // Batched so a project with years of history does not need one giant transaction.
    const drain = async (cypher: string) => {
      for (;;) {
        const [r] = await this.g.run(cypher, { key, batch: neo4j.int(BATCH) });
        const n = Number(r?.get('n') ?? 0);
        removed += n;
        if (n < BATCH) return;
      }
    };
    await drain(`MATCH (:Project {key: $key})<-[:IN]-(:Session)-[:HAS_TURN]->(t:Turn) WITH t LIMIT $batch DETACH DELETE t RETURN count(*) AS n`);
    // Commits only this project's sessions saw.
    await drain(
      `MATCH (:Project {key: $key})<-[:IN]-(:Session)-[:DURING]->(c:Commit)
       WHERE NOT EXISTS { MATCH (c)<-[:DURING]-(:Session)-[:IN]->(o:Project) WHERE o.key <> $key }
       WITH DISTINCT c LIMIT $batch DETACH DELETE c RETURN count(*) AS n`,
    );
    // Registry entries have no Session FK: claims can predate ingestion. Remove the owned bindings before sessions.
    await drain(`MATCH (b:SessionRun) WHERE b.projectKey = $key OR EXISTS { MATCH (:Project {key: $key})<-[:IN]-(s:Session) WHERE s.id = b.sessionId }
      WITH b LIMIT $batch DETACH DELETE b RETURN count(*) AS n`);
    await drain(`MATCH (:Project {key: $key})<-[:IN]-(s:Session) WITH s LIMIT $batch DETACH DELETE s RETURN count(*) AS n`);
    await drain(`MATCH (l:Lesson) WHERE l.projectKey = $key OR l.originProjectKey = $key WITH l LIMIT $batch DETACH DELETE l RETURN count(*) AS n`);
    for (const label of PROJECT_LABELS) {
      await drain(`MATCH (n:${label} {projectKey: $key}) WITH n LIMIT $batch DETACH DELETE n RETURN count(*) AS n`);
    }
    await drain(`MATCH (c:SyncCursor) WHERE c.key ENDS WITH ':' + $key WITH c LIMIT $batch DETACH DELETE c RETURN count(*) AS n`);
    await drain(`MATCH (l:ProjectLink) WHERE l.a = $key OR l.b = $key WITH l LIMIT $batch DETACH DELETE l RETURN count(*) AS n`);
    await drain(`MATCH (p:Project {key: $key}) DETACH DELETE p RETURN count(*) AS n`);
    await purgeRedactionOriginals(archiveSelectors);
    return removed;
  }
}
