import neo4j from 'neo4j-driver';
import type { Cause } from '../types.ts';
import type { InsightsStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

export type GraphNodeKind = 'feedback' | 'miss' | 'cause' | 'lesson' | 'context' | 'task' | 'commit';
export type GraphNode = { id: string; kind: GraphNodeKind; label: string; status: string | null };
export type GraphLink = { source: string; target: string; type: string };
export type EvidenceGraph = { nodes: GraphNode[]; links: GraphLink[] };

export type RepeatGroup = { cause: Cause; count: number; projects: string[]; examples: string[]; lastSeen: string };
export type PatternReport = {
  causes: { cause: Cause; count: number }[];
  weekly: { week: string; feedback: number; repeats: number }[];
  repeatGroups: RepeatGroup[];
  preDone: { checks: number; withGaps: number; gapsFound: number };
};

/** Two misses at or above this cosine similarity are treated as the same kind of miss. */
export const REPEAT_SIMILARITY = 0.9;

const KIND: Record<string, GraphNodeKind> = {
  Feedback: 'feedback', Miss: 'miss', Cause: 'cause', Lesson: 'lesson', ContextItem: 'context', Task: 'task', Commit: 'commit',
};

/**
 * One node of the evidence graph from its kind and stored fields, named as on the Neo4j nodes: feedback {id, text,
 * status}, miss {id, missed}, cause {key}, lesson {id, title, status}, context {id, kind, ref}, task {id, title},
 * commit {sha, subject}.
 */
export function evidenceNode(kind: GraphNodeKind, p: Record<string, unknown>): GraphNode {
  const short = (s: unknown) => String(s ?? '').slice(0, 140);
  const key = { feedback: p.id, miss: p.id, cause: p.key, lesson: p.id, context: p.id, task: p.id, commit: p.sha }[kind];
  const label = {
    feedback: short(p.text), miss: short(p.missed), cause: String(p.key), lesson: short(p.title),
    context: `${p.kind}: ${p.ref}`, task: short(p.title), commit: short(p.subject),
  }[kind];
  return { id: `${kind}:${key}`, kind, label, status: (p.status as string) ?? null };
}

function toNode(n: { labels: string[]; properties: Record<string, unknown> }): GraphNode {
  return evidenceNode(KIND[n.labels.find((l) => l in KIND)!], n.properties);
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/** ISO week, e.g. 2026-W41, matching GraphRepo.stats(). */
function isoWeek(ts: string): string {
  const d = new Date(ts.slice(0, 10) + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the year
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Misses considered for repeat detection (pairwise, so O(n²)). */
export const REPEAT_WINDOW = 2000;

/** What patterns() reads from the store; patternReport() turns it into the report. */
export type PatternRows = {
  /** Misses per cause, most first, then by cause. */
  causes: { cause: Cause; count: number }[];
  /** The REPEAT_WINDOW most recent misses that have an embedding, oldest first; ts is their feedback turn's. */
  misses: { missed: string; cause: Cause; projectKey: string; embedding: number[]; ts: string }[];
  /** The turn timestamp of every feedback. */
  feedbackTs: string[];
  preDone: PatternReport['preDone'];
};

/** Repeat groups and the weekly series, from the rows any backend reads. */
export function patternReport(rows: PatternRows, threshold = REPEAT_SIMILARITY): PatternReport {
  // Misses arrive in time order, so each one is a repeat when it matches any earlier miss.
  const misses = rows.misses;
  const groupOf: number[] = [];
  const groups: (typeof misses)[] = [];
  misses.forEach((m, i) => {
    const earlier = misses.slice(0, i).findIndex((e) => cosine(e.embedding, m.embedding) >= threshold);
    if (earlier < 0) {
      groupOf[i] = groups.push([m]) - 1;
    } else {
      groupOf[i] = groupOf[earlier];
      groups[groupOf[i]].push(m);
    }
  });

  const weekly = new Map<string, { feedback: number; repeats: number }>();
  const bump = (ts: string, k: 'feedback' | 'repeats') => {
    const w = isoWeek(ts);
    const row = weekly.get(w) ?? { feedback: 0, repeats: 0 };
    row[k]++;
    weekly.set(w, row);
  };
  for (const ts of rows.feedbackTs) bump(ts, 'feedback');
  for (const g of groups) for (const m of g.slice(1)) bump(m.ts, 'repeats');

  return {
    causes: rows.causes,
    weekly: [...weekly].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v })),
    repeatGroups: groups
      .filter((g) => g.length > 1)
      .map((g) => ({
        cause: g[0].cause,
        count: g.length,
        projects: [...new Set(g.map((m) => m.projectKey))].sort(),
        examples: g.map((m) => m.missed),
        lastSeen: g[g.length - 1].ts,
      }))
      .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)),
    preDone: rows.preDone,
  };
}

export class InsightsRepo implements InsightsStore {
  readonly g: GraphRepo;

  constructor(g: GraphRepo) {
    this.g = g;
  }

