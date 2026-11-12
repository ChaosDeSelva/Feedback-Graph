import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { TargetChangedError } from '../decisions/record.ts';
import {
  AliasTakenError, aliasNorm, answerClaimIdOf, answerSourceOf, addedQuestionIdOf, claimFingerprint, claimIdOf, cleanClaimDraft, cleanConflictInput,
  cleanQuestionDraft, cleanResolution, conflictFingerprint, conflictIdOf, FORGOTTEN_NAME, questionIdOf,
  type AnswerInput, type ClaimFilter, type ClaimHit, type ClaimPatch, type ClaimSearch, type ConflictFilter, type IntakeRedacted, type IntakeRemoved, type IntakeRunItem,
  type IntakeSnapshotWrite, type PersonPatch, type QuestionFilter, type QuestionPatch, type WindowSave,
} from '../intake/records.ts';
import { archiveBeforeRedaction } from '../redactionArchive.ts';
import { REDACT_PAGE, redactIntakeText, redactSecrets, redactStoredIntake as redactStoredRow } from '../redact.ts';
import type { IntakeStore } from '../store.ts';
import type {
  Claim, ClaimLink, ClaimLinkRel, Conflict, ConflictInput, ConflictSide, ConflictSideKind, IntakeMeta, IntakeMetaInput, Person, Question,
  QuestionDraft, RunTag, Supersession,
} from '../types.ts';
import { conditionalWrite } from './conditionalWrite.ts';
import { nearest } from './nearest.ts';
import { retryDeadlock, type GraphRepo } from './repo.ts';
import { VISIBLE_TO_RUN } from './runs.ts';

type Props = Record<string, unknown>;
type Query = GraphRepo['run'];

/** The node label of each kind a conflict, supersession or claim link names (a fixed list: safe in Cypher text). */
const LABEL: Record<ConflictSideKind, string> = { claim: 'Claim', fact: 'Fact', lesson: 'Lesson' };
const REL: Record<ClaimLinkRel, string> = { refines: 'REFINES', corroborates: 'CORROBORATES' };
const KIND_OF = (v: string) => `CASE WHEN ${v}:Claim THEN 'claim' WHEN ${v}:Fact THEN 'fact' ELSE 'lesson' END`;
const UNDECIDED = ['proposed', 'rejected'];
const UNANSWERED = ['open', 'assigned', 'dismissed'];
const DEFAULT_LIMIT = 100;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const json = <T>(v: unknown, empty: T): T => (typeof v === 'string' ? (JSON.parse(v) as T) : empty);
const page = (f: { limit?: number; offset?: number }) => ({ limit: neo4j.int(Math.max(0, Math.floor(f.limit ?? DEFAULT_LIMIT))), offset: neo4j.int(Math.max(0, Math.floor(f.offset ?? 0))) });

export const claimOf = (p: Props): Claim => ({
  id: String(p.id), projectKey: str(p.projectKey), docId: String(p.docId), window: num(p.window),
  span: p.spanUtt === null || p.spanUtt === undefined ? null : { utt: Number(p.spanUtt), start: Number(p.spanStart), end: Number(p.spanEnd) },
  type: p.type as Claim['type'], statement: String(p.statement), quote: String(p.quote ?? ''), speakerId: str(p.speakerId), assertedAt: str(p.assertedAt),
  confidence: Number(p.confidence ?? 0), scope: { area: str(p.scopeArea), files: (p.scopeFiles as string[] | undefined) ?? [] }, about: String(p.about ?? ''),
  due: str(p.due), flags: (p.flags as Claim['flags'] | undefined) ?? [], status: p.status as Claim['status'], decidedBy: str(p.decidedBy),
  decidedAt: str(p.decidedAt), factId: str(p.factId), createdAt: String(p.createdAt), run: str(p.run), sandbox: p.sandbox === true,
});

const questionOf = (p: Props): Question => ({
  id: String(p.id), projectKey: str(p.projectKey), docId: String(p.docId), window: num(p.window), text: String(p.text), kind: p.kind as Question['kind'],
  quote: str(p.quote), askedBy: str(p.askedBy), assignee: str(p.assignee), status: p.status as Question['status'], answerClaimId: str(p.answerClaimId),
  decidedBy: str(p.decidedBy), decidedAt: str(p.decidedAt), createdAt: String(p.createdAt), run: str(p.run), sandbox: p.sandbox === true,
});

const sideOf = (p: Props, role: 'a' | 'b'): ConflictSide => ({
  kind: p[`${role}Kind`] as ConflictSideKind, id: String(p[`${role}Id`]), fingerprint: String(p[`${role}Fingerprint`]), assertedAt: str(p[`${role}AssertedAt`]),
});
const conflictOf = (p: Props): Conflict => ({
  id: String(p.id), kind: p.kind as Conflict['kind'], status: p.status as Conflict['status'], projectKey: str(p.projectKey), a: sideOf(p, 'a'), b: sideOf(p, 'b'),
  signals: json(p.signals, []), judge: json(p.judge, null), resolution: json(p.resolution, null), decisionId: str(p.decisionId), createdAt: String(p.createdAt),
  resolvedAt: str(p.resolvedAt), resolvedBy: str(p.resolvedBy), run: str(p.run), sandbox: p.sandbox === true,
});

const personOf = (p: Props, aliases: string[], claims: number): Person => ({
  id: String(p.id), displayName: String(p.displayName), isOwner: p.isOwner === true, status: p.status as Person['status'],
  aliases: [...aliases].sort(), claims: Number(claims), createdAt: String(p.createdAt),
});

