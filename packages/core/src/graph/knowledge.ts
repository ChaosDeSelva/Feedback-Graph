import { createHash, randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import type {
  Cause,
  Commit,
  ContextItem,
  FeedbackStatus,
  HumanTurn,
  Lesson,
  LessonScope,
  LessonStatus,
  Outcome,
  PostMortem,
  PostMortemInput,
  Project,
} from '../types.ts';
import { redactDeep, redactSecrets } from '../redact.ts';
import type { KnowledgeStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';
import { matchReport, REPORT_MERGE_MINUTES } from '../dedupe.ts';

export const MAX_POSTMORTEM_ATTEMPTS = 5;
/** Wait 5, 10, 20, 40 minutes between attempts, so a short outage does not use them all up. */
const BACKOFF_MINUTES = 5;

/** The status a feedback gets from its post-mortem's outcome. */
export const OUTCOME_STATUS: Record<Outcome, FeedbackStatus> = {
  approved: 'approved',
  addressed: 'addressed',
  unresolved: 'open',
  unknown: 'unknown',
};

export type LessonDetail = {
  lesson: Lesson;
  miss: { id: string; missed: string; cause: Cause; causeExplanation: string } | null;
  feedback: { id: string; text: string; status: FeedbackStatus; sessionId: string; ts: string } | null;
  contextItems: ContextItem[];
  fixCommits: Commit[];
  supersedes: string[];
};

export type LessonPatch = Partial<Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope' | 'paths'>> & {
  status?: LessonStatus;
  supersedes?: string;
};

export type LessonHit = { lesson: Lesson; score: number };

export type RelatedMiss = {
  missId: string;
  missed: string;
  cause: Cause;
  feedbackText: string;
  sessionId: string;
  ts: string;
  score: number;
};

export type LessonInput = {
  id: string;
  projectKey: string | null;
  title: string;
  rule: string;
  appliesWhen: string;
  scope: LessonScope;
  paths: string[];
  status: LessonStatus;
  source: Lesson['source'];
  embedding: number[];
};

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** A post-mortem's context item id: one per feedback, kind and ref, so re-saving a post-mortem updates it in place. */
export const contextItemId = (feedbackId: string, kind: string, ref: string) => `ctx:${sha(`${feedbackId}|${kind}|${ref}`)}`;

/** When a post-mortem that has now failed `attempts` times is due again, or null when it has given up. */
export function postmortemRetryAt(attempts: number, now: Date): string | null {
  return attempts >= MAX_POSTMORTEM_ATTEMPTS ? null : new Date(now.getTime() + BACKOFF_MINUTES * 2 ** (attempts - 1) * 60_000).toISOString();
}

export class KnowledgeRepo implements KnowledgeStore {
  readonly g: GraphRepo;

  constructor(g: GraphRepo) {
    this.g = g;
  }

  async postmortemBacklog(): Promise<number> {
    const [r] = await this.g.run(
      `MATCH (f:Feedback)-[:FROM_TURN]->(:Turn)<-[:HAS_TURN]-(:Session)-[:IN]->(:Project)
       WHERE NOT (f)<-[:EXPLAINS]-(:Miss) AND f.status <> 'rejected' AND coalesce(f.attempts, 0) < $max
       RETURN count(DISTINCT f) AS n`,
      { max: MAX_POSTMORTEM_ATTEMPTS },
    );
    return Number(r.get('n'));
  }

  async feedbackNeedingPostmortem(limit: number, now = new Date()): Promise<PostMortemInput[]> {
    const rows = await this.g.run(
      `MATCH (f:Feedback)-[:FROM_TURN]->(t:Turn)<-[:HAS_TURN]-(s:Session)-[:IN]->(p:Project)
       WHERE NOT (f)<-[:EXPLAINS]-(:Miss) AND f.status <> 'rejected' AND coalesce(f.attempts, 0) < $max AND coalesce(f.retryAt, '') <= $now
       OPTIONAL MATCH (k:Candidate {id: f.id})
       WITH f, t, s, p, k ORDER BY f.createdAt LIMIT $limit
       MATCH (s)-[:HAS_TURN]->(st:Turn)
       WITH f, t, s, p, k, st ORDER BY st.index
       RETURN f.id AS id, t, s, p, k.note AS note, collect(st) AS turns`,
      { max: MAX_POSTMORTEM_ATTEMPTS, limit: neo4j.int(limit), now: now.toISOString() },
    );
    return rows.map((r) => ({
      feedbackId: r.get('id'),
      projectKey: r.get('p').properties.key,
      repoPath: r.get('p').properties.repoPath,
      cwd: r.get('s').properties.cwd ?? '',
      sessionId: r.get('s').properties.id,
      source: r.get('s').properties.source ?? 'claude',
      feedback: turnOf(r.get('t').properties),
      turns: (r.get('turns') as { properties: Record<string, unknown> }[]).map((n) => turnOf(n.properties)),
      note: r.get('note') ?? null,
    }));
  }

  /** Returns when the next attempt is due, or null when it has given up. */
  async recordPostmortemFailure(feedbackId: string, error: string, now = new Date()): Promise<{ attempts: number; retryAt: string | null }> {
    const [r] = await this.g.run(
      `MATCH (f:Feedback {id: $id}) SET f.attempts = coalesce(f.attempts, 0) + 1, f.lastError = $error RETURN f.attempts AS attempts`,
      { id: feedbackId, error: redactSecrets(error).slice(0, 2000) },
    );
    const attempts: number = r?.get('attempts') ?? MAX_POSTMORTEM_ATTEMPTS;
    const retryAt = postmortemRetryAt(attempts, now);
    await this.g.run('MATCH (f:Feedback {id: $id}) SET f.retryAt = $retryAt', { id: feedbackId, retryAt });
    return { attempts, retryAt };
  }

  /** Start a given-up (or waiting) post-mortem again now. */
  async retryPostmortem(feedbackId: string): Promise<boolean> {
    const [r] = await this.g.run(
      `MATCH (f:Feedback {id: $id}) WHERE NOT (f)<-[:EXPLAINS]-(:Miss) SET f.attempts = 0, f.retryAt = null RETURN count(f) AS n`,
      { id: feedbackId },
    );
    return (r?.get('n') ?? 0) > 0;
  }

  async savePostmortem(feedbackId: string, raw: PostMortem, embeddings: { miss: number[]; lesson: number[] }) {
    const pm = redactDeep(raw); // model output can quote secrets it read in the repo
    const now = new Date().toISOString();
    await this.g.run(
      `MATCH (f:Feedback {id: $fid})-[:FROM_TURN]->(t:Turn)<-[:HAS_TURN]-(s:Session)-[:IN]->(p:Project)
       SET f.status = $status, f.updatedAt = $now
       MERGE (task:Task {id: 'task:' + s.id})
         ON CREATE SET task.title = $pm.taskTitle, task.projectKey = p.key, task.createdAt = $now
       MERGE (s)-[:WORKED_ON]->(task)
       MERGE (f)-[:CRITICIZES]->(task)
       MERGE (m:Miss {id: 'miss:' + f.id})
       SET m.missed = $pm.missed, m.cause = $pm.cause, m.causeExplanation = $pm.causeExplanation,
           m.outcome = $pm.outcome, m.projectKey = p.key, m.createdAt = $now, m.embedding = $missEmbedding
       MERGE (m)-[:EXPLAINS]->(f)
       MERGE (c:Cause {key: $pm.cause})
       MERGE (m)-[:CAUSED_BY]->(c)
       MERGE (l:Lesson {id: 'lesson:' + f.id})
         ON CREATE SET l.status = 'proposed', l.createdAt = $now, l.source = 'postmortem'
       SET l.title = $pm.lesson.title, l.rule = $pm.lesson.rule, l.appliesWhen = $pm.lesson.appliesWhen,
           l.scope = $pm.lesson.scope, l.paths = $pm.lesson.paths, l.cause = $pm.cause, l.missId = m.id,
           l.projectKey = CASE WHEN $pm.lesson.scope = 'global' THEN null ELSE p.key END, l.originProjectKey = p.key,
           l.embedding = $lessonEmbedding
       MERGE (l)-[:DERIVED_FROM]->(m)
       WITH f, t, s, p, m, l
       CALL (l, p) {
         WITH l, p WHERE l.scope <> 'global'
         MERGE (l)-[:APPLIES_TO]->(p)
       }
       WITH f, t, s, p, m
       CALL (f, t, s) {
         MATCH (s)-[:DURING]->(k:Commit) WHERE datetime(k.ts) > datetime(t.ts) // committers' offsets differ
         MERGE (k)-[:ADDRESSES]->(f)
       }
       WITH s, p, m
       UNWIND $items AS it
         MERGE (ci:ContextItem {id: it.id})
         SET ci.kind = it.kind, ci.ref = it.ref, ci.excerpt = it.excerpt, ci.projectKey = p.key
         MERGE (ci)-[w:WOULD_HAVE_PREVENTED]->(m) SET w.why = it.why
         FOREACH (_ IN CASE WHEN it.wasAvailable THEN [1] ELSE [] END | MERGE (ci)-[:WAS_AVAILABLE_IN]->(s))`,
      {
        fid: feedbackId,
        pm: { ...pm, contextItems: undefined },
        status: OUTCOME_STATUS[pm.outcome],
        now,
        missEmbedding: embeddings.miss,
        lessonEmbedding: embeddings.lesson,
        items: pm.contextItems.map((c) => ({ ...c, id: contextItemId(feedbackId, c.kind, c.ref) })),
      },
    );
  }

  async listLessons(f: { status?: LessonStatus; projectKey?: string; projectKeys?: string[]; limit?: number }): Promise<Lesson[]> {
    const rows = await this.g.run(
      `MATCH (l:Lesson)
       WHERE ($status IS NULL OR l.status = $status)
         AND ($projectKey IS NULL OR l.projectKey = $projectKey OR l.projectKey IS NULL)
         AND ${LEARNED_IN('l')}
       RETURN l ORDER BY l.createdAt DESC LIMIT $limit`,
      { status: f.status ?? null, projectKey: f.projectKey ?? null, projectKeys: f.projectKeys ?? null, limit: neo4j.int(f.limit ?? 500) },
    );
    return rows.map((r) => lessonOf(r.get('l').properties));
  }

  async lessonDetail(id: string): Promise<LessonDetail | null> {
    const [r] = await this.g.run(
      `MATCH (l:Lesson {id: $id})
       OPTIONAL MATCH (l)-[:DERIVED_FROM]->(m:Miss)-[:EXPLAINS]->(f:Feedback)-[:FROM_TURN]->(t:Turn)
       OPTIONAL MATCH (ci:ContextItem)-[w:WOULD_HAVE_PREVENTED]->(m)
       OPTIONAL MATCH (ci)-[av:WAS_AVAILABLE_IN]->(:Session)
       WITH l, m, f, t, collect(DISTINCT {item: ci, why: w.why, available: av IS NOT NULL}) AS items
       OPTIONAL MATCH (k:Commit)-[:ADDRESSES]->(f)
       WITH l, m, f, t, items, k ORDER BY k.ts
       WITH l, m, f, t, items, collect(k) AS commits
       OPTIONAL MATCH (l)-[:SUPERSEDES]->(old:Lesson)
       RETURN l, m, f, t, items, commits, collect(old.id) AS supersedes`,
      { id },
    );
    if (!r) return null;
    const m = r.get('m')?.properties;
    const f = r.get('f')?.properties;
    const t = r.get('t')?.properties;
    return {
      lesson: lessonOf(r.get('l').properties),
      miss: m ? { id: m.id, missed: m.missed, cause: m.cause, causeExplanation: m.causeExplanation } : null,
      feedback: f && t ? { id: f.id, text: t.text, status: f.status, sessionId: t.sessionId, ts: t.ts } : null,
      contextItems: (r.get('items') as { item: { properties: Record<string, string> } | null; why: string; available: boolean }[])
        .filter((i) => i.item)
        .map((i) => ({
          kind: i.item!.properties.kind as ContextItem['kind'],
          ref: i.item!.properties.ref,
          excerpt: i.item!.properties.excerpt,
          why: i.why,
          wasAvailable: i.available,
        })),
      fixCommits: (r.get('commits') as { properties: Commit }[]).map((c) => ({
        sha: c.properties.sha,
        ts: c.properties.ts,
        subject: c.properties.subject,
      })),
      supersedes: r.get('supersedes'),
    };
  }

  /** `unscoped`: you narrowed it but its project is unknown, so it went back to proposed instead of serving everywhere. */
  async updateLesson(id: string, patch: LessonPatch, o: { reembed?: number[]; by?: string }): Promise<{ unscoped: boolean }> {
    const now = new Date().toISOString();
    const { supersedes, status, ...fields } = patch;
    if (supersedes !== undefined) {
      if (supersedes === id) throw new Error('a lesson cannot supersede itself');
      const [found] = await this.g.run('MATCH (l:Lesson {id: $id}) RETURN l.id AS id', { id: supersedes });
      if (!found) throw new Error(`no lesson ${supersedes} to supersede`);
    }
    const rows = await this.g.run(
      `MATCH (l:Lesson {id: $id})
       SET l += $fields, l.decidedByYou = true
       FOREACH (_ IN CASE WHEN $status IS NULL THEN [] ELSE [1] END | SET l.status = $status, l.decidedAt = $now, l.decidedBy = $by)
       FOREACH (_ IN CASE WHEN $embedding IS NULL THEN [] ELSE [1] END | SET l.embedding = $embedding)
       WITH l
       // Scope decides who sees it: global has no project; project/task go back to the project it came from.
       OPTIONAL MATCH (l)-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(f:Feedback)
       WITH l, coalesce(l.originProjectKey, f.projectKey, l.projectKey) AS origin
       FOREACH (_ IN CASE WHEN $fields.scope = 'global' THEN [1] ELSE [] END | SET l.projectKey = null)
       FOREACH (_ IN CASE WHEN $fields.scope IN ['project', 'task'] AND origin IS NOT NULL THEN [1] ELSE [] END |
         SET l.projectKey = origin, l.originProjectKey = origin
         MERGE (p:Project {key: origin})
         MERGE (l)-[:APPLIES_TO]->(p))
       // Fail closed: a narrowed lesson with no known project must not stay visible to every project.
       FOREACH (_ IN CASE WHEN $fields.scope IN ['project', 'task'] AND origin IS NULL THEN [1] ELSE [] END |
         SET l.status = 'proposed', l.projectKey = null)
       WITH DISTINCT l, $fields.scope IN ['project', 'task'] AND origin IS NULL AS unscoped
       OPTIONAL MATCH (old:Lesson {id: $supersedes})
       FOREACH (_ IN CASE WHEN old IS NULL THEN [] ELSE [1] END |
         MERGE (l)-[:SUPERSEDES]->(old)
         SET old.status = 'superseded', old.decidedAt = $now, old.validTo = $now)
       RETURN unscoped`,
      { id, fields, status: status ?? null, now, by: o.by ?? 'you', embedding: o.reembed ?? null, supersedes: supersedes ?? null },
    );
    return { unscoped: rows[0]?.get('unscoped') ?? false };
  }

  async searchLessons(q: { embedding: number[]; projectKey: string | null; k: number; status?: LessonStatus; projectKeys?: string[] }): Promise<LessonHit[]> {
    const rows = await this.g.run(
      `MATCH (node:Lesson {status: $status})
       WHERE (node.projectKey IS NULL OR node.projectKey = $projectKey) AND ${LEARNED_IN('node')}
         AND node.embedding IS NOT NULL AND size(node.embedding) = size($embedding)
       WITH node, vector.similarity.cosine(node.embedding, $embedding) AS score
       RETURN node, score ORDER BY score DESC LIMIT $k`,
      { embedding: q.embedding, k: neo4j.int(q.k), projectKey: q.projectKey, status: q.status ?? 'approved', projectKeys: q.projectKeys ?? null },
    );
    return rows.map((r) => ({ lesson: lessonOf(r.get('node').properties), score: r.get('score') }));
  }

  async relatedMisses(q: { embedding: number[]; projectKey: string | null; k: number }): Promise<RelatedMiss[]> {
    const rows = await this.g.run(
      `MATCH (node:Miss) WHERE ($projectKey IS NULL OR node.projectKey = $projectKey) AND node.embedding IS NOT NULL AND size(node.embedding) = size($embedding)
       WITH node, vector.similarity.cosine(node.embedding, $embedding) AS score ORDER BY score DESC LIMIT $k
       MATCH (node)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(t:Turn)
       RETURN node, t, score ORDER BY score DESC`,
      { embedding: q.embedding, k: neo4j.int(q.k), projectKey: q.projectKey },
    );
    return rows.map((r) => {
      const m = r.get('node').properties;
      const t = r.get('t').properties;
      return { missId: m.id, missed: m.missed, cause: m.cause, feedbackText: t.text, sessionId: t.sessionId, ts: t.ts, score: r.get('score') };
    });
  }

  /** The manual /postmortem path: queued for your decision, or added to the detector's item for the same miss. */
  async createManualFeedback(input: { project: Project; cwd: string; text: string; whatWasDone: string; sessionId?: string | null }): Promise<string> {
    const o = { ...input, text: redactDeep(input.text), whatWasDone: redactDeep(input.whatWasDone) };
    const now = new Date().toISOString();
    const report = JSON.stringify({ text: o.text, whatWasDone: o.whatWasDone, reportedAt: now, sessionId: o.sessionId ?? null });
    const flagged = await this.g.run(
      `MATCH (k:Candidate {projectKey: $key})-[:FLAGS]->(t:Turn)
       WHERE NOT coalesce(k.manual, false) AND k.agentReport IS NULL AND k.status <> 'rejected' AND t.ts IS NOT NULL
         AND t.external IS NULL
         AND datetime(t.ts) >= datetime($from) AND datetime(t.ts) <= datetime($to)
       RETURN k.id AS id, k.sessionId AS sessionId, t.ts AS ts, t.text AS text`,
      {
        key: o.project.key,
        from: new Date(Date.parse(now) - REPORT_MERGE_MINUTES * 60_000).toISOString(),
        to: new Date(Date.parse(now) + REPORT_MERGE_MINUTES * 60_000).toISOString(),
      },
    );
    const hit = matchReport(
      { ts: now, text: o.text, sessionId: o.sessionId },
      flagged.map((r) => ({ id: r.get('id') as string, sessionId: r.get('sessionId') as string, ts: r.get('ts') as string, text: (r.get('text') as string) ?? '' })),
    );
    if (hit) {
      await this.g.run('MATCH (k:Candidate {id: $id}) SET k.agentReport = $report', { id: hit.id, report });
      return hit.id;
    }
    const id = `manual:${randomUUID()}`;
    await this.g.run(
      `MERGE (p:Project {key: $project.key}) ON CREATE SET p.name = $project.name, p.repoPath = $project.repoPath
       CREATE (s:Session {id: $id, sourceFile: 'manual', cwd: $cwd, startedAt: $now, endedAt: $now, manual: true})-[:IN]->(p)
       CREATE (s)-[:HAS_TURN]->(t:Turn {uuid: $id, sessionId: $id, ts: $now, index: 1, text: $text,
              precedingAssistantText: $done, toolCalls: '[]', label: 'pushback', confidence: 1.0, summary: $text, signals: ['manual']})
       CREATE (k:Candidate {id: $id, turnUuid: $id, sessionId: $id, projectKey: p.key, ts: $now,
              status: 'pending', createdAt: $now, decidedAt: null, note: null, manual: true, agentReport: $report})-[:FLAGS]->(t)`,
      { id, now, project: o.project, cwd: o.cwd, text: o.text, done: o.whatWasDone, report },
    );
    return id;
  }

  async recordPreDoneCheck(c: { projectKey: string; task: string; checkedLessonIds: string[]; gapLessonIds: string[] }) {
    await this.g.run(
      `CREATE (x:PreDoneCheck {id: $id, ts: $now, projectKey: $c.projectKey, task: $c.task,
                              checked: size($c.checkedLessonIds), gaps: size($c.gapLessonIds)})
       WITH x
       UNWIND $c.checkedLessonIds AS lid
         MATCH (l:Lesson {id: lid})
         MERGE (x)-[r:CHECKED]->(l) SET r.gap = lid IN $c.gapLessonIds`,
      { id: randomUUID(), now: new Date().toISOString(), c: { ...c, task: redactSecrets(c.task) } },
    );
  }

  async upsertLesson(input: LessonInput) {
    const l = redactDeep(input);
    const now = new Date().toISOString();
    await this.g.run(
      `MERGE (l:Lesson {id: $l.id})
         ON CREATE SET l.createdAt = $now, l.status = $l.status, l.decidedAt = CASE WHEN $l.status = 'proposed' THEN null ELSE $now END, l.source = $l.source,
                       l.projectKey = $l.projectKey, l.originProjectKey = $l.projectKey
       // Once you have decided on or edited a lesson, re-importing its file never overrides you.
       WITH l, coalesce(l.decidedByYou, false) AS yours
       FOREACH (_ IN CASE WHEN yours THEN [] ELSE [1] END |
         SET l.title = $l.title, l.rule = $l.rule, l.appliesWhen = $l.appliesWhen, l.scope = $l.scope, l.paths = $l.paths,
             l.embedding = $l.embedding)
       WITH l WHERE $l.projectKey IS NOT NULL
       MERGE (p:Project {key: $l.projectKey})
       MERGE (l)-[:APPLIES_TO]->(p)`,
      { l, now },
    );
  }
}

function turnOf(p: Record<string, unknown>): HumanTurn {
  return {
    uuid: p.uuid as string,
    sessionId: p.sessionId as string,
    ts: p.ts as string,
    index: p.index as number,
    text: p.text as string,
    precedingAssistantText: (p.precedingAssistantText as string) ?? '',
    precedingToolCalls: JSON.parse((p.toolCalls as string) ?? '[]'),
    ...(p.external ? { external: JSON.parse(p.external as string) } : {}),
  };
}

/** $projectKeys (null: any): the lesson was learned in one of them, or has no project at all. */
const LEARNED_IN = (v: string) => `($projectKeys IS NULL OR coalesce(${v}.projectKey, ${v}.originProjectKey) IS NULL OR coalesce(${v}.projectKey, ${v}.originProjectKey) IN $projectKeys)`;

function lessonOf(p: Record<string, unknown>): Lesson {
  return {
    id: p.id as string,
    projectKey: (p.projectKey as string) ?? null,
    origin: ((p.projectKey ?? p.originProjectKey) as string) ?? null,
    title: p.title as string,
    rule: p.rule as string,
    appliesWhen: (p.appliesWhen as string) ?? '',
    scope: p.scope as LessonScope,
    paths: (p.paths as string[]) ?? [],
    status: p.status as LessonStatus,
    source: (p.source as Lesson['source']) ?? 'postmortem',
    cause: (p.cause as Cause) ?? null,
    missId: (p.missId as string) ?? null,
    createdAt: p.createdAt as string,
    decidedAt: (p.decidedAt as string) ?? null,
    decidedBy: (p.decidedBy as string) ?? null,
  };
}
