import { conditionalWrite } from './conditionalWrite.ts';
import { archiveBeforeRedaction, archiveRedactionInput } from '../redactionArchive.ts';
import { reviewPatterns } from '../reviewFilters.ts';
import { createHash, randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import type {
  Cause,
  Commit,
  ContextItem,
  ExternalRef,
  FeedbackStatus,
  HumanTurn,
  Lesson,
  LessonCheck,
  LessonDraft,
  LessonFrom,
  LessonScope,
  LessonStatus,
  LessonTriggers,
  Outcome,
  PostMortem,
  PostMortemInput,
  Project,
  RunTag,
} from '../types.ts';
import { REDACT_PAGE, redactDeep, redactSecrets, redactStoredLesson, redactStoredRow } from '../redact.ts';
import { LESSON_CHECKS_VERSION } from '../types.ts';
import { TRIGGER_DERIVATION_VERSION } from '../lessonTriggers.ts';
import { DEMO_SOURCE, demoPrefix, type CommentLesson, type DemoMiss, type DemoRemoved, type KnowledgeStore, type LessonFilter, type SimilarLesson, type DecidedLesson, type DecidedLessonsQuery, type LoopLessonInput } from '../store.ts';
import { draftOf, editedDraft, ownerDecided } from '../lessonOutcome.ts';
import { lessonFingerprint, TargetChangedError, type LessonSnapshotWrite, type SupersedeLink } from '../decisions/record.ts';
import { retryDeadlock, type GraphRepo } from './repo.ts';
import { matchReport, reportWindowMs } from '../dedupe.ts';
import { nearest, visibleToRun } from './nearest.ts';
import { VISIBLE_TO_RUN } from './runs.ts';

/** An issue key: a prefix starting with a letter, a hyphen and a number (APP-123, ABC2-15, MY_PROJ-12). */
export const ISSUE_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * A regular expression, in the dialect Java (Cypher's =~) and Postgres (~*) share, that finds any of `keys` where it
 * stands as a whole key: not inside a longer word or number, and not the start of a version ("HTTP-1.1"). Matching is
 * case-insensitive by the caller's flag. Anything not shaped like a key is left out.
 */
export function issueKeyPattern(keys: string[]): string {
  const valid = [...new Set(keys.filter((key) => ISSUE_KEY_SHAPE.test(key)).map((key) => key.toUpperCase()))];
  return `(?<![A-Za-z0-9_])(?:${valid.join('|')})(?![A-Za-z0-9_]|\\.[0-9])`;
}

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

/** Who wrote a lesson's feedback when it came from GitHub or Linear (ExternalRef, trimmed to what the lesson shows). */
export type FeedbackAuthor = { source: ExternalRef['source']; author: string; url: string; reviewState: ExternalRef['reviewState'] | null; threadState?: ExternalRef['threadState'] };
/** The FeedbackAuthor of a stored ExternalRef (JSON in Neo4j, jsonb in Postgres), or null. */
export function feedbackAuthorOf(ext: unknown): FeedbackAuthor | null {
  const e = (typeof ext === 'string' ? JSON.parse(ext) : ext) as Partial<ExternalRef> | null | undefined;
  return e?.source ? { source: e.source, author: e.author ?? '', url: e.url ?? '', reviewState: e.reviewState ?? null, ...(e.threadState && { threadState: e.threadState }) } : null;
}

/** A feedback turn's evidence for LessonDetail: what was done before it, and a comment's file and diff lines. */
export function evidenceOf(done: unknown, ext: unknown): { done: string | null; commentPath: string | null; diffHunk: string | null } {
  const e = (typeof ext === 'string' ? JSON.parse(ext) : ext) as Partial<ExternalRef> | null | undefined;
  return { done: typeof done === 'string' && done ? done : null, commentPath: e?.path ?? null, diffHunk: e?.diffHunk ?? null };
}

export type LessonDetail = {
  lesson: Lesson;
  miss: { id: string; missed: string; cause: Cause; causeExplanation: string } | null;
  /**
   * external: set when the feedback is a GitHub or Linear comment: whose words they are (a reviewer, not you) and,
   * on GitHub, the verdict of the review it belongs to. Null for feedback you gave in a session.
   */
  feedback: {
    id: string; text: string; status: FeedbackStatus; sessionId: string; ts: string; external?: FeedbackAuthor | null;
    /** What the agent had done before it (an agent's report: what_was_done); the miss's evidence, with the comment's file and diff lines. */
    done?: string | null; commentPath?: string | null; diffHunk?: string | null;
  } | null;
  contextItems: ContextItem[];
  fixCommits: Commit[];
  supersedes: string[];
};

export type LessonPatch = Partial<Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope' | 'paths'>> & {
  /** The owner's triggers (LessonTriggers); not part of the writer's draft (proposedAs), so editing them is not an edit of its words. */
  triggers?: LessonTriggers;
  status?: LessonStatus;
  supersedes?: string;
  /**
   * With scope project or task: the project the lesson serves from now on, over the one it was learned in. How a global
   * lesson with no project to trace it to (written by hand, imported) is narrowed; the API checks it is a known project.
   */
  projectKey?: string;
};

export type LessonHit = { lesson: Lesson; score: number };

export type RelatedMiss = {
  /** Task-local ordering weight; score remains raw embedding similarity. */
  rankingScore?: number;
  missId: string;
  missed: string;
  cause: Cause;
  feedbackText: string;
  sessionId: string;
  ts: string;
  score: number;
  /**
   * Its lesson was rejected with the wrong-session check: the post-mortem was worked out from a session that did other
   * work, so the miss is not evidence of anything and is left out of "Similar past misses". Both stores set it.
   */
  rejectedWrongSession?: boolean;
};

/**
 * A stored miss with no subject (about the code, as far as it was known when it was saved), with what decides whether
 * it is a process miss: the feedback's words, its lesson's rule, and the file a review comment is on.
 */
export type UnsortedMiss = { missId: string; projectKey: string; feedbackText: string; rule: string | null; commentPath: string | null; paths: string[] };

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
  /** Review/quarantine flags preserved across backup imports. */
  checks?: LessonCheck[] | null;
  /** Its triggers, carried by an export bundle; unset or null: the worker derives them. */
  triggers?: LessonTriggers | null;
  /** The run it was written in (x-fg-run; fg demo seed): recorded when the lesson is first written, never moved. */
  run?: RunTag | null;
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

  async postmortemQueue(): Promise<{ waiting: number; oldestAt: string | null }> {
    const [r] = await this.g.run(
      `MATCH (f:Feedback)-[:FROM_TURN]->(:Turn)<-[:HAS_TURN]-(:Session)-[:IN]->(:Project)
       WHERE NOT (f)<-[:EXPLAINS]-(:Miss) AND f.status <> 'rejected' AND coalesce(f.attempts, 0) < $max
       WITH DISTINCT f
       RETURN count(f) AS n, min(f.createdAt) AS oldest`,
      { max: MAX_POSTMORTEM_ATTEMPTS },
    );
    return { waiting: Number(r?.get('n') ?? 0), oldestAt: (r?.get('oldest') as string | null) ?? null };
  }

  async feedbackNeedingPostmortem(limit: number, now = new Date()): Promise<PostMortemInput[]> {
    const rows = await this.g.run(
      `MATCH (f:Feedback)-[:FROM_TURN]->(t:Turn)<-[:HAS_TURN]-(s:Session)-[:IN]->(p:Project)
       WHERE NOT (f)<-[:EXPLAINS]-(:Miss) AND f.status <> 'rejected' AND coalesce(f.attempts, 0) < $max AND coalesce(f.retryAt, '') <= $now
       OPTIONAL MATCH (k:Candidate {id: f.id})
       WITH f, t, s, p, k ORDER BY f.createdAt, f.id LIMIT $limit
       MATCH (s)-[:HAS_TURN]->(st:Turn)
       WITH f, t, s, p, k, st ORDER BY st.index
       RETURN f.id AS id, f.run AS sourceRun, f.sandbox AS sourceSandbox, t, s, p, k.note AS note, k.decidedBy AS noteBy, collect(st) AS turns`,
      { max: MAX_POSTMORTEM_ATTEMPTS, limit: neo4j.int(limit), now: now.toISOString() },
    );
    return rows.map((r) => ({
      feedbackId: r.get('id'),
      ...(r.get('sourceRun') ? { run: r.get('sourceRun') as string } : {}),
      ...(r.get('sourceSandbox') === true ? { sandbox: true as const } : {}),
      projectKey: r.get('p').properties.key,
      repoPath: r.get('p').properties.repoPath,
      cwd: r.get('s').properties.cwd ?? '',
      sessionId: r.get('s').properties.id,
      source: r.get('s').properties.source ?? 'claude',
      feedback: turnOf(r.get('t').properties),
      turns: (r.get('turns') as { properties: Record<string, unknown> }[]).map((n) => turnOf(n.properties)),
      note: r.get('note') ?? null,
      noteBy: r.get('noteBy') ?? null,
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
    return conditionalWrite(this.g, async query => {
      const [r] = await query(
        `MATCH (f:Feedback {id: $id}) WHERE NOT (f)<-[:EXPLAINS]-(:Miss) SET f.attempts = 0, f.retryAt = null RETURN count(f) AS n`,
        { id: feedbackId },
      );
      return (r?.get('n') ?? 0) > 0;
    }, Boolean);
  }

  async savePostmortem(feedbackId: string, raw: PostMortem, embeddings: { miss: number[]; lesson: number[] }) {
    const pm = redactDeep(raw);
    await archiveRedactionInput('postmortem', feedbackId, raw, pm); // model output can quote secrets it read in the repo
    const now = new Date().toISOString();
    // A disputed claim that the post-mortem finds false is not a training miss.
    if (pm.noMiss) {
      const [saved] = await this.g.run('MATCH (f:Feedback {id: $fid}) SET f.status = $status, f.updatedAt = $now WITH f OPTIONAL MATCH (m:Miss)-[:EXPLAINS]->(f) DETACH DELETE m RETURN count(DISTINCT f) AS n', { fid: feedbackId, status: 'rejected', now });
      return Number(saved?.get('n') ?? 0) > 0;
    }
    // A sandbox report's miss and lesson are sandbox records: marked before they are written (this may be the worker,
    // whose searches have not seen the report).
    const [k] = await this.g.run('MATCH (k:Candidate {id: $fid}) RETURN coalesce(k.sandbox, false) AS sandbox', { fid: feedbackId });
    // No candidate read back: marked, since an unknown source fails closed.
    this.g.sandbox.wrote(k ? k.get('sandbox') : true);
    const saved = await this.g.run(
      `MATCH (f:Feedback {id: $fid})-[:FROM_TURN]->(t:Turn)<-[:HAS_TURN]-(s:Session)-[:IN]->(p:Project)
       // The report's run (RunTag), carried to the miss and lesson so a sandbox one is served only to its run.
       OPTIONAL MATCH (k:Candidate {id: $fid})
       SET f.status = $status, f.updatedAt = $now
       MERGE (task:Task {id: 'task:' + s.id})
         ON CREATE SET task.title = $pm.taskTitle, task.projectKey = p.key, task.createdAt = $now
       MERGE (s)-[:WORKED_ON]->(task)
       MERGE (f)-[:CRITICIZES]->(task)
       MERGE (m:Miss {id: 'miss:' + f.id})
       SET m.missed = $pm.missed, m.cause = $pm.cause, m.causeExplanation = $pm.causeExplanation,
           m.outcome = $pm.outcome, m.projectKey = p.key, m.createdAt = $now, m.embedding = $missEmbedding, m.subject = $subject,
           m.run = k.run, m.sandbox = coalesce(k.sandbox, false)
       MERGE (m)-[:EXPLAINS]->(f)
       MERGE (c:Cause {key: $pm.cause})
       MERGE (m)-[:CAUSED_BY]->(c)
       WITH f, t, s, p, m, k
       // A dropped lesson (no rule even after the retry) is not written: the miss is.
       CALL (f, p, m, k) {
         WITH f, p, m, k WHERE NOT $lessonDropped
         MERGE (l:Lesson {id: 'lesson:' + f.id})
           ON CREATE SET l.status = 'proposed', l.createdAt = $now, l.source = 'postmortem'
         SET l.cause = $pm.cause, l.missId = m.id, l.originProjectKey = p.key, l.run = k.run, l.sandbox = coalesce(k.sandbox, false)
         // A lesson the owner edited (proposedAs kept) keeps the owner's words, paths, scope and their checks: a re-save
         // rewrites only one the owner has not touched.
         FOREACH (_ IN CASE WHEN l.proposedAs IS NULL THEN [1] ELSE [] END |
           SET l.title = $pm.lesson.title, l.rule = $pm.lesson.rule, l.appliesWhen = $pm.lesson.appliesWhen,
               l.scope = $pm.lesson.scope, l.paths = $pm.lesson.paths,
               l.triggers = CASE WHEN coalesce(l.triggersOwned, false) THEN l.triggers ELSE $triggers END,
               l.triggersVersion = CASE WHEN coalesce(l.triggersOwned, false) THEN l.triggersVersion WHEN $triggers IS NULL THEN null ELSE $triggersVersion END,
               l.projectKey = CASE WHEN $pm.lesson.scope = 'global' THEN null ELSE p.key END,
               l.embedding = $lessonEmbedding, l.checks = $checks, l.checksVersion = CASE WHEN $checks IS NULL THEN null ELSE $checksVersion END)
         MERGE (l)-[:DERIVED_FROM]->(m)
         WITH l, p
         CALL (l, p) {
           WITH l, p WHERE l.scope <> 'global'
           MERGE (l)-[:APPLIES_TO]->(p)
         }
       }
       WITH f, t, s, p, m
       CALL (f, t, s) {
         MATCH (s)-[:DURING]->(k:Commit) WHERE datetime(k.ts) > datetime(t.ts) // committers' offsets differ
         MERGE (k)-[:ADDRESSES]->(f)
       }
       WITH f, s, p, m
       CALL (s, p, m) {
       UNWIND $items AS it
         MERGE (ci:ContextItem {id: it.id})
         SET ci.kind = it.kind, ci.ref = it.ref, ci.excerpt = it.excerpt, ci.projectKey = p.key
         MERGE (ci)-[w:WOULD_HAVE_PREVENTED]->(m) SET w.why = it.why
         FOREACH (_ IN CASE WHEN it.wasAvailable THEN [1] ELSE [] END | MERGE (ci)-[:WAS_AVAILABLE_IN]->(s))
       }
       RETURN f.id AS saved`,
      {
        fid: feedbackId,
        pm: { ...pm, contextItems: undefined, lessonChecks: undefined, facts: undefined, lessonDropped: undefined },
        subject: pm.subject ?? null,
        lessonDropped: !!pm.lessonDropped,
        // A node property cannot hold a list of maps: the checks are kept as JSON (lessonOf parses them).
        checks: pm.lessonChecks ? JSON.stringify(pm.lessonChecks) : null,
        // The triggers too (null: none derived, so the worker's backfill derives them).
        triggers: pm.lesson.triggers ? JSON.stringify(pm.lesson.triggers) : null,
        checksVersion: neo4j.int(LESSON_CHECKS_VERSION),
        triggersVersion: neo4j.int(TRIGGER_DERIVATION_VERSION),
        status: OUTCOME_STATUS[pm.outcome],
        now,
        missEmbedding: embeddings.miss,
        lessonEmbedding: embeddings.lesson,
        items: pm.contextItems.map((c) => ({ ...c, id: contextItemId(feedbackId, c.kind, c.ref) })),
      },
    );
    return saved.length > 0;
  }

  async listLessons(f: LessonFilter): Promise<Lesson[]> {
    // Paging by id with no filter on the feedback: the page is cut before its feedback is read.
    const paging = f.afterId !== undefined && f.from === undefined && f.author === undefined && f.pr === undefined;
    const rows = await this.g.run(
      `${f.ids ? 'MATCH (l:Lesson) WHERE l.id IN $ids WITH l' : f.afterId !== undefined ? 'MATCH (l:Lesson) WHERE l.id > $afterId WITH l' : 'MATCH (l:Lesson)'}
       WHERE ($status IS NULL OR l.status = $status)
         AND ($projectKey IS NULL OR l.projectKey = $projectKey OR l.projectKey IS NULL)
         AND ${LEARNED_IN('l')}
         // The checks are JSON text (lessonOf); a flag is its "name" key.
         AND ($flag IS NULL OR l.checks CONTAINS $flag)
         AND ${VISIBLE_TO_RUN('l')}
       ${paging ? 'WITH l ORDER BY l.id LIMIT $limit' : ''}
       OPTIONAL MATCH (l)-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(t:Turn)
       WITH l, t, ${FROM} AS fromKind
       WHERE ($from IS NULL OR fromKind = $from)
         AND ($author IS NULL OR toLower(t.external) CONTAINS $author)
         AND ($pr IS NULL OR t.external =~ $pr OR coalesce(t.text, '') + '\n' + coalesce(t.precedingAssistantText, '') + '\n' + coalesce(t.summary, '') + '\n' + l.title + '\n' + l.rule + '\n' + coalesce(l.appliesWhen, '') =~ $prText)
       RETURN l, fromKind ORDER BY ${f.afterId === undefined ? 'l.createdAt DESC, ' : ''}l.id LIMIT $limit`,
      {
        ids: f.ids ?? null, afterId: f.afterId ?? null, status: f.status ?? null, projectKey: f.projectKey ?? null, projectKeys: f.projectKeys ?? null, limit: neo4j.int(f.limit ?? 500),
        flag: f.flag ? `"name":${JSON.stringify(f.flag)}` : null, from: f.from ?? null, run: f.run ?? null,
        prText: f.pr ? `(?is).*${reviewPatterns(f.pr).pr}.*` : null, authorText: f.author ? `(?is).*${reviewPatterns(undefined, f.author).author}.*` : null,
        author: f.author ? `"author":${JSON.stringify(f.author.toLowerCase())}` : null, pr: f.pr ? `(?s).*"thread":"[^"]*#${f.pr}".*` : null,
      },
    );
    return rows.map((r) => lessonOf(r.get('l').properties, r.get('fromKind')));
  }

  async staleLessonChecks(version: number, limit: number): Promise<Lesson[]> {
    const rows = await this.g.run(
      `MATCH (l:Lesson) WHERE l.status IN ['proposed', 'approved'] AND coalesce(l.checksVersion, 0) < $version
       OPTIONAL MATCH (l)-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(t:Turn)
       RETURN l, ${FROM} AS fromKind ORDER BY l.createdAt, l.id LIMIT $limit`,
      { version: neo4j.int(version), limit: neo4j.int(limit) },
    );
    return rows.map((r) => lessonOf(r.get('l').properties, r.get('fromKind')));
  }

  async commentLessons(q: { status: LessonStatus; limit: number; afterId?: string | null }): Promise<CommentLesson[]> {
    const rows = await this.g.run(
      `MATCH (l:Lesson {status: $status})-[:DERIVED_FROM]->(m:Miss)-[:EXPLAINS]->(f:Feedback)-[:FROM_TURN]->(t:Turn)
       WHERE t.external IS NOT NULL AND ($afterId IS NULL OR l.id > $afterId)
       RETURN l.id AS id, f.id AS feedbackId, coalesce(m.projectKey, l.originProjectKey, l.projectKey) AS projectKey, t.text AS text,
              t.external AS external, l.checks AS checks, m.missed AS missed, m.causeExplanation AS causeExplanation,
              l.proposedAs IS NOT NULL AS ownerEdited
       ORDER BY l.id LIMIT $limit`,
      { status: q.status, afterId: q.afterId ?? null, limit: neo4j.int(q.limit) },
    );
    return rows.map((r) => ({
      id: r.get('id'),
      feedbackId: r.get('feedbackId'),
      projectKey: r.get('projectKey'),
      text: r.get('text') ?? '',
      external: JSON.parse(r.get('external')) as ExternalRef,
      checks: typeof r.get('checks') === 'string' ? (JSON.parse(r.get('checks')) as LessonCheck[]) : null,
      missed: r.get('missed') ?? '',
      causeExplanation: r.get('causeExplanation') ?? '',
      ownerEdited: r.get('ownerEdited') === true,
    }));
  }

  async requestLessonRecheck(): Promise<number> {
    const [r] = await this.g.run(`MATCH (l:Lesson) WHERE l.status IN ['proposed', 'approved'] SET l.checksVersion = 0 RETURN count(l) AS n`);
    return Number(r?.get('n') ?? 0);
  }

  async similarLessons(id: string, k: number): Promise<SimilarLesson[]> {
    // vector.similarity.cosine is (1 + cos) / 2: the true cosine is 2 * score - 1.
    const rows = await this.g.run(
      `MATCH (l:Lesson {id: $id}) WHERE l.embedding IS NOT NULL AND size(l.embedding) > 0
       WITH l, coalesce(l.projectKey, l.originProjectKey) AS origin
       MATCH (o:Lesson) WHERE o.id <> l.id AND o.embedding IS NOT NULL AND size(o.embedding) = size(l.embedding)
         AND ((origin IS NULL AND coalesce(o.projectKey, o.originProjectKey) IS NULL) OR coalesce(o.projectKey, o.originProjectKey) = origin)
       WITH o, 2 * vector.similarity.cosine(o.embedding, l.embedding) - 1 AS cosine
       RETURN o.id AS id, cosine, o.status AS status, o.createdAt AS createdAt ORDER BY cosine DESC, id LIMIT $k`,
      { id, k: neo4j.int(k) },
    );
    return rows.map((r) => ({ id: r.get('id'), cosine: r.get('cosine'), status: r.get('status'), createdAt: r.get('createdAt') }));
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
       RETURN l, m, f, t, items, commits, collect(old.id) AS supersedes, ${FROM} AS fromKind`,
      { id },
    );
    if (!r) return null;
    const m = r.get('m')?.properties;
    const f = r.get('f')?.properties;
    const t = r.get('t')?.properties;
    return {
      lesson: lessonOf(r.get('l').properties, r.get('fromKind')),
      miss: m ? { id: m.id, missed: m.missed, cause: m.cause, causeExplanation: m.causeExplanation ?? '' } : null,
      feedback: f && t ? { id: f.id, text: t.text, status: f.status, sessionId: t.sessionId, ts: t.ts, external: feedbackAuthorOf(t.external), ...evidenceOf(t.precedingAssistantText, t.external) } : null,
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
  async updateLesson(id: string, patch: LessonPatch, o: { reembed?: number[]; by?: string; note?: string; expect?: string }): Promise<{ unscoped: boolean }> {
    const safePatch = redactDeep(patch);
    await archiveRedactionInput('lesson-edit', id, patch, safePatch);
    patch = safePatch;
    const now = new Date().toISOString();
    const { supersedes, status, projectKey, triggers, ...words } = patch;
    // A node property cannot hold a map: the triggers are kept as JSON (lessonOf parses them).
    // Triggers set here are the owner's (or an operator's): a re-saved post-mortem keeps them (triggersOwned).
    const fields = { ...words, ...(triggers !== undefined && { triggers: JSON.stringify(triggers), triggersOwned: true }) };
    if (status === 'revoked') {
      const [current] = await this.g.run('MATCH (l:Lesson {id: $id}) RETURN l.status AS status', { id });
      if (current?.get('status') !== 'approved') throw new Error('only a previously approved lesson can be revoked');
    }
    if (supersedes !== undefined) {
      if (supersedes === id) throw new Error('a lesson cannot supersede itself');
      const [found] = await this.g.run('MATCH (l:Lesson {id: $id}) RETURN l.id AS id', { id: supersedes });
      if (!found) throw new Error(`no lesson ${supersedes} to supersede`);
    }
    // The writer's version, kept on the first edit of a proposed lesson (the guard in the query keeps it the first).
    const draft = await this.writerDraft(id, words);
    const write = (query: GraphRepo['run']) => query(
      `MATCH (l:Lesson {id: $id})
       FOREACH (_ IN CASE WHEN $draft IS NULL OR l.proposedAs IS NOT NULL OR l.status <> 'proposed' THEN [] ELSE [1] END | SET l.proposedAs = $draft)
       // Only the owner's decision or edit makes it yours (a memory file's re-import then leaves it); a machine's does not.
       SET l += $fields, l.decidedByYou = CASE WHEN $owner THEN true ELSE l.decidedByYou END
       // New words are checked again at the worker's next round: a flag on the old words (broken-rule) must not stay.
       FOREACH (_ IN CASE WHEN $words THEN [1] ELSE [] END | SET l.checksVersion = 0)
       FOREACH (_ IN CASE WHEN $status IS NULL THEN [] ELSE [1] END | SET l.status = $status, l.decidedAt = $now, l.decidedBy = $by, l.decisionNote = $note)
       // An edit given a note says why; one without leaves the last decision's note.
       FOREACH (_ IN CASE WHEN $status IS NULL AND $note IS NOT NULL THEN [1] ELSE [] END | SET l.decisionNote = $note)
       FOREACH (_ IN CASE WHEN $embedding IS NULL THEN [] ELSE [1] END | SET l.embedding = $embedding)
       WITH l
       // Scope decides who sees it: global has no project; project/task go back to the project it came from.
       OPTIONAL MATCH (l)-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(f:Feedback)
       // A project named in the patch (narrowing a global lesson) wins over the one it was learned in.
       WITH l, coalesce($projectKey, l.originProjectKey, f.projectKey, l.projectKey) AS origin
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
      { id, fields, status: status ?? null, now, by: o.by ?? 'you', owner: ownerDecided(o.by ?? 'you'), note: o.note ? redactSecrets(o.note) : null, embedding: o.reembed ?? null, supersedes: supersedes ?? null, draft, projectKey: projectKey ?? null,
        words: Object.values(words).some((v) => v !== undefined) },
    );
    const { expect } = o;
    // With `expect`, the lesson is locked and compared in the transaction that writes it.
    const rows = expect === undefined ? await write((c, p) => this.g.run(c, p)) : await conditionalWrite(this.g, async (query) => {
      const [cur] = await query('MATCH (l:Lesson {id: $id}) SET l._lock = coalesce(l._lock, 0) + 1 REMOVE l._lock RETURN l', { id });
      const actual = cur ? lessonFingerprint(lessonOf(cur.get('l').properties)) : null;
      if (actual !== expect) throw new TargetChangedError(id, expect, actual);
      return write(query);
    }, () => true);
    return { unscoped: rows[0]?.get('unscoped') ?? false };
  }

  async writeLessonSnapshots(writes: LessonSnapshotWrite[], o: { supersede?: SupersedeLink[]; unsupersede?: SupersedeLink[] } = {}): Promise<void> {
    if (!writes.length) return;
    const safe = writes.map((w) => ({ id: w.id, expect: w.expect, f: redactDeep(w.fields), embedding: w.embedding ?? null, setTriggers: w.fields.triggers !== undefined, triggers: w.fields.triggers ? JSON.stringify(w.fields.triggers) : null }));
    for (const [i, w] of writes.entries()) await archiveRedactionInput('lesson-snapshot', w.id, w.fields, safe[i].f);
    // Two writes to one lesson at once (a double-clicked rollback) can be aborted as a deadlock by Neo4j: the aborted
    // one wrote nothing and runs again, comparing afresh.
    await retryDeadlock(() => conditionalWrite(this.g, async (query) => {
      // Every lesson locked and compared before any is written: one that changed leaves them all as they were.
      const rows = await query('UNWIND $ids AS id MATCH (l:Lesson {id: id}) SET l._lock = coalesce(l._lock, 0) + 1 REMOVE l._lock RETURN l', { ids: safe.map((w) => w.id) });
      const now = new Map(rows.map((r) => { const l = lessonOf(r.get('l').properties); return [l.id, lessonFingerprint(l)]; }));
      for (const w of safe) if (now.get(w.id) !== w.expect) throw new TargetChangedError(w.id, w.expect, now.get(w.id) ?? null);
      await query(
        `UNWIND $writes AS w MATCH (l:Lesson {id: w.id})
         WITH l, w, [l.title, l.rule, coalesce(l.appliesWhen, ''), l.scope, coalesce(l.paths, [])] <> [w.f.title, w.f.rule, w.f.appliesWhen, w.f.scope, w.f.paths] AS words,
           CASE WHEN w.f.status <> 'superseded' THEN null WHEN l.status = 'superseded' THEN l.validTo ELSE w.f.decidedAt END AS validTo
         SET l.projectKey = w.f.projectKey, l.title = w.f.title, l.rule = w.f.rule, l.appliesWhen = w.f.appliesWhen, l.scope = w.f.scope,
           l.paths = w.f.paths, l.status = w.f.status, l.decidedAt = w.f.decidedAt, l.decidedBy = w.f.decidedBy,
           l.decisionNote = w.f.decisionNote, l.servingWeight = w.f.servingWeight, l.validTo = validTo, l.checksVersion = CASE WHEN words THEN 0 ELSE l.checksVersion END
         FOREACH (_ IN CASE WHEN w.embedding IS NULL THEN [] ELSE [1] END | SET l.embedding = w.embedding)
         FOREACH (_ IN CASE WHEN w.setTriggers THEN [1] ELSE [] END | SET l.triggers = w.triggers)
         FOREACH (_ IN CASE WHEN w.f.projectKey IS NULL THEN [] ELSE [1] END | MERGE (p:Project {key: w.f.projectKey}) MERGE (l)-[:APPLIES_TO]->(p))`,
        { writes: safe },
      );
      await query('UNWIND $links AS s MATCH (k:Lesson {id: s.keeper}), (m:Lesson {id: s.merged}) MERGE (k)-[:SUPERSEDES]->(m)', { links: o.supersede ?? [] });
      await query('UNWIND $links AS s MATCH (:Lesson {id: s.keeper})-[r:SUPERSEDES]->(:Lesson {id: s.merged}) DELETE r', { links: o.unsupersede ?? [] });
      return true;
    }, () => true));
  }

  async addLoopLesson(input: LoopLessonInput): Promise<boolean> {
    const f = redactDeep(input.fields);
    await archiveRedactionInput('lesson', input.id, input.fields, f);
    return conditionalWrite(this.g, async (query) => {
      const rows = await query(
        `MATCH (src:Lesson {id: $from}) WHERE NOT EXISTS { MATCH (:Lesson {id: $id}) }
         CREATE (l:Lesson {id: $id, createdAt: $now, source: src.source, cause: src.cause, missId: src.missId,
                           originProjectKey: coalesce(src.originProjectKey, src.projectKey), run: src.run, sandbox: src.sandbox, splitFrom: src.id,
                           projectKey: $f.projectKey, title: $f.title, rule: $f.rule, appliesWhen: $f.appliesWhen, scope: $f.scope, paths: $f.paths,
                           status: $f.status, decidedAt: $f.decidedAt, decidedBy: $f.decidedBy, decisionNote: $f.decisionNote,
                           servingWeight: $f.servingWeight, embedding: $embedding, checksVersion: 0})
         WITH src, l
         OPTIONAL MATCH (src)-[:DERIVED_FROM]->(m:Miss)
         FOREACH (_ IN CASE WHEN m IS NULL THEN [] ELSE [1] END | MERGE (l)-[:DERIVED_FROM]->(m))
         FOREACH (_ IN CASE WHEN $f.projectKey IS NULL THEN [] ELSE [1] END | MERGE (p:Project {key: $f.projectKey}) MERGE (l)-[:APPLIES_TO]->(p))
         RETURN count(DISTINCT l) AS n`,
        { id: input.id, from: input.from, f, embedding: input.embedding, now: new Date().toISOString() },
      );
      return Number(rows[0]?.get('n') ?? 0) > 0;
    }, (made) => made);
  }

  async removeLoopLesson(id: string, expect: string): Promise<void> {
    await conditionalWrite(this.g, async (query) => {
      const [r] = await query('MATCH (l:Lesson {id: $id}) SET l._lock = coalesce(l._lock, 0) + 1 REMOVE l._lock RETURN l', { id });
      const l = r ? lessonOf(r.get('l').properties) : null;
      const actual = l ? lessonFingerprint(l) : null;
      if (!l?.splitFrom || actual !== expect) throw new TargetChangedError(id, expect, actual);
      // Its outcome counts go with it, as Postgres' lesson_signals rows do (ON DELETE CASCADE).
      await query('MATCH (l:Lesson {id: $id}) OPTIONAL MATCH (l)-[:HAS_SIGNALS]->(s:LessonSignals) DETACH DELETE l, s', { id });
      return true;
    }, () => true);
  }

  async threadTasks(): Promise<{ id: string; title: string | null; external: ExternalRef }[]> {
    const rows = await this.g.run(
      `MATCH (s:Session)-[:WORKED_ON]->(task:Task) WHERE s.manual AND (s.id STARTS WITH 'github:' OR s.id STARTS WITH 'linear:')
       MATCH (s)-[:HAS_TURN]->(t:Turn) WHERE t.external IS NOT NULL
       WITH task, min(t.uuid) AS first
       MATCH (t:Turn {uuid: first})
       RETURN task.id AS id, task.title AS title, t.external AS external ORDER BY id`,
    );
    return rows.map((r) => ({ id: r.get('id'), title: r.get('title') ?? null, external: JSON.parse(r.get('external')) as ExternalRef }));
  }

  async setTaskTitle(id: string, title: string): Promise<boolean> {
    const [r] = await this.g.run('MATCH (task:Task {id: $id}) SET task.title = $title RETURN count(task) AS n', { id, title: redactSecrets(title) });
    return Number(r?.get('n') ?? 0) > 0;
  }

  async backfillProposedAs(id: string, draft: LessonDraft): Promise<boolean> {
    await archiveRedactionInput('lesson-draft', id, draftOf(draft), redactDeep(draftOf(draft)));
    const [r] = await this.g.run(
      `MATCH (l:Lesson {id: $id}) WHERE l.source = 'postmortem' AND l.proposedAs IS NULL SET l.proposedAs = $draft RETURN count(l) AS n`,
      { id, draft: JSON.stringify(redactDeep(draftOf(draft))) },
    );
    return Number(r?.get('n') ?? 0) > 0;
  }

  /** editedDraft of the stored lesson, as redacted JSON text; null when the patch edits nothing it keeps. */
  private async writerDraft(id: string, fields: Omit<LessonPatch, 'status' | 'supersedes'>): Promise<string | null> {
    if (!Object.values(fields).some((v) => v !== undefined)) return null;
    const [r] = await this.g.run('MATCH (l:Lesson {id: $id}) RETURN l', { id });
    const draft = r ? editedDraft(lessonOf(r.get('l').properties), fields) : null;
    if (draft) await archiveRedactionInput('lesson-draft', id, draft, redactDeep(draft));
    return draft ? JSON.stringify(redactDeep(draft)) : null;
  }

  async decidedLessons(q: DecidedLessonsQuery): Promise<DecidedLesson[]> {
    // vector.similarity.cosine is (1 + cos) / 2: the true cosine is 2 * score - 1.
    const rows = await this.g.run(
      `MATCH (l:Lesson) WHERE l.source = 'postmortem' AND l.status IN ['approved', 'rejected'] AND l.decidedAt IS NOT NULL
         AND l.decidedAt >= $since AND NOT coalesce(l.sandbox, false)
         AND coalesce(l.projectKey, l.originProjectKey) IS NOT NULL
         AND ($projectKeys IS NULL OR coalesce(l.projectKey, l.originProjectKey) IN $projectKeys)
         AND ${OWNER_DECIDED}
         AND ($outcome IS NULL OR ($outcome = 'rejected' AND l.status = 'rejected')
              OR ($outcome = 'edited' AND l.status = 'approved' AND l.proposedAs IS NOT NULL)
              OR ($outcome = 'unedited' AND l.status = 'approved' AND l.proposedAs IS NULL))
       WITH l ORDER BY l.decidedAt DESC, l.id DESC LIMIT $limit
       RETURN l, CASE WHEN $embedding IS NOT NULL AND l.embedding IS NOT NULL AND size(l.embedding) = size($embedding)
         THEN 2 * vector.similarity.cosine(l.embedding, $embedding) - 1 ELSE null END AS score`,
      { since: q.since, projectKeys: q.projectKeys, limit: neo4j.int(q.limit), embedding: q.embedding ?? null, outcome: q.outcome ?? null },
    );
    return rows.map((r) => ({ lesson: lessonOf(r.get('l').properties), score: r.get('score') ?? null }));
  }

  async setLessonPaths(id: string, paths: string[]): Promise<boolean> {
    const [r] = await this.g.run(`MATCH (l:Lesson {id: $id}) WHERE l.status = 'proposed' AND l.proposedAs IS NULL SET l.paths = $paths RETURN count(l) AS n`, { id, paths });
    return Number(r?.get('n') ?? 0) > 0;
  }

  async setLessonTriggers(id: string, triggers: LessonTriggers): Promise<boolean> {
    const [r] = await this.g.run(
      `MATCH (l:Lesson {id: $id}) WHERE l.triggers IS NULL AND l.status IN ['proposed', 'approved'] SET l.triggers = $triggers, l.triggersVersion = $version RETURN count(l) AS n`,
      { id, triggers: JSON.stringify(redactDeep(triggers)), version: neo4j.int(TRIGGER_DERIVATION_VERSION) },
    );
    return Number(r.get('n')) > 0;
  }

  async lessonsWithOldTriggers(version: number, limit: number): Promise<Lesson[]> {
    const rows = await this.g.run(
      `MATCH (l:Lesson) WHERE l.triggers IS NOT NULL AND NOT coalesce(l.triggersOwned, false) AND coalesce(l.triggersVersion, 1) < $version
         AND l.status IN ['proposed', 'approved'] AND NOT coalesce(l.sandbox, false)
       OPTIONAL MATCH (l)-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(t:Turn)
       RETURN l, ${FROM} AS fromKind ORDER BY l.createdAt, l.id LIMIT $limit`,
      { version: neo4j.int(version), limit: neo4j.int(limit) },
    );
    return rows.map((r) => lessonOf(r.get('l').properties, r.get('fromKind')));
  }

  async rederiveLessonTriggers(id: string, triggers: LessonTriggers, version: number): Promise<boolean> {
    const [r] = await this.g.run(
      `MATCH (l:Lesson {id: $id}) WHERE l.triggers IS NOT NULL AND NOT coalesce(l.triggersOwned, false) AND coalesce(l.triggersVersion, 1) < $version
         AND l.status IN ['proposed', 'approved']
       SET l.triggers = $triggers, l.triggersVersion = $version RETURN count(l) AS n`,
      { id, triggers: JSON.stringify(redactDeep(triggers)), version: neo4j.int(version) },
    );
    return Number(r.get('n')) > 0;
  }

  async lessonsWithoutTriggers(limit: number): Promise<Lesson[]> {
    const rows = await this.g.run(
      `MATCH (l:Lesson) WHERE l.triggers IS NULL AND l.status IN ['proposed', 'approved'] AND NOT coalesce(l.sandbox, false)
       OPTIONAL MATCH (l)-[:DERIVED_FROM]->(:Miss)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(t:Turn)
       RETURN l, ${FROM} AS fromKind ORDER BY l.createdAt, l.id LIMIT $limit`,
      { limit: neo4j.int(limit) },
    );
    return rows.map((r) => lessonOf(r.get('l').properties, r.get('fromKind')));
  }

  async clearMachineOwnerMarks(): Promise<string[]> {
    const rows = await this.g.run(
      `MATCH (l:Lesson) WHERE l.decidedByYou = true AND l.decidedBy IS NOT NULL AND NOT ${OWNER_DECIDED} AND l.proposedAs IS NULL
       SET l.decidedByYou = false
       RETURN l.id AS id ORDER BY id`,
    );
    return rows.map((r) => r.get('id') as string);
  }

  async setLessonChecks(id: string, checks: LessonCheck[], version = LESSON_CHECKS_VERSION): Promise<boolean> {
    const [r] = await this.g.run('MATCH (l:Lesson {id: $id}) SET l.checks = $checks, l.checksVersion = $version RETURN count(l) AS n', {
      id, checks: JSON.stringify(redactDeep(checks)), version: neo4j.int(version),
    });
    return Number(r?.get('n') ?? 0) > 0;
  }

  async searchLessons(q: { embedding: number[]; projectKey: string | null; k: number; status?: LessonStatus; projectKeys?: string[]; run?: string | null }): Promise<LessonHit[]> {
    const rows = await nearest(this.g, {
      index: 'lesson_embedding', label: 'Lesson', embedding: q.embedding, k: q.k,
      where: `node.status = $status AND NOT coalesce(node.checks CONTAINS '"name":"no-miss"', false) AND (node.projectKey IS NULL OR node.projectKey = $projectKey) AND ${LEARNED_IN('node')} AND ${await visibleToRun(this.g, 'node')}`,
      tail: 'RETURN node, score ORDER BY score DESC LIMIT $k',
      params: { projectKey: q.projectKey, status: q.status ?? 'approved', projectKeys: q.projectKeys ?? null, run: q.run ?? null },
    });
    return rows.map((r) => ({ lesson: lessonOf(r.get('node').properties), score: r.get('score') }));
  }

  async missesWithoutSubject(q: { limit: number; afterId?: string | null }): Promise<UnsortedMiss[]> {
    return this.missesBySubject(null, q);
  }

  async processMisses(q: { limit: number; afterId?: string | null }): Promise<UnsortedMiss[]> {
    return this.missesBySubject('process', q);
  }

  private async missesBySubject(subject: 'process' | null, q: { limit: number; afterId?: string | null }): Promise<UnsortedMiss[]> {
    const rows = await this.g.run(
      `MATCH (m:Miss)-[:EXPLAINS]->(f:Feedback)-[:FROM_TURN]->(t:Turn)
       WHERE (CASE WHEN $subject IS NULL THEN m.subject IS NULL ELSE m.subject = $subject END) AND ($afterId IS NULL OR m.id > $afterId)
       WITH m, f, t ORDER BY m.id LIMIT $limit
       OPTIONAL MATCH (l:Lesson)-[:DERIVED_FROM]->(m)
       WITH m, f, t, l ORDER BY l.id
       WITH m, f, t, head(collect(l)) AS l
       RETURN m.id AS id, m.projectKey AS projectKey, coalesce(t.text, f.text, '') AS text, t.external AS external, l.rule AS rule, l.paths AS paths
       ORDER BY id`,
      { subject, limit: neo4j.int(q.limit), afterId: q.afterId ?? null },
    );
    return rows.map((r) => {
      const ext = r.get('external') ? (JSON.parse(r.get('external')) as { path?: string | null }) : null;
      return { missId: r.get('id'), projectKey: r.get('projectKey'), feedbackText: r.get('text'), rule: r.get('rule') ?? null, commentPath: ext?.path ?? null, paths: (r.get('paths') as string[] | null) ?? [] };
    });
  }

  async setMissSubject(missId: string, subject: 'process' | null): Promise<boolean> {
    const [r] = await this.g.run(
      `MATCH (m:Miss {id: $id}) WHERE CASE WHEN $subject IS NULL THEN m.subject = 'process' ELSE m.subject IS NULL END
       SET m.subject = $subject RETURN count(m) AS n`,
      { id: missId, subject },
    );
    return Number(r?.get('n') ?? 0) > 0;
  }

  async relatedMisses(q: { embedding: number[]; projectKey: string | null; k: number; run?: string | null }): Promise<RelatedMiss[]> {
    const rows = await nearest(this.g, {
      index: 'miss_embedding', label: 'Miss', embedding: q.embedding, k: q.k,
      where: `($projectKey IS NULL OR node.projectKey = $projectKey) AND ${await visibleToRun(this.g, 'node')}`,
      tail: `WITH node, score ORDER BY score DESC LIMIT $k
       MATCH (node)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(t:Turn)
       RETURN node, t, score,
              EXISTS { MATCH (l:Lesson {status: 'rejected'})-[:DERIVED_FROM]->(node) WHERE l.checks CONTAINS '"name":"wrong-session"' } AS wrongSession
       ORDER BY score DESC`,
      params: { projectKey: q.projectKey, run: q.run ?? null },
    });
    return rows.map((r) => {
      const m = r.get('node').properties;
      const t = r.get('t').properties;
      return { missId: m.id, missed: m.missed, cause: m.cause, feedbackText: t.text, sessionId: t.sessionId, ts: t.ts, score: r.get('score'), rejectedWrongSession: r.get('wrongSession') === true };
    });
  }

  async missesNaming(q: { keys: string[]; embedding: number[]; projectKey: string; k: number; run?: string | null }): Promise<RelatedMiss[]> {
    if (!q.keys.some((key) => ISSUE_KEY_SHAPE.test(key)) || q.k <= 0) return [];
    const rows = await this.g.run(
      `MATCH (node:Miss {projectKey: $projectKey})-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(t:Turn)
       WHERE ${await visibleToRun(this.g, 'node')} AND (node.missed =~ $pattern OR t.text =~ $pattern)
       WITH node, t, CASE WHEN node.embedding IS NOT NULL AND size(node.embedding) = size($embedding) AND size($embedding) > 0
                          THEN vector.similarity.cosine(node.embedding, $embedding) ELSE 0.0 END AS score
       ORDER BY score DESC, node.id LIMIT $k
       RETURN node, t, score,
              EXISTS { MATCH (l:Lesson {status: 'rejected'})-[:DERIVED_FROM]->(node) WHERE l.checks CONTAINS '"name":"wrong-session"' } AS wrongSession`,
      { projectKey: q.projectKey, pattern: `(?is).*${issueKeyPattern(q.keys)}.*`, embedding: q.embedding, k: neo4j.int(q.k), run: q.run ?? null },
    );
    return rows.map((r) => {
      const m = r.get('node').properties;
      const t = r.get('t').properties;
      return { missId: m.id, missed: m.missed, cause: m.cause, feedbackText: t.text, sessionId: t.sessionId, ts: t.ts, score: r.get('score'), rejectedWrongSession: r.get('wrongSession') === true };
    });
  }

  /** The manual /postmortem path: queued for your decision, or added to the detector's item for the same miss. */
  async createManualFeedback(input: { project: Project; cwd: string; text: string; whatWasDone: string; sessionId?: string | null; run?: RunTag | null; embedding?: number[] | null }): Promise<string> {
    const embedding = input.embedding?.length ? input.embedding : null;
    const o = { ...input, text: redactDeep(input.text), whatWasDone: redactDeep(input.whatWasDone) };
    const now = new Date().toISOString();
    const report = JSON.stringify({ text: o.text, whatWasDone: o.whatWasDone, reportedAt: now, sessionId: o.sessionId ?? null });
    const flagged = await this.g.run(
      `MATCH (k:Candidate {projectKey: $key})-[:FLAGS]->(t:Turn)
       WHERE NOT coalesce(k.manual, false) AND k.agentReport IS NULL AND k.status <> 'rejected' AND t.ts IS NOT NULL
         AND t.external IS NULL
         AND datetime(t.ts) >= datetime($from) AND datetime(t.ts) <= datetime($to)
       RETURN k.id AS id, k.sessionId AS sessionId, t.ts AS ts, t.text AS text, k.dedupeEmbedding AS embedding`,
      {
        key: o.project.key,
        from: new Date(Date.parse(now) - reportWindowMs({ embedding })).toISOString(),
        to: new Date(Date.parse(now) + reportWindowMs({ embedding })).toISOString(),
      },
    );
    const hit = matchReport(
      { ts: now, text: o.text, sessionId: o.sessionId, embedding },
      flagged.map((r) => ({ id: r.get('id') as string, sessionId: r.get('sessionId') as string, ts: r.get('ts') as string, text: (r.get('text') as string) ?? '', embedding: (r.get('embedding') as number[] | null) ?? null })),
    );
    if (hit) {
      await this.g.run('MATCH (k:Candidate {id: $id}) SET k.agentReport = $report', { id: hit.id, report });
      return hit.id;
    }
    const id = `manual:${randomUUID()}`;
    this.g.sandbox.wrote(o.run);
    await this.g.run(
      `MERGE (p:Project {key: $project.key}) ON CREATE SET p.name = $project.name, p.repoPath = $project.repoPath
       CREATE (s:Session {id: $id, sourceFile: 'manual', cwd: $cwd, startedAt: $now, endedAt: $now, manual: true})-[:IN]->(p)
       CREATE (s)-[:HAS_TURN]->(t:Turn {uuid: $id, sessionId: $id, ts: $now, index: 1, text: $text,
              precedingAssistantText: $done, toolCalls: '[]', label: 'pushback', confidence: 1.0, summary: $text, signals: ['manual']})
       CREATE (k:Candidate {id: $id, turnUuid: $id, sessionId: $id, projectKey: p.key, ts: $now,
              status: 'pending', createdAt: $now, decidedAt: null, note: null, manual: true, agentReport: $report,
              run: $run, sandbox: $sandbox, dedupeEmbedding: $embedding})-[:FLAGS]->(t)`,
      { id, now, project: o.project, cwd: o.cwd, text: o.text, done: o.whatWasDone, report, run: o.run?.id ?? null, sandbox: !!o.run?.sandbox, embedding },
    );
    return id;
  }

  async recordPreDoneCheck(check: { projectKey: string; task: string; checkedLessonIds: string[]; gapLessonIds: string[]; status?: string; run?: RunTag | null; sessionId?: string | null }) {
    const { run, sessionId, ...c } = check;
    this.g.sandbox.wrote(run);
    await this.g.run(
      `CREATE (x:PreDoneCheck {id: $id, ts: $now, projectKey: $c.projectKey, task: $c.task,
                              checked: size($c.checkedLessonIds), gaps: size($c.gapLessonIds), run: $run, sandbox: $sandbox,
                              sessionId: $sessionId, status: $c.status})
       WITH x
       UNWIND $c.checkedLessonIds AS lid
         MATCH (l:Lesson {id: lid})
         MERGE (x)-[r:CHECKED]->(l) SET r.gap = lid IN $c.gapLessonIds`,
      { id: randomUUID(), now: new Date().toISOString(), c: { ...c, status: c.status ?? 'lesson_judged', task: redactSecrets(c.task) }, run: run?.id ?? null, sandbox: !!run?.sandbox, sessionId: sessionId ?? null },
    );
  }

  async redactStoredLessons(): Promise<{ redacted: number; flagged: number }> {
    let redacted = 0;
    let flagged = 0;
    for (let after = ''; ;) {
      const rows = await this.g.run(
        `MATCH (l:Lesson) WHERE l.id > $after
         RETURN l.id AS id, l.status AS status, l.title AS title, l.rule AS rule, l.appliesWhen AS appliesWhen, l.checks AS checks ORDER BY l.id LIMIT $page`,
        { after, page: neo4j.int(REDACT_PAGE) },
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].get('id');
      const page = rows.flatMap((r) => {
        const was = { title: (r.get('title') ?? '') as string, rule: (r.get('rule') ?? '') as string, appliesWhen: (r.get('appliesWhen') ?? null) as string | null };
        const checks = typeof r.get('checks') === 'string' ? (JSON.parse(r.get('checks')) as LessonCheck[]) : null;
        const x = redactStoredLesson({ status: r.get('status') as string, ...was, checks });
        if (!x) return [];
        if (x.flagged) flagged++;
        if (x.title !== was.title || x.rule !== was.rule || x.appliesWhen !== was.appliesWhen) redacted++;
        return [{ id: r.get('id') as string, title: x.title, rule: x.rule, appliesWhen: x.appliesWhen, checks: x.checks === null ? null : JSON.stringify(x.checks) }];
      });
      if (!page.length) continue;
      for (const r of rows) if (page.some(c => c.id === r.get('id'))) await archiveBeforeRedaction('lesson', String(r.get('id')), Object.fromEntries(['status', 'title', 'rule', 'appliesWhen', 'checks'].map(k => [k, r.get(k) ?? null])));
      await this.g.run('UNWIND $page AS c MATCH (l:Lesson {id: c.id}) SET l.title = c.title, l.rule = c.rule, l.appliesWhen = c.appliesWhen, l.checks = c.checks', { page });
    }
    return { redacted, flagged };
  }

  /** Feedback text, then what each miss missed and why. The words of the turn a miss quotes are the Inbox item's. */
  async redactStoredMisses(): Promise<number> {
    let changed = 0;
    for (const [label, fields] of [['Feedback', ['text']], ['Miss', ['missed', 'causeExplanation']]] as const) {
      for (let after = ''; ;) {
        const rows = await this.g.run(
          `MATCH (x:${label}) WHERE x.id > $after RETURN x.id AS id, ${fields.map((f) => `x.${f} AS ${f}`).join(', ')} ORDER BY x.id LIMIT $page`,
          { after, page: neo4j.int(REDACT_PAGE) },
        );
        if (!rows.length) break;
        after = rows[rows.length - 1].get('id');
        const page = rows.flatMap((r) => redactStoredRow(Object.fromEntries(['id', ...fields].map((k) => [k, r.get(k) ?? null])), fields) ?? []);
        if (!page.length) continue;
        await this.g.run(`UNWIND $page AS c MATCH (x:${label} {id: c.id}) SET ${fields.map((f) => `x.${f} = c.${f}`).join(', ')}`, { page });
        changed += page.length;
      }
    }
    return changed;
  }

  async saveDemoMiss(input: DemoMiss): Promise<string> {
    if (!input.id.startsWith(demoPrefix(input.project.key))) throw new Error(`a demo miss id starts with ${demoPrefix(input.project.key)}`);
    const m = { ...input, feedbackText: redactSecrets(input.feedbackText), whatWasDone: redactSecrets(input.whatWasDone), missed: redactSecrets(input.missed), causeExplanation: redactSecrets(input.causeExplanation) };
    const ts = new Date(m.ts).toISOString();
    const missId = `miss:${m.id}`;
    this.g.sandbox.wrote(m.run);
    await this.g.run(
      `MERGE (p:Project {key: $project.key}) ON CREATE SET p.name = $project.name, p.repoPath = $project.repoPath, p.demoCreated = true
       MERGE (s:Session {id: $id})
         ON CREATE SET s.sourceFile = 'demo', s.cwd = $project.repoPath, s.startedAt = $ts, s.endedAt = $ts, s.manual = true
       MERGE (s)-[:IN]->(p)
       MERGE (t:Turn {uuid: $id})
         ON CREATE SET t.sessionId = $id, t.ts = $ts, t.index = 1, t.toolCalls = '[]', t.label = 'pushback', t.confidence = 1.0, t.signals = ['demo']
       SET t.text = $text, t.precedingAssistantText = $done, t.summary = $text
       MERGE (s)-[:HAS_TURN]->(t)
       MERGE (k:Candidate {id: $id})
         ON CREATE SET k.turnUuid = $id, k.sessionId = $id, k.projectKey = p.key, k.ts = $ts, k.status = 'confirmed', k.createdAt = $ts,
                       k.decidedAt = $ts, k.decidedBy = 'demo', k.note = null, k.manual = true, k.run = $run, k.sandbox = $sandbox
       MERGE (k)-[:FLAGS]->(t)
       MERGE (f:Feedback {id: $id})
         ON CREATE SET f.status = 'addressed', f.createdAt = $ts, f.projectKey = p.key
       SET f.text = $text
       MERGE (f)-[:FROM_TURN]->(t)
       MERGE (x:Miss {id: $missId})
         ON CREATE SET x.outcome = 'addressed', x.createdAt = $ts, x.projectKey = p.key, x.run = $run, x.sandbox = $sandbox
       SET x.missed = $missed, x.cause = $cause, x.causeExplanation = $why, x.embedding = $embedding
       MERGE (x)-[:EXPLAINS]->(f)
       MERGE (c:Cause {key: $cause})
       MERGE (x)-[:CAUSED_BY]->(c)`,
      {
        project: { key: m.project.key, name: m.project.name ?? null, repoPath: m.project.repoPath ?? null }, id: m.id, ts, text: m.feedbackText, done: m.whatWasDone,
        missId, missed: m.missed, cause: m.cause, why: m.causeExplanation, embedding: m.embedding, run: m.run?.id ?? null, sandbox: m.run?.sandbox ? true : null,
      },
    );
    return missId;
  }

  async removeDemo(projectKey: string, run: RunTag | null = null): Promise<DemoRemoved> {
    const prefix = `${demoPrefix(projectKey)}${run ? `run:${run.id}:` : ""}`;
    const [misses] = await this.g.run(
      `MATCH (s:Session)-[:IN]->(:Project {key: $key}) WHERE s.id STARTS WITH $prefix AND s.manual
       OPTIONAL MATCH (s)-[:HAS_TURN]->(t:Turn)
       OPTIONAL MATCH (k:Candidate)-[:FLAGS]->(t)
       OPTIONAL MATCH (f:Feedback)-[:FROM_TURN]->(t)
       OPTIONAL MATCH (m:Miss)-[:EXPLAINS]->(f)
       OPTIONAL MATCH (s)-[:WORKED_ON]->(task:Task)
       WITH collect(DISTINCT s) + collect(DISTINCT t) + collect(DISTINCT k) + collect(DISTINCT f) + collect(DISTINCT task) AS rest,
            collect(DISTINCT m) AS ms
       FOREACH (n IN rest + ms | DETACH DELETE n)
       RETURN size(ms) AS n`,
      { key: projectKey, prefix },
    );
    const [lessons] = await this.g.run(
      `MATCH (l:Lesson {source: 'demo'}) WHERE (l.projectKey = $key OR (l.projectKey IS NULL AND l.originProjectKey = $key)) AND ($run IS NULL OR l.run = $run)
       WITH collect(l) AS ls FOREACH (l IN ls | DETACH DELETE l) RETURN size(ls) AS n`,
      { key: projectKey, run: run?.id ?? null },
    );
    const [facts] = await this.g.run(
      `MATCH (x:Fact {projectKey: $key, source: 'demo'}) WHERE $run IS NULL OR x.run = $run WITH collect(x) AS xs FOREACH (x IN xs | DETACH DELETE x) RETURN size(xs) AS n`,
      { key: projectKey, run: run?.id ?? null },
    );
    // The file nodes the demo added (hash DEMO_SOURCE: a scan that read the file since gave it a real one): unscanned
    // again, and gone unless the code map or other facts hold them.
    await this.g.run(
      `MATCH (cf:CodeFile {projectKey: $key, hash: $demo})
       WHERE NOT EXISTS { MATCH (:Fact {current: true})-[:ABOUT]->(cf) }
       REMOVE cf.hash, cf.summary, cf.scannedAt, cf.scanVersion, cf.hashChangedAt
       WITH cf WHERE NOT coalesce(cf.inMap, false) AND NOT coalesce(cf.inIndex, false) AND NOT EXISTS { MATCH (:Fact)-[:ABOUT]->(cf) }
       DETACH DELETE cf`,
      { key: projectKey, demo: DEMO_SOURCE },
    );
    // The project, when the seed created it (saveDemoMiss) and nothing at all refers to it now: no relationship, and
    // no node of any label (read from the database, so a label added later counts too) naming its key.
    // Every data label in use, each quoted (a backtick doubled), none left out: a guard is never dropped for its name.
    const labels = (await this.g.run('CALL db.labels() YIELD label RETURN label')).map((r) => r.get('label') as string).filter((l) => !NOT_DATA.has(l));
    const [project] = await this.g.run(
      `MATCH (p:Project {key: $key}) WHERE coalesce(p.demoCreated, false) AND NOT coalesce(p.pinned, false) AND size(coalesce(p.aliases, [])) = 0
         AND NOT (p)--()
         AND NOT EXISTS { MATCH (l:ProjectLink) WHERE l.a = $key OR l.b = $key }
         AND NOT EXISTS { MATCH (s:ProjectSelection) WHERE $key IN coalesce(s.tracked, []) }
         ${labels.map((label) => `AND NOT EXISTS { MATCH (x:\`${label.replaceAll('`', '``')}\`) WHERE x.projectKey = $key OR x.originProjectKey = $key }`).join('\n         ')}
       WITH collect(p) AS ps FOREACH (p IN ps | DELETE p) RETURN size(ps) AS n`,
      { key: projectKey, run: run?.id ?? null },
    );
    const count = (r: { get(k: string): unknown } | undefined) => {
      const v = r?.get('n');
      return neo4j.isInt(v) ? v.toNumber() : Number(v ?? 0);
    };
    return { lessons: count(lessons), misses: count(misses), facts: count(facts), projectRemoved: count(project) > 0 };
  }

  async upsertLesson(input: LessonInput) {
    const l = redactDeep(input);
    await archiveRedactionInput('lesson', input.id, input, l);
    const now = new Date().toISOString();
    this.g.sandbox.wrote(input.run);
    await this.g.run(
      `MERGE (l:Lesson {id: $l.id})
         ON CREATE SET l.createdAt = $now, l.status = $l.status, l.decidedAt = CASE WHEN $l.status = 'proposed' THEN null ELSE $now END, l.source = $l.source,
                       l.projectKey = $l.projectKey, l.originProjectKey = $l.projectKey, l.run = $run, l.sandbox = $sandbox
       // Once you have decided on or edited a lesson, re-importing its file never overrides you.
       WITH l, coalesce(l.decidedByYou, false) AS yours
       FOREACH (_ IN CASE WHEN yours THEN [] ELSE [1] END |
         SET l.title = $l.title, l.rule = $l.rule, l.appliesWhen = $l.appliesWhen, l.scope = $l.scope, l.paths = $l.paths,
             l.embedding = $l.embedding, l.checks = CASE WHEN $checks IS NULL THEN l.checks ELSE $checks END,
             l.triggers = CASE WHEN $triggers IS NULL THEN l.triggers ELSE $triggers END)
       WITH l WHERE $l.projectKey IS NOT NULL
       MERGE (p:Project {key: $l.projectKey})
       MERGE (l)-[:APPLIES_TO]->(p)`,
      { l: { ...l, triggers: undefined }, now, checks: l.checks == null ? null : JSON.stringify(l.checks), triggers: l.triggers ? JSON.stringify(l.triggers) : null, run: input.run?.id ?? null, sandbox: input.run?.sandbox ? true : null },
    );
  }
}

/** Labels that name a project by key but are not data under it: the project itself, and the log (the seed logs there). */
const NOT_DATA = new Set(['Project', 'Activity']);

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
/** ownerDecided over a lesson `l`'s decidedBy. */
const OWNER_DECIDED = `(l.decidedBy IS NULL OR l.decidedBy IN ['you', 'operator'] OR l.decidedBy STARTS WITH 'operator:')`;
const LEARNED_IN = (v: string) => `($projectKeys IS NULL OR coalesce(${v}.projectKey, ${v}.originProjectKey) IS NULL OR coalesce(${v}.projectKey, ${v}.originProjectKey) IN $projectKeys)`;

/**
 * Lesson.from, for a lesson `l` and its feedback's turn `t` (null for memory and manual lessons). The turn's external
 * ref is JSON text: its source key says GitHub or Linear. A report_feedback turn's uuid starts with `manual:`.
 */
const FROM = `CASE WHEN l.source IN ['memory', 'manual', 'demo'] THEN l.source
  WHEN t.external IS NOT NULL AND t.external CONTAINS '"source":"linear"' THEN 'linear'
  WHEN t.external IS NOT NULL THEN 'github' WHEN t.uuid STARTS WITH 'manual:' THEN 'agent' ELSE 'session' END`;

function lessonOf(p: Record<string, unknown>, from?: LessonFrom | null): Lesson {
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
    decisionNote: (p.decisionNote as string) ?? null,
    checks: typeof p.checks === 'string' ? (JSON.parse(p.checks) as LessonCheck[]) : null,
    checksVersion: p.checksVersion == null ? null : Number(p.checksVersion),
    ...(from && { from }),
    ...(typeof p.run === 'string' && { run: p.run }),
    ...(p.sandbox === true && { sandbox: true as const }),
    ...(typeof p.proposedAs === 'string' && { proposedAs: JSON.parse(p.proposedAs) as LessonDraft }),
    ...(typeof p.triggers === 'string' && { triggers: JSON.parse(p.triggers) as LessonTriggers }),
    ...(typeof p.servingWeight === 'number' && { servingWeight: p.servingWeight }),
    ...(typeof p.splitFrom === 'string' && { splitFrom: p.splitFrom }),
  };
}