/** A claim's stored properties. */
const claimProps = (c: Pick<Claim, 'type' | 'statement' | 'quote' | 'speakerId' | 'span' | 'assertedAt' | 'confidence' | 'scope' | 'about' | 'due' | 'flags'> & { embedding: number[] | null }) => ({
  type: c.type, statement: c.statement, quote: c.quote, speakerId: c.speakerId, spanUtt: c.span?.utt ?? null, spanStart: c.span?.start ?? null,
  spanEnd: c.span?.end ?? null, assertedAt: c.assertedAt, confidence: c.confidence, scopeArea: c.scope.area, scopeFiles: c.scope.files, about: c.about,
  due: c.due, flags: c.flags, embedding: c.embedding,
});
const conflictProps = (c: ConflictInput) => ({
  kind: c.kind, projectKey: c.projectKey, signals: JSON.stringify(c.signals), judge: c.judge === null ? null : JSON.stringify(c.judge),
  ...Object.fromEntries((['a', 'b'] as const).flatMap((r) => [[`${r}Kind`, c[r].kind], [`${r}Id`, c[r].id], [`${r}Fingerprint`, c[r].fingerprint], [`${r}AssertedAt`, c[r].assertedAt]])),
});

/**
 * The edges a claim's properties name, made again from them: its speaker (SAID), its source (FROM, with the span),
 * the fact accepting it made (BECAME). Missing ends are skipped.
 */
async function relinkClaims(query: Query, ids: string[]) {
  if (!ids.length) return;
  await query(
    `UNWIND $ids AS id MATCH (c:Claim {id: id})
     OPTIONAL MATCH (c)-[old:BECAME|FROM]->() DELETE old
     WITH DISTINCT c OPTIONAL MATCH ()-[said:SAID]->(c) DELETE said
     WITH DISTINCT c OPTIONAL MATCH (p:Person {id: c.speakerId})
     FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | MERGE (p)-[:SAID]->(c))
     WITH DISTINCT c OPTIONAL MATCH (d:Doc {id: c.docId})
     FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END | MERGE (c)-[r:FROM]->(d) SET r.utt = c.spanUtt, r.start = c.spanStart, r.end = c.spanEnd)
     WITH DISTINCT c OPTIONAL MATCH (f:Fact {id: c.factId})
     FOREACH (_ IN CASE WHEN f IS NULL THEN [] ELSE [1] END | MERGE (c)-[:BECAME]->(f))`,
    { ids },
  );
}

/** A question's edges the same way: FROM its source, ASKED_BY, ASSIGNED_TO, ANSWERED_BY. */
async function relinkQuestions(query: Query, ids: string[]) {
  if (!ids.length) return;
  await query(
    `UNWIND $ids AS id MATCH (q:Question {id: id})
     OPTIONAL MATCH (q)-[old:FROM|ASKED_BY|ASSIGNED_TO|ANSWERED_BY]->() DELETE old
     WITH DISTINCT q OPTIONAL MATCH (d:Doc {id: q.docId})
     FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END | MERGE (q)-[:FROM]->(d))
     WITH DISTINCT q OPTIONAL MATCH (a:Person {id: q.askedBy})
     FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | MERGE (q)-[:ASKED_BY]->(a))
     WITH DISTINCT q OPTIONAL MATCH (s:Person {id: q.assignee})
     FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | MERGE (q)-[:ASSIGNED_TO]->(s))
     WITH DISTINCT q OPTIONAL MATCH (c:Claim {id: q.answerClaimId})
     FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END | MERGE (q)-[:ANSWERED_BY]->(c))`,
    { ids },
  );
}

/** A conflict's SIDE edges, made again from its properties. */
async function relinkConflict(query: Query, c: ConflictInput, id: string) {
  await query('MATCH (c:Conflict {id: $id})-[r:SIDE]->() DELETE r', { id });
  for (const role of ['a', 'b'] as const) {
    await query(`MATCH (c:Conflict {id: $id}), (n:${LABEL[c[role].kind]} {id: $ref}) MERGE (c)-[r:SIDE {role: $role}]->(n)`, { id, ref: c[role].id, role });
  }
}

const PERSON_RETURN = `OPTIONAL MATCH (p)-[:ALIAS]->(a:PersonAlias)
  WITH p, collect(a.norm) AS aliases
  RETURN p, aliases, COUNT { (p)-[:SAID]->(:Claim) } AS claims`;

/**
 * Knowledge intake on Neo4j. A source's details are properties of its Doc (intakeKind, format, occurredAt, origin,
 * private, windowsDone, windowsTotal, windowsVersion), with (Person)-[:ATTENDED]->(Doc). Claims, questions, people
 * and conflicts are nodes; a person's aliases are (Person)-[:ALIAS]->(:PersonAlias {norm}) nodes, unique, so two
 * speakers resolving the same new name at once make one person. Scopes, signals, judge and resolution are JSON or
 * flat properties.
 */