  /** Evidence chains for the most recent misses in a project: feedback, miss, cause, lesson, context, task, fix commits. */
  async projectGraph(projectKey: string, limit = 150): Promise<EvidenceGraph> {
    const rows = await this.g.run(
      `MATCH (m:Miss {projectKey: $projectKey})-[:EXPLAINS]->(f:Feedback) WHERE NOT coalesce(m.sandbox, false)
       WITH m, f ORDER BY m.createdAt DESC LIMIT $limit
       CALL (m, f) {
         MATCH (m)-[r:EXPLAINS]->(f) RETURN r, m AS a, f AS b
         UNION MATCH (m)-[r:CAUSED_BY]->(x:Cause) RETURN r, m AS a, x AS b
         UNION MATCH (x:Lesson)-[r:DERIVED_FROM]->(m) WHERE NOT coalesce(x.sandbox, false) RETURN r, x AS a, m AS b
         UNION MATCH (x:ContextItem)-[r:WOULD_HAVE_PREVENTED]->(m) RETURN r, x AS a, m AS b
         UNION MATCH (f)-[r:CRITICIZES]->(x:Task) RETURN r, f AS a, x AS b
         UNION MATCH (x:Commit)-[r:ADDRESSES]->(f) RETURN r, x AS a, f AS b
       }
       RETURN type(r) AS type, a, b`,
      { projectKey, limit: neo4j.int(limit) },
    );
    const nodes = new Map<string, GraphNode>();
    const links: GraphLink[] = [];
    for (const r of rows) {
      const a = toNode(r.get('a'));
      const b = toNode(r.get('b'));
      nodes.set(a.id, a);
      nodes.set(b.id, b);
      links.push({ source: a.id, target: b.id, type: r.get('type') });
    }
    return { nodes: [...nodes.values()], links };
  }

  async patterns(q: { projectKey?: string; projectKeys?: string[]; threshold?: number }): Promise<PatternReport> {
    const projectKey = q.projectKey ?? null;
    const projectKeys = q.projectKeys ?? null;
    const [causeRows, missRows, feedbackRows, [pre]] = await Promise.all([
      this.g.run(
        `MATCH (m:Miss) WHERE ($projectKey IS NULL OR m.projectKey = $projectKey) AND ($projectKeys IS NULL OR m.projectKey IN $projectKeys)
           AND NOT coalesce(m.sandbox, false)
         RETURN m.cause AS cause, count(*) AS count ORDER BY count DESC, cause`,
        { projectKey, projectKeys },
      ),
      this.g.run(
        `MATCH (m:Miss)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(t:Turn)
         WHERE ($projectKey IS NULL OR m.projectKey = $projectKey) AND ($projectKeys IS NULL OR m.projectKey IN $projectKeys) AND m.embedding IS NOT NULL
           AND NOT coalesce(m.sandbox, false)
         // Repeat detection compares every pair, so only the most recent misses are loaded.
         WITH m, t ORDER BY t.ts DESC LIMIT $cap
         RETURN m.missed AS missed, m.cause AS cause, m.projectKey AS projectKey, m.embedding AS embedding, t.ts AS ts
         ORDER BY ts`,
        { projectKey, projectKeys, cap: neo4j.int(REPEAT_WINDOW) },
      ),
      this.g.run(
        `MATCH (f:Feedback)-[:FROM_TURN]->(t:Turn) WHERE ($projectKey IS NULL OR f.projectKey = $projectKey) AND ($projectKeys IS NULL OR f.projectKey IN $projectKeys)
           AND NOT EXISTS { MATCH (k:Candidate {id: f.id}) WHERE k.sandbox = true }
         RETURN t.ts AS ts`,
        { projectKey, projectKeys },
      ),
      this.g.run(
        `MATCH (x:PreDoneCheck) WHERE ($projectKey IS NULL OR x.projectKey = $projectKey) AND ($projectKeys IS NULL OR x.projectKey IN $projectKeys)
           AND NOT coalesce(x.sandbox, false) AND coalesce(x.status, 'lesson_judged') = 'lesson_judged'
         RETURN count(x) AS checks, sum(CASE WHEN x.gaps > 0 THEN 1 ELSE 0 END) AS withGaps, coalesce(sum(x.gaps), 0) AS gapsFound`,
        { projectKey, projectKeys },
      ),
    ]);

    return patternReport(
      {
        causes: causeRows.map((r) => ({ cause: r.get('cause'), count: r.get('count') })),
        misses: missRows.map((r) => ({
          missed: r.get('missed') as string, cause: r.get('cause') as Cause, projectKey: r.get('projectKey') as string,
          embedding: r.get('embedding') as number[], ts: r.get('ts') as string,
        })),
        feedbackTs: feedbackRows.map((r) => r.get('ts') as string),
        preDone: { checks: pre.get('checks'), withGaps: pre.get('withGaps'), gapsFound: pre.get('gapsFound') },
      },
      q.threshold ?? REPEAT_SIMILARITY,
    );
  }
}