export class IntakeRepo implements IntakeStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  private write<T>(fn: (query: Query) => Promise<T>, changed: (r: T) => boolean = () => true): Promise<T> {
    return retryDeadlock(() => conditionalWrite(this.g, fn, changed));
  }

  async upsertMeta(meta: IntakeMetaInput): Promise<boolean> {
    return this.write(async (query) => {
      const [d] = await query(
        `MATCH (d:Doc {id: $id})
         SET d.intakeKind = $m.kind, d.intakeFormat = $m.format, d.occurredAt = $m.occurredAt, d.origin = $origin, d.private = $m.private,
             d.windowsDone = coalesce(d.windowsDone, 0)
         WITH d OPTIONAL MATCH (:Person)-[r:ATTENDED]->(d) DELETE r
         WITH DISTINCT d UNWIND (CASE WHEN size($people) = 0 THEN [null] ELSE $people END) AS pid
         OPTIONAL MATCH (p:Person {id: pid})
         FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | MERGE (p)-[:ATTENDED]->(d))
         RETURN DISTINCT d.id AS id`,
        { id: meta.docId, m: meta, origin: meta.origin === null ? null : redactIntakeText(meta.origin), people: meta.participants },
      );
      return !!d;
    }, (ok) => ok);
  }

  async metas(docIds: string[]): Promise<IntakeMeta[]> {
    if (!docIds.length) return [];
    const rows = await this.g.run(
      `MATCH (d:Doc) WHERE d.id IN $ids AND d.intakeKind IS NOT NULL
       OPTIONAL MATCH (p:Person)-[:ATTENDED]->(d)
       WITH d, p ORDER BY p.id
       RETURN d, collect(p.id) AS people`,
      { ids: docIds },
    );
    return rows.map((r) => {
      const d = r.get('d').properties;
      const current = d.windowsVersion === d.addedAt;
      return {
        docId: d.id, kind: d.intakeKind, format: d.intakeFormat, occurredAt: str(d.occurredAt), origin: str(d.origin), private: d.private === true,
        participants: r.get('people'), windowsDone: current ? Number(d.windowsDone ?? 0) : 0, windowsTotal: current ? num(d.windowsTotal) : null,
      };
    });
  }

  async nextWindow(docId: string): Promise<{ window: number; version: string } | null> {
    const [r] = await this.g.run('MATCH (d:Doc {id: $docId}) WHERE d.intakeKind IS NOT NULL RETURN d', { docId });
    if (!r) return null;
    const d = r.get('d').properties;
    return { window: d.windowsVersion === d.addedAt ? Number(d.windowsDone ?? 0) : 0, version: String(d.addedAt) };
  }

  async saveWindow(docId: string, w: WindowSave): Promise<boolean> {
    const claims = w.claims.map(cleanClaimDraft).map((c, n) => ({ id: claimIdOf(docId, w.version, w.window, n), props: claimProps(c) }));
    const questions = w.questions.map(cleanQuestionDraft).map((q, n) => ({ id: questionIdOf(docId, w.version, w.window, n), props: { text: q.text, kind: q.kind, quote: q.quote, askedBy: q.askedBy } }));
    return this.write(async (query) => {
      // The Doc's lock orders this against another save of the same source and a new upload of it.
      const [r] = await query('MATCH (d:Doc {id: $docId}) WHERE d.intakeKind IS NOT NULL SET d._lock = coalesce(d._lock, 0) + 1 REMOVE d._lock RETURN d', { docId });
      if (!r) return false;
      const d = r.get('d').properties;
      if (d.addedAt !== w.version) return false;
      const now = new Date().toISOString();
      if (d.windowsVersion !== w.version) {
        // The first save of a new upload: the old upload's undecided records go.
        await query(`MATCH (c:Claim {docId: $docId}) WHERE c.window IS NOT NULL AND c.status IN $undecided DETACH DELETE c`, { docId, undecided: UNDECIDED });
        await query(`MATCH (q:Question {docId: $docId}) WHERE q.window IS NOT NULL AND q.status IN $unanswered DETACH DELETE q`, { docId, unanswered: UNANSWERED });
        await query('MATCH (d:Doc {id: $docId}) SET d.windowsDone = 0, d.windowsVersion = $version, d.windowsTotal = null', { docId, version: w.version });
      }
      const base = { docId, window: w.window, version: w.version, projectKey: d.projectKey ?? null, run: d.run ?? null, sandbox: d.sandbox === true };
      await query(
        `UNWIND $claims AS c MERGE (x:Claim {id: c.id})
         ON CREATE SET x += c.props, x += $base, x.status = 'proposed', x.createdAt = $now, x._fresh = true
         FOREACH (_ IN CASE WHEN x.status = 'proposed' AND x._fresh IS NULL THEN [1] ELSE [] END | SET x += c.props)
         REMOVE x._fresh`,
        { claims, base, now },
      );
      await query(
        `MATCH (x:Claim {docId: $docId}) WHERE x.window = $window AND x.version = $version AND x.status = 'proposed' AND NOT x.id IN $ids DETACH DELETE x`,
        { docId, window: w.window, version: w.version, ids: claims.map((c) => c.id) },
      );
      await query(
        `UNWIND $questions AS q MERGE (x:Question {id: q.id})
         ON CREATE SET x += q.props, x += $base, x.status = 'open', x.createdAt = $now, x._fresh = true
         FOREACH (_ IN CASE WHEN x.status = 'open' AND x._fresh IS NULL THEN [1] ELSE [] END | SET x += q.props)
         REMOVE x._fresh`,
        { questions, base, now },
      );
      await query(
        `MATCH (x:Question {docId: $docId}) WHERE x.window = $window AND x.version = $version AND x.status = 'open' AND NOT x.id IN $ids DETACH DELETE x`,
        { docId, window: w.window, version: w.version, ids: questions.map((q) => q.id) },
      );
      await relinkClaims(query, claims.map((c) => c.id));
      await relinkQuestions(query, questions.map((q) => q.id));
      await query(
        `MATCH (d:Doc {id: $docId})
         SET d.windowsDone = CASE WHEN coalesce(d.windowsDone, 0) > $next THEN d.windowsDone ELSE $next END, d.windowsTotal = coalesce($total, d.windowsTotal)`,
        { docId, next: w.window + 1, total: w.total ?? null },
      );
      return true;
    }, (ok) => ok);
  }

  async removeSource(docId: string, o: { keep?: string[] } = {}): Promise<{ claim: number; question: number }> {
    return this.write(async (query) => {
      const [c] = await query(`MATCH (x:Claim {docId: $docId}) WHERE x.status IN $undecided AND NOT x.id IN $keep DETACH DELETE x RETURN count(*) AS n`, { docId, undecided: UNDECIDED, keep: o.keep ?? [] });
      const [q] = await query(`MATCH (x:Question {docId: $docId}) DETACH DELETE x RETURN count(*) AS n`, { docId });
      await query(
        `MATCH (d:Doc {id: $docId}) OPTIONAL MATCH (:Person)-[r:ATTENDED]->(d) DELETE r
         WITH DISTINCT d REMOVE d.intakeKind, d.intakeFormat, d.occurredAt, d.origin, d.private, d.windowsDone, d.windowsTotal, d.windowsVersion`,
        { docId },
      );
      return { claim: Number(c.get('n')), question: Number(q.get('n')) };
    });
  }

  async listClaims(f: ClaimFilter = {}): Promise<Claim[]> {
    const rows = await this.g.run(
      `MATCH (x:Claim)
       WHERE ($ids IS NULL OR x.id IN $ids) AND ($status IS NULL OR x.status IN $status) AND ($type IS NULL OR x.type IN $type)
         AND ($keys IS NULL OR x.projectKey IS NULL OR x.projectKey IN $keys) AND ($docId IS NULL OR x.docId = $docId)
         AND ($speaker IS NULL OR x.speakerId = $speaker) AND ${VISIBLE_TO_RUN('x')}
       RETURN x ORDER BY x.createdAt DESC, x.id SKIP $offset LIMIT $limit`,
      { ids: f.ids ?? null, status: f.status ?? null, type: f.type ?? null, keys: f.projectKeys ?? null, docId: f.docId ?? null, speaker: f.speakerId ?? null, run: f.run ?? null, ...page(f) },
    );
    return rows.map((r) => claimOf(r.get('x').properties));
  }

  async claim(id: string): Promise<Claim | null> {
    const [r] = await this.g.run('MATCH (x:Claim {id: $id}) RETURN x', { id });
    return r ? claimOf(r.get('x').properties) : null;
  }

  async decideClaim(id: string, patch: ClaimPatch, o: { by: string; expect?: string }): Promise<Claim | null> {
    const changed = await this.write(async (query) => {
      const [r] = await query('MATCH (x:Claim {id: $id}) SET x._lock = coalesce(x._lock, 0) + 1 REMOVE x._lock RETURN x', { id });
      if (!r) return false;
      const cur = claimOf(r.get('x').properties);
      if (o.expect !== undefined && claimFingerprint(cur) !== o.expect) throw new TargetChangedError(id, o.expect, claimFingerprint(cur));
      const set: Props = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.statement !== undefined) set.statement = redactIntakeText(patch.statement);
      if (patch.type !== undefined) set.type = patch.type;
      if (patch.about !== undefined) set.about = redactIntakeText(patch.about);
      if (patch.factId !== undefined) set.factId = patch.factId;
      if (patch.embedding !== undefined) set.embedding = patch.embedding;
      if (patch.scope !== undefined) Object.assign(set, { scopeArea: patch.scope.area === null ? null : redactIntakeText(patch.scope.area), scopeFiles: patch.scope.files.map(redactSecrets) });
      if (patch.status !== undefined && patch.status !== cur.status) Object.assign(set, { decidedBy: o.by, decidedAt: new Date().toISOString() });
      await query('MATCH (x:Claim {id: $id}) SET x += $set', { id, set });
      await relinkClaims(query, [id]);
      return true;
    }, (ok) => ok);
    return changed ? this.claim(id) : null;
  }

  async searchClaims(q: ClaimSearch): Promise<ClaimHit[]> {
    const rows = await nearest(this.g, {
      index: 'claim_embedding', label: 'Claim', embedding: q.embedding, k: q.k,
      where: `node.status IN $status AND ($type IS NULL OR node.type IN $type) AND ($keys IS NULL OR node.projectKey IS NULL OR node.projectKey IN $keys)
        AND ($speaker IS NULL OR node.speakerId = $speaker) AND ${VISIBLE_TO_RUN('node')}`,
      tail: 'RETURN node, score ORDER BY score DESC, node.id LIMIT $k',
      params: { status: q.status ?? ['accepted'], type: q.type ?? null, keys: q.projectKeys ?? null, speaker: q.speakerId ?? null, run: q.run ?? null },
    });
    return rows.map((r) => ({ claim: claimOf(r.get('node').properties), score: r.get('score') }));
  }

  async addLinks(links: ClaimLink[]): Promise<number> {
    if (!links.length) return 0;
    return this.write(async (query) => {
      let added = 0;
      const now = new Date().toISOString();
      for (const l of links) {
        const [r] = await query(
          `MATCH (a:Claim {id: $from}), (b:${LABEL[l.to.kind]} {id: $to})
           MERGE (a)-[r:${REL[l.rel]}]->(b) ON CREATE SET r.createdAt = $now, r._fresh = true
           WITH r, r._fresh IS NOT NULL AS fresh REMOVE r._fresh RETURN fresh`,
          { from: l.from, to: l.to.id, now },
        );
        if (r?.get('fresh')) added++;
      }
      return added;
    }, (n) => n > 0);
  }

  async links(ids: string[]): Promise<ClaimLink[]> {
    if (!ids.length) return [];
    const rows = await this.g.run(
      `MATCH (a:Claim)-[r:REFINES|CORROBORATES]->(b) WHERE a.id IN $ids OR b.id IN $ids
       RETURN a.id AS from, toLower(type(r)) AS rel, ${KIND_OF('b')} AS kind, b.id AS to ORDER BY from, kind, to, rel`,
      { ids },
    );
    return rows.map((r) => ({ from: r.get('from'), to: { kind: r.get('kind'), id: r.get('to') }, rel: r.get('rel') }));
  }

  async people(f: { status?: Person['status'][] } = {}): Promise<Person[]> {
    const rows = await this.g.run(
      `MATCH (p:Person) WHERE $status IS NULL OR p.status IN $status ${PERSON_RETURN} ORDER BY p.isOwner DESC, p.displayName, p.id`,
      { status: f.status ?? null },
    );
    return rows.map((r) => personOf(r.get('p').properties, r.get('aliases'), r.get('claims')));
  }

  async person(id: string): Promise<Person | null> {
    const [r] = await this.g.run(`MATCH (p:Person {id: $id}) ${PERSON_RETURN}`, { id });
    return r ? personOf(r.get('p').properties, r.get('aliases'), r.get('claims')) : null;
  }

  async ensureOwner(displayName: string): Promise<Person> {
    const norm = aliasNorm(displayName);
    const id = await this.write(async (query) => {
      const [r] = await query('MATCH (p:Person {isOwner: true}) RETURN p.id AS id LIMIT 1');
      if (r) return null;
      // One owner however many start at once: a fixed id, merged.
      await query(
        `MERGE (p:Person {id: 'person:owner'}) ON CREATE SET p.displayName = $name, p.isOwner = true, p.status = 'confirmed', p.createdAt = $now`,
        { name: displayName, now: new Date().toISOString() },
      );
      if (norm) {
        await query(
          `MATCH (p:Person {id: 'person:owner'}) MERGE (a:PersonAlias {norm: $norm})
           WITH p, a WHERE NOT EXISTS { MATCH (:Person)-[:ALIAS]->(a) } MERGE (p)-[:ALIAS]->(a)`,
          { norm },
        );
      }
      return 'person:owner';
    }, (made) => made !== null);
    const [r] = await this.g.run('MATCH (p:Person {isOwner: true}) RETURN p.id AS id LIMIT 1');
    return (await this.person(id ?? r.get('id')))!;
  }

  async resolveAlias(name: string, o: { create?: boolean } = {}): Promise<{ person: Person; created: boolean } | null> {
    const norm = aliasNorm(name);
    if (!norm) return null;
    const [found] = await this.g.run('MATCH (p:Person)-[:ALIAS]->(:PersonAlias {norm: $norm}) RETURN p.id AS id', { norm });
    if (found) return { person: (await this.person(found.get('id')))!, created: false };
    if (!o.create) return null;
    const made = await this.write(async (query) => {
      // The alias first: two resolving the same new name wait on its unique key, and the second finds the person.
      await query('MERGE (a:PersonAlias {norm: $norm}) SET a._lock = coalesce(a._lock, 0) + 1 REMOVE a._lock', { norm });
      const [r] = await query('MATCH (p:Person)-[:ALIAS]->(:PersonAlias {norm: $norm}) RETURN p.id AS id', { norm });
      if (r) return { id: r.get('id') as string, created: false };
      const id = `person:${randomUUID()}`;
      await query(
        `MATCH (a:PersonAlias {norm: $norm})
         CREATE (p:Person {id: $id, displayName: $name, isOwner: false, status: 'proposed', createdAt: $now})-[:ALIAS]->(a)`,
        { norm, id, name: redactIntakeText(name.trim()), now: new Date().toISOString() },
      );
      return { id, created: true };
    });
    return { person: (await this.person(made.id))!, created: made.created };
  }

  async updatePerson(id: string, patch: PersonPatch): Promise<Person | null> {
    const ok = await this.write(async (query) => {
      const [r] = await query('MATCH (p:Person {id: $id}) SET p._lock = coalesce(p._lock, 0) + 1 REMOVE p._lock RETURN p', { id });
      if (!r) return false;
      if (patch.displayName !== undefined) await query('MATCH (p:Person {id: $id}) SET p.displayName = $name', { id, name: redactIntakeText(patch.displayName.trim()) });
      if (patch.status !== undefined) await query('MATCH (p:Person {id: $id}) SET p.status = $status', { id, status: patch.status });
      for (const norm of (patch.removeAliases ?? []).map(aliasNorm).filter(Boolean)) {
        await query('MATCH (:Person {id: $id})-[:ALIAS]->(a:PersonAlias {norm: $norm}) DETACH DELETE a', { id, norm });
      }
      for (const norm of (patch.addAliases ?? []).map(aliasNorm).filter(Boolean)) {
        const [held] = await query('MERGE (a:PersonAlias {norm: $norm}) WITH a OPTIONAL MATCH (o:Person)-[:ALIAS]->(a) RETURN o.id AS owner', { norm });
        const owner = held?.get('owner') ?? null;
        if (owner !== null && owner !== id) throw new AliasTakenError(norm, owner);
        await query('MATCH (p:Person {id: $id}), (a:PersonAlias {norm: $norm}) MERGE (p)-[:ALIAS]->(a)', { id, norm });
      }
      return true;
    }, (done) => done);
    return ok ? this.person(id) : null;
  }

  async mergePeople(keepId: string, mergedId: string): Promise<Person | null> {
    if (keepId === mergedId) throw new Error('a person cannot be merged into itself');
    const ok = await this.write(async (query) => {
      const rows = await query('MATCH (p:Person) WHERE p.id IN [$keep, $merged] SET p._lock = coalesce(p._lock, 0) + 1 REMOVE p._lock RETURN p', { keep: keepId, merged: mergedId });
      if (rows.length < 2) return false;
      if (rows.some((r) => r.get('p').properties.id === mergedId && r.get('p').properties.isOwner === true)) throw new Error('the owner cannot be merged into someone else');
      const params = { keep: keepId, merged: mergedId };
      await query('MATCH (m:Person {id: $merged})-[r:ALIAS]->(a), (k:Person {id: $keep}) DELETE r MERGE (k)-[:ALIAS]->(a)', params);
      await query('MATCH (m:Person {id: $merged})-[r:SAID]->(c:Claim), (k:Person {id: $keep}) DELETE r SET c.speakerId = $keep MERGE (k)-[:SAID]->(c)', params);
      await query('MATCH (q:Question)-[r:ASKED_BY]->(m:Person {id: $merged}), (k:Person {id: $keep}) DELETE r SET q.askedBy = $keep MERGE (q)-[:ASKED_BY]->(k)', params);
      await query('MATCH (q:Question)-[r:ASSIGNED_TO]->(m:Person {id: $merged}), (k:Person {id: $keep}) DELETE r SET q.assignee = $keep MERGE (q)-[:ASSIGNED_TO]->(k)', params);
      await query('MATCH (m:Person {id: $merged})-[r:ATTENDED]->(d), (k:Person {id: $keep}) DELETE r MERGE (k)-[:ATTENDED]->(d)', params);
      await query('MATCH (m:Person {id: $merged}) DETACH DELETE m', params);
      return true;
    }, (done) => done);
    return ok ? this.person(keepId) : null;
  }

  async forgetPerson(id: string): Promise<{ person: Person; claimsRemoved: number } | null> {
    const removed = await this.write(async (query) => {
      const [r] = await query('MATCH (p:Person {id: $id}) SET p._lock = coalesce(p._lock, 0) + 1 REMOVE p._lock RETURN p', { id });
      if (!r) return null;
      if (r.get('p').properties.isOwner === true) throw new Error('the owner cannot be forgotten');
      const name = r.get('p').properties.displayName as string;
      await query('MATCH (:Person {id: $id})-[:ALIAS]->(a:PersonAlias) DETACH DELETE a', { id });
      const [c] = await query('MATCH (:Person {id: $id})-[:SAID]->(c:Claim) WHERE c.status IN $undecided DETACH DELETE c RETURN count(*) AS n', { id, undecided: UNDECIDED });
      // Their name leaves what still carries it: the facts their accepted claims became ("Ana, 2026-11-10 call"), and
      // the person entries in Activity about them (subjects; details hold names and aliases, so they go).
      await query(`MATCH (c:Claim {speakerId: $id}) WHERE c.factId IS NOT NULL MATCH (f:Fact {id: c.factId}) SET f.why = replace(f.why, $name, $forgotten)`, { id, name, forgotten: FORGOTTEN_NAME });
      await query(`MATCH (x:Activity {kind: 'person_changed'}) WHERE $id IN coalesce(x.targets, []) SET x.subject = replace(x.subject, $name, $forgotten), x.details = '{}'`, { id, name, forgotten: FORGOTTEN_NAME });
      await query(`MATCH (p:Person {id: $id}) SET p.displayName = $name, p.status = 'forgotten'`, { id, name: FORGOTTEN_NAME });
      return Number(c.get('n'));
    }, (n) => n !== null);
    return removed === null ? null : { person: (await this.person(id))!, claimsRemoved: removed };
  }

  async listQuestions(f: QuestionFilter = {}): Promise<Question[]> {
    const rows = await this.g.run(
      `MATCH (x:Question)
       WHERE ($ids IS NULL OR x.id IN $ids) AND ($status IS NULL OR x.status IN $status) AND ($kind IS NULL OR x.kind IN $kind)
         AND ($keys IS NULL OR x.projectKey IS NULL OR x.projectKey IN $keys) AND ($docId IS NULL OR x.docId = $docId)
         AND ($assignee IS NULL OR x.assignee = $assignee) AND ${VISIBLE_TO_RUN('x')}
       RETURN x ORDER BY x.createdAt DESC, x.id SKIP $offset LIMIT $limit`,
      { ids: f.ids ?? null, status: f.status ?? null, kind: f.kind ?? null, keys: f.projectKeys ?? null, docId: f.docId ?? null, assignee: f.assignee ?? null, run: f.run ?? null, ...page(f) },
    );
    return rows.map((r) => questionOf(r.get('x').properties));
  }

  async question(id: string): Promise<Question | null> {
    const [r] = await this.g.run('MATCH (x:Question {id: $id}) RETURN x', { id });
    return r ? questionOf(r.get('x').properties) : null;
  }

  async addQuestion(q: QuestionDraft & { docId: string; projectKey: string | null; run?: RunTag | null }): Promise<{ question: Question; created: boolean }> {
    const clean = cleanQuestionDraft(q);
    const id = addedQuestionIdOf(q.docId, clean.text);
    const created = await this.write(async (query) => {
      const [r] = await query(
        `MERGE (x:Question {id: $id})
         ON CREATE SET x += $props, x.status = 'open', x.window = null, x.createdAt = $now, x._fresh = true
         WITH x, x._fresh IS NOT NULL AS fresh REMOVE x._fresh RETURN fresh`,
        {
          id, now: new Date().toISOString(),
          props: { text: clean.text, kind: clean.kind, quote: clean.quote, askedBy: clean.askedBy, docId: q.docId, projectKey: q.projectKey, run: q.run?.id ?? null, sandbox: !!q.run?.sandbox },
        },
      );
      if (r.get('fresh')) await relinkQuestions(query, [id]);
      return r.get('fresh') === true;
    }, (fresh) => fresh);
    return { question: (await this.question(id))!, created };
  }

  async updateQuestion(id: string, patch: QuestionPatch, by: string): Promise<Question | null> {
    const ok = await this.write(async (query) => {
      const set: Props = { decidedBy: by, decidedAt: new Date().toISOString() };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.assignee !== undefined) set.assignee = patch.assignee;
      const [r] = await query('MATCH (x:Question {id: $id}) SET x += $set RETURN x.id AS id', { id, set });
      if (!r) return false;
      await relinkQuestions(query, [id]);
      return true;
    }, (done) => done);
    return ok ? this.question(id) : null;
  }

  async answerQuestion(id: string, answer: AnswerInput, by: string): Promise<{ question: Question; claim: Claim } | null> {
    const claimId = answerClaimIdOf(id);
    const ok = await this.write(async (query) => {
      const [r] = await query('MATCH (q:Question {id: $id}) SET q._lock = coalesce(q._lock, 0) + 1 REMOVE q._lock RETURN q', { id });
      if (!r) return false;
      const q = questionOf(r.get('q').properties);
      const now = new Date().toISOString();
      const draft = cleanClaimDraft({ ...answer, quote: answer.statement, span: null, assertedAt: now, confidence: 1, due: null, flags: [] });
      const props = {
        ...claimProps(draft),
        projectKey: q.projectKey, docId: answerSourceOf(id), window: null, status: 'accepted', decidedBy: by, decidedAt: now, run: q.run, sandbox: q.sandbox,
      };
      await query('MERGE (c:Claim {id: $claimId}) ON CREATE SET c.createdAt = $now SET c += $props', { claimId, now, props });
      await query(`MATCH (q:Question {id: $id}) SET q.status = 'answered', q.answerClaimId = $claimId, q.decidedBy = $by, q.decidedAt = $now`, { id, claimId, by, now });
      await relinkClaims(query, [claimId]);
      await relinkQuestions(query, [id]);
      return true;
    }, (done) => done);
    return ok ? { question: (await this.question(id))!, claim: (await this.claim(claimId))! } : null;
  }

  async openConflict(raw: ConflictInput): Promise<{ conflict: Conflict; created: boolean }> {
    const input = cleanConflictInput(raw);
    const id = conflictIdOf(input.a, input.b);
    const created = await this.write(async (query) => {
      const [r] = await query('MATCH (c:Conflict {id: $id}) SET c._lock = coalesce(c._lock, 0) + 1 REMOVE c._lock RETURN c', { id });
      const now = new Date().toISOString();
      if (r) {
        const cur = conflictOf(r.get('c').properties);
        if (cur.status !== 'dismissed' || !sidesChanged(cur, input)) return false;
        await query(
          `MATCH (c:Conflict {id: $id}) SET c += $props, c.status = 'open', c.resolution = null, c.resolvedAt = null, c.resolvedBy = null, c.decisionId = null`,
          { id, props: conflictProps(input) },
        );
      } else {
        await query(
          `CREATE (c:Conflict {id: $id}) SET c += $props, c.status = 'open', c.createdAt = $now, c.run = $run, c.sandbox = $sandbox`,
          { id, props: conflictProps(input), now, run: input.run?.id ?? null, sandbox: !!input.run?.sandbox },
        );
      }
      await relinkConflict(query, input, id);
      return true;
    }, (made) => made);
    return { conflict: (await this.conflict(id))!, created };
  }

  async conflict(id: string): Promise<Conflict | null> {
    const [r] = await this.g.run('MATCH (c:Conflict {id: $id}) RETURN c', { id });
    return r ? conflictOf(r.get('c').properties) : null;
  }

  async listConflicts(f: ConflictFilter = {}): Promise<Conflict[]> {
    const rows = await this.g.run(
      `MATCH (c:Conflict)
       WHERE ($ids IS NULL OR c.id IN $ids) AND ($status IS NULL OR c.status IN $status) AND ($kind IS NULL OR c.kind IN $kind)
         AND ($keys IS NULL OR c.projectKey IS NULL OR c.projectKey IN $keys) AND ${VISIBLE_TO_RUN('c')}
       RETURN c ORDER BY c.createdAt DESC, c.id SKIP $offset LIMIT $limit`,
      { ids: f.ids ?? null, status: f.status ?? null, kind: f.kind ?? null, keys: f.projectKeys ?? null, run: f.run ?? null, ...page(f) },
    );
    return rows.map((r) => conflictOf(r.get('c').properties));
  }

  async conflictsFor(ids: string[], o: { status?: Conflict['status'][] } = {}): Promise<Conflict[]> {
    if (!ids.length) return [];
    const rows = await this.g.run(
      `CALL { MATCH (c:Conflict) WHERE c.aId IN $ids RETURN c UNION MATCH (c:Conflict) WHERE c.bId IN $ids RETURN c
              UNION MATCH (x:Claim) WHERE x.factId IN $ids MATCH (c:Conflict) WHERE c.aId = x.id RETURN c
              UNION MATCH (x:Claim) WHERE x.factId IN $ids MATCH (c:Conflict) WHERE c.bId = x.id RETURN c }
       WITH c WHERE c.status IN $status RETURN c ORDER BY c.createdAt DESC, c.id`,
      { ids, status: o.status ?? ['open'] },
    );
    return rows.map((r) => conflictOf(r.get('c').properties));
  }

  async writeSnapshots(writes: IntakeSnapshotWrite[], o: { supersede?: Supersession[]; unsupersede?: Supersession[] } = {}): Promise<void> {
    const claims = writes.filter((w) => w.kind === 'claim');
    const conflicts = writes.filter((w) => w.kind === 'conflict');
    await this.write(async (query) => {
      // Every target locked and compared before any is written: one that changed leaves them all as they were.
      const cRows = await query('UNWIND $ids AS id MATCH (x:Claim {id: id}) SET x._lock = coalesce(x._lock, 0) + 1 REMOVE x._lock RETURN x', { ids: claims.map((w) => w.id) });
      const kRows = await query('UNWIND $ids AS id MATCH (x:Conflict {id: id}) SET x._lock = coalesce(x._lock, 0) + 1 REMOVE x._lock RETURN x', { ids: conflicts.map((w) => w.id) });
      const now = new Map<string, string>([
        ...cRows.map((r) => { const c = claimOf(r.get('x').properties); return [`claim:${c.id}`, claimFingerprint(c)] as [string, string]; }),
        ...kRows.map((r) => { const c = conflictOf(r.get('x').properties); return [`conflict:${c.id}`, conflictFingerprint(c)] as [string, string]; }),
      ]);
      for (const w of writes) {
        const actual = now.get(`${w.kind}:${w.id}`) ?? null;
        if (actual !== w.expect) throw new TargetChangedError(w.id, w.expect, actual);
      }
      await query(
        `UNWIND $writes AS w MATCH (x:Claim {id: w.id})
         SET x.status = w.f.status, x.statement = w.f.statement, x.type = w.f.type, x.scopeArea = w.f.scopeArea, x.scopeFiles = w.f.scopeFiles,
             x.decidedBy = w.f.decidedBy, x.decidedAt = w.f.decidedAt, x.factId = w.f.factId`,
        {
          writes: claims.map((w) => {
            const f = w.fields as Extract<IntakeSnapshotWrite, { kind: 'claim' }>['fields'];
            return { id: w.id, f: { ...f, statement: redactIntakeText(f.statement), scopeArea: f.scope.area, scopeFiles: f.scope.files } };
          }),
        },
      );
      await query(
        `UNWIND $writes AS w MATCH (x:Conflict {id: w.id})
         SET x.status = w.f.status, x.resolution = w.f.resolution, x.resolvedBy = w.f.resolvedBy, x.resolvedAt = w.f.resolvedAt, x.decisionId = w.f.decisionId`,
        {
          writes: conflicts.map((w) => {
            const f = w.fields as Extract<IntakeSnapshotWrite, { kind: 'conflict' }>['fields'];
            const resolution = cleanResolution(f.resolution);
            return { id: w.id, f: { ...f, resolution: resolution === null ? null : JSON.stringify(resolution) } };
          }),
        },
      );
      await relinkClaims(query, claims.map((w) => w.id));
      for (const s of o.supersede ?? []) {
        await query(
          `MATCH (a:${LABEL[s.from.kind]} {id: $from}), (b:${LABEL[s.to.kind]} {id: $to}) MERGE (a)-[r:SUPERSEDED_BY {conflictId: $conflictId}]->(b)`,
          { from: s.from.id, to: s.to.id, conflictId: s.conflictId },
        );
      }
      for (const s of o.unsupersede ?? []) {
        await query(
          `MATCH (:${LABEL[s.from.kind]} {id: $from})-[r:SUPERSEDED_BY {conflictId: $conflictId}]->(:${LABEL[s.to.kind]} {id: $to}) DELETE r`,
          { from: s.from.id, to: s.to.id, conflictId: s.conflictId },
        );
      }
      return true;
    });
  }

  async supersessions(ids: string[]): Promise<Supersession[]> {
    if (!ids.length) return [];
    const rows = await this.g.run(
      `MATCH (a)-[r:SUPERSEDED_BY]->(b) WHERE a.id IN $ids OR b.id IN $ids
       RETURN ${KIND_OF('a')} AS fromKind, a.id AS fromId, ${KIND_OF('b')} AS toKind, b.id AS toId, r.conflictId AS conflictId
       ORDER BY fromId, toId, conflictId`,
      { ids },
    );
    return rows.map((r) => ({ from: { kind: r.get('fromKind'), id: r.get('fromId') }, to: { kind: r.get('toKind'), id: r.get('toId') }, conflictId: r.get('conflictId') }));
  }

  async redactStoredIntake(): Promise<IntakeRedacted> {
    const passes: { label: string; props: string[]; kind: string; where: string; count: keyof IntakeRedacted | null }[] = [
      { label: 'Doc', props: ['title'], kind: 'document', where: `x.source = 'intake'`, count: null },
      { label: 'Chunk', props: ['text'], kind: 'chunk', where: `EXISTS { MATCH (:Doc {source: 'intake'})-[:HAS_CHUNK]->(x) }`, count: null },
      { label: 'Claim', props: ['statement', 'quote', 'about'], kind: 'claim', where: 'true', count: 'claims' },
      { label: 'Question', props: ['text', 'quote'], kind: 'question', where: 'true', count: 'questions' },
    ];
    const out: IntakeRedacted = { sources: 0, claims: 0, questions: 0 };
    const sources = new Set<string>();
    for (const p of passes) {
      for (let after = ''; ;) {
        const rows = await this.g.run(
          `MATCH (x:${p.label}) WHERE x.id > $after AND ${p.where}
           RETURN x.id AS id, coalesce(x.docId, x.id) AS docId, x {${p.props.map((k) => `.${k}`).join(', ')}} AS v ORDER BY x.id LIMIT $page`,
          { after, page: neo4j.int(REDACT_PAGE) },
        );
        if (!rows.length) break;
        after = rows[rows.length - 1].get('id');
        const updates = rows.flatMap((r) => {
          const now = redactStoredRow(r.get('v') as Record<string, unknown>, p.props);
          return now ? [{ id: r.get('id') as string, docId: r.get('docId') as string, was: r.get('v'), now }] : [];
        });
        for (const u of updates) await archiveBeforeRedaction(p.kind, u.id, u.was);
        if (updates.length) await this.g.run(`UNWIND $updates AS u MATCH (x:${p.label} {id: u.id}) SET x += u.now`, { updates: updates.map((u) => ({ id: u.id, now: u.now })) });
        for (const u of updates) if (p.count) out[p.count]++; else sources.add(u.docId);
      }
    }
    out.sources = sources.size;
    return out;
  }

  async runItems(run: string): Promise<IntakeRunItem[]> {
    const rows = await this.g.run(
      `MATCH (x:Claim {run: $run}) RETURN 'claim' AS kind, x.id AS id, x.projectKey AS projectKey, coalesce(x.sandbox, false) AS sandbox
       UNION ALL MATCH (x:Question {run: $run}) RETURN 'question' AS kind, x.id AS id, x.projectKey AS projectKey, coalesce(x.sandbox, false) AS sandbox
       UNION ALL MATCH (x:Conflict {run: $run}) RETURN 'conflict' AS kind, x.id AS id, x.projectKey AS projectKey, coalesce(x.sandbox, false) AS sandbox`,
      { run },
    );
    return rows.map((r) => ({ kind: r.get('kind'), id: r.get('id'), projectKey: r.get('projectKey') ?? null, sandbox: r.get('sandbox') === true }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async removeRun(run: string, keep: string[] = []): Promise<IntakeRemoved> {
    return this.write(async (query) => {
      const out: IntakeRemoved = { claim: 0, question: 0, conflict: 0 };
      for (const [kind, label] of [['claim', 'Claim'], ['question', 'Question'], ['conflict', 'Conflict']] as const) {
        const rows = await query(`MATCH (x:${label} {run: $run}) WHERE NOT x.id IN $keep WITH x, x.id AS id DETACH DELETE x RETURN id`, { run, keep });
        out[kind] = rows.length;
        // A removed conflict's SUPERSEDED_BY edges name it, between records that stay.
        if (kind === 'conflict' && rows.length) await query('MATCH ()-[r:SUPERSEDED_BY]->() WHERE r.conflictId IN $ids DELETE r', { ids: rows.map((r) => r.get('id')) });
      }
      return out;
    });
  }
}

/** A dismissed conflict found again opens only when a side changed since: its fingerprint differs from the one stored. */
function sidesChanged(cur: Conflict, input: ConflictInput): boolean {
  const stored = new Map([cur.a, cur.b].map((s) => [`${s.kind}:${s.id}`, s.fingerprint]));
  return [input.a, input.b].some((s) => stored.get(`${s.kind}:${s.id}`) !== s.fingerprint);
}

/**
 * deleteProject's intake part, run before the project's facts and lessons go: conflicts with a side among them (a
 * conflict filed under another project included). Claims and questions go with the project's labels.
 */
export const DELETE_PROJECT_CONFLICTS = `MATCH (c:Conflict)-[:SIDE]->(n) WHERE n.projectKey = $key OR n.originProjectKey = $key
  WITH DISTINCT c LIMIT $batch DETACH DELETE c RETURN count(*) AS n`;
