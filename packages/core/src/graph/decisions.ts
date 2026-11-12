import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { instantText, prepareDecision, prepareNote, prepareRollback, prepareSnapshots, redactStoredDecision, type CalibrationBump, type DecisionCount, type DecisionCountFilter, type DecisionCountKey, type DecisionFilter, type DecisionNoteInput, type DecisionStatusPatch, type MissLink } from '../decisions/record.ts';
import { REDACT_PAGE, redactSecrets } from '../redact.ts';
import type { DecisionsStore, LoopMiss } from '../store.ts';
import { distinctKey, type CalibrationBucket, type Decision, type DecisionInput, type DecisionNote, type DecisionType, type DistinctPair, type LessonSignals, type TargetSnapshot } from '../types.ts';
import { retryDeadlock, type GraphRepo } from './repo.ts';

/**
 * Every property of a Decision, absent ones as null. The JSON ones (targets, snapshots, evidence, features,
 * confidence, rollback) are text: a node property cannot hold a list of maps.
 */
const DECISION = `d {.id, .type, .projectKey, .targets, .before, .after, .evidence, .features, .score, .confidence, .tier, .mode,
  .rationale, .model, .policyVersion, .status, .dependsOn, .supersededBy, .createdAt, .appliedAt, .decidedAt, .decidedBy,
  .rollback, .ratifiedAt, .ratifiedBy, .syncHoldUntil, .author}`;
const NOTE = 'n {.id, .decisionId, .ts, .by, .text, .verdict, .reason}';
const CALIBRATION = 'c {.type, .band, .policyVersion, .alpha, .beta, .n, .updatedAt}';
/** Take the node's write lock before reading what a compare-and-set compares (docs.ts does the same). */
const LOCK = (v: string) => `SET ${v}._lock = coalesce(${v}._lock, 0) + 1 REMOVE ${v}._lock`;

const json = (s: string | null) => (s === null ? null : JSON.parse(s));
const text = (v: unknown) => (v === null ? null : JSON.stringify(v));
const decisionOf = (p: Record<string, any>): Decision => ({
  id: p.id, type: p.type, projectKey: p.projectKey, targets: json(p.targets), before: json(p.before), after: json(p.after),
  evidence: json(p.evidence), features: json(p.features), score: p.score, confidence: json(p.confidence), tier: p.tier,
  mode: p.mode, rationale: p.rationale, model: p.model, policyVersion: p.policyVersion, status: p.status,
  dependsOn: p.dependsOn, supersededBy: p.supersededBy, createdAt: p.createdAt, appliedAt: p.appliedAt,
  decidedAt: p.decidedAt, decidedBy: p.decidedBy, rollback: json(p.rollback), ratifiedAt: p.ratifiedAt,
  ratifiedBy: p.ratifiedBy, syncHoldUntil: p.syncHoldUntil,
  // Decisions before 0.9.0 have none: the loop's.
  author: p.author ?? 'loop',
});

/** DecisionsStore.count's groups over decision d: the ISO week of its createdAt (stored as UTC text) as `2026-W45`. */
const COUNT_COLUMN: Record<DecisionCountKey, string> = {
  status: 'd.status', mode: 'd.mode', type: 'd.type', applied: '(d.appliedAt IS NOT NULL)',
  createdWeek: `toString(date(datetime(d.createdAt)).weekYear) + '-W' + right('0' + toString(date(datetime(d.createdAt)).week), 2)`,
};

/**
 * MATCH (d:Decision) and the WHERE of list and count, its parameters set on `p`. Times are compared as the text the
 * store writes (instantText: toISOString), so the createdAt index serves since and `after`; targets go through the
 * (:DecisionTarget) keys.
 */
function decisionMatch(f: DecisionFilter, p: Record<string, unknown>): string {
  const w: string[] = [];
  const add = (name: string, v: unknown, cond: string) => { p[name] = v; w.push(cond); };
  if (f.status) add('status', f.status, 'd.status IN $status');
  if (f.type) add('type', f.type, 'd.type = $type');
  if (f.author) add('author', f.author, "coalesce(d.author, 'loop') = $author");
  if (f.projectKey !== undefined) add('projectKey', f.projectKey, 'd.projectKey = $projectKey');
  if (f.projectKeys) add('projectKeys', f.projectKeys, '(d.projectKey IS NULL OR d.projectKey IN $projectKeys)');
  if (f.mode) add('mode', f.mode, 'd.mode = $mode');
  if (f.band !== undefined) add('band', neo4j.int(f.band), 'd.band = $band');
  if (f.target !== undefined) add('target', f.target, '$target IN d.targetIds');
  if (f.idPrefix !== undefined) add('idPrefix', f.idPrefix, 'd.id STARTS WITH $idPrefix');
  if (f.since) add('since', instantText(f.since), 'd.createdAt >= $since');
  if (f.until) add('until', instantText(f.until), 'd.createdAt < $until');
  if (f.appliedSince) add('appliedSince', instantText(f.appliedSince), 'd.appliedAt >= $appliedSince');
  if (f.appliedBefore) add('appliedBefore', instantText(f.appliedBefore), 'd.appliedAt < $appliedBefore');
  if (f.decidedSince) add('decidedSince', instantText(f.decidedSince), 'd.decidedAt >= $decidedSince');
  if (f.unlabelled) w.push('d.labelledAt IS NULL');
  if (f.order === 'applied') w.push('d.appliedAt IS NOT NULL');
  if (f.after) {
    p.afterAt = instantText(f.after.createdAt);
    p.afterId = f.after.id;
    w.push('d.createdAt <= $afterAt AND (d.createdAt < $afterAt OR d.id < $afterId)');
  }
  if (f.q) add('q', f.q, '(toLower(d.rationale) CONTAINS toLower($q) OR any(t IN d.targetIds WHERE toLower(t) CONTAINS toLower($q)))');
  const match = f.targets ? 'MATCH (k:DecisionTarget) WHERE k.id IN $targets MATCH (k)<-[:NAMES]-(d:Decision) WITH DISTINCT d' : 'MATCH (d:Decision)';
  if (f.targets) p.targets = f.targets;
  return `${match}${w.length ? ` WHERE ${w.join(' AND ')}` : ''}`;
}

/** Edges to the records a decision targets and rests on, where they exist (the properties are the record). */
const TARGET_NODES = [['lesson', 'Lesson', 'id'], ['fact', 'Fact', 'id'], ['miss', 'Miss', 'id'], ['candidate', 'Candidate', 'id'], ['project', 'Project', 'key'], ['claim', 'Claim', 'id'], ['conflict', 'Conflict', 'id']] as const;

/**
 * The learning loop's decisions as (:Decision) nodes: -[:TARGETS {role}]-> the records decided on, -[:EVIDENCE]-> the
 * records it rests on, -[:DEPENDS_ON]-> earlier decisions, -[:NAMES]-> a (:DecisionTarget {id}) key per target id
 * (whether or not that record exists, so forTarget is an index lookup); (:DecisionNote)-[:ON]->(:Decision); (:Miss)-[:REPEATS]->
 * (:Miss) links; (:Lesson)-[:HAS_SIGNALS]->(:LessonSignals); (:LoopCalibration) buckets.
 */
export class DecisionsRepo implements DecisionsStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async propose(input: DecisionInput): Promise<{ decision: Decision; created: boolean }> {
    const d = await prepareDecision(input);
    const token = randomUUID();
    const props = {
      type: d.type, projectKey: d.projectKey, status: d.status, tier: d.tier, mode: d.mode,
      targets: JSON.stringify(d.targets), targetIds: d.targets.map((t) => t.id), before: JSON.stringify(d.before), after: JSON.stringify(d.after),
      evidence: JSON.stringify(d.evidence), features: JSON.stringify(d.features), score: d.score, confidence: JSON.stringify(d.confidence),
      band: neo4j.int(d.confidence.band), rationale: d.rationale, model: d.model, policyVersion: neo4j.int(d.policyVersion),
      dependsOn: d.dependsOn, createdAt: new Date().toISOString(), author: d.author ?? 'loop',
    };
    const rows = (kind: string, list: { kind: string }[]) => list.filter((x) => x.kind === kind);
    // Only the creator writes past the MERGE (it holds the new node's lock): a matcher that wrote too would race the
    // other matchers for it. The edges go to the records that exist; the properties are the record.
    const [r] = await this.g.run(
      `MERGE (d:Decision {id: $id}) ON CREATE SET d += $props, d.proposeToken = $token
       WITH d, d.proposeToken = $token AS created
       CALL (d, created) {
         WITH d WHERE created
         REMOVE d.proposeToken
         WITH d
         ${TARGET_NODES.map(([kind, label, key]) => `
         CALL (d) { UNWIND $targets.${kind} AS t MATCH (n:${label} {${key}: t.id}) MERGE (d)-[:TARGETS {role: t.role}]->(n) }
         CALL (d) { UNWIND $evidence.${kind} AS e MATCH (n:${label} {${key}: e.id}) MERGE (d)-[r:EVIDENCE {role: e.role}]->(n) ON CREATE SET r.weight = e.weight }`).join('')}
         CALL (d) { UNWIND $deps AS dep MATCH (o:Decision {id: dep}) MERGE (d)-[:DEPENDS_ON]->(o) }
         CALL (d) { UNWIND d.targetIds AS tid MERGE (k:DecisionTarget {id: tid}) MERGE (d)-[:NAMES]->(k) }
       }
       RETURN created`,
      {
        id: d.id, props, token, deps: d.dependsOn,
        targets: Object.fromEntries(TARGET_NODES.map(([kind]) => [kind, rows(kind, d.targets)])),
        evidence: Object.fromEntries(TARGET_NODES.map(([kind]) => [kind, rows(kind, d.evidence)])),
      },
    );
    return { decision: (await this.get(d.id))!, created: r.get('created') === true };
  }

  async get(id: string): Promise<Decision | null> {
    const [r] = await this.g.run(`MATCH (d:Decision {id: $id}) RETURN ${DECISION} AS d`, { id });
    return r ? decisionOf(r.get('d')) : null;
  }

  async list(f: DecisionFilter = {}): Promise<Decision[]> {
    const p: Record<string, unknown> = { offset: neo4j.int(f.offset ?? 0), limit: neo4j.int(f.limit ?? 100) };
    const rows = await this.g.run(
      `${decisionMatch(f, p)}
       WITH d ORDER BY ${f.order === 'applied' ? 'd.appliedAt DESC, ' : ''}d.createdAt DESC, d.id DESC SKIP $offset LIMIT $limit
       RETURN ${DECISION} AS d`,
      p,
    );
    return rows.map((r) => decisionOf(r.get('d')));
  }

  async count(f: DecisionCountFilter, by: readonly DecisionCountKey[]): Promise<DecisionCount[]> {
    const p: Record<string, unknown> = {};
    const rows = await this.g.run(`${decisionMatch(f, p)} RETURN ${[...by.map((k) => `${COUNT_COLUMN[k]} AS ${k}`), 'count(d) AS n'].join(', ')}`, p);
    return rows.map((r) => Object.fromEntries([...by, 'n'].map((k) => [k, k === 'n' ? Number(r.get('n')) : r.get(k)])) as DecisionCount);
  }

  /** Through the target's (:DecisionTarget) key node, by its index: the engine asks once per call it makes. */
  async forTarget(id: string): Promise<Decision[]> {
    const rows = await this.g.run(`MATCH (:DecisionTarget {id: $id})<-[:NAMES]-(d:Decision) WITH d ORDER BY d.createdAt DESC, d.id DESC RETURN ${DECISION} AS d`, { id });
    return rows.map((r) => decisionOf(r.get('d')));
  }

  /** Lock, then move only from one of `from`: two racing moves cannot both win. */
  private async transition(id: string, from: string[], set: string, params: Record<string, unknown> = {}): Promise<boolean> {
    // Racing moves of one decision can be aborted as a deadlock by Neo4j: the aborted one moved nothing and runs again.
    const [r] = await retryDeadlock(() => this.g.run(
      `MATCH (d:Decision {id: $id}) ${LOCK('d')} WITH d WHERE d.status IN $from SET ${set} RETURN count(d) AS n`,
      { ...params, id, from, now: new Date().toISOString() },
    ));
    return r.get('n') > 0;
  }

  markApplying(id: string, o: { by?: string; syncHoldUntil?: string | null } = {}): Promise<boolean> {
    return this.transition(id, ['proposed', 'observed'], `d.status = 'applying', d.decidedAt = $now, d.decidedBy = coalesce($by, d.decidedBy), d.syncHoldUntil = $hold`,
      { by: o.by ?? null, hold: o.syncHoldUntil ?? null });
  }

  async loopChanged(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    // after is the snapshots' JSON text: each snapshot's own "id" field, as JSON.stringify writes it.
    const rows = await this.g.run(
      `UNWIND $ids AS id MATCH (k:DecisionTarget {id: id})
       WHERE EXISTS { MATCH (k)<-[:NAMES]-(d:Decision {status: 'applied'}) WHERE d.decidedBy STARTS WITH 'loop:' AND d.after CONTAINS $prefix + id + '"' }
       RETURN DISTINCT id`,
      { ids: [...new Set(ids)], prefix: '"id":"' },
    );
    return rows.map((r) => r.get('id'));
  }

  async markApplied(id: string, after: TargetSnapshot[], o: { syncHoldUntil?: string | null } = {}): Promise<boolean> {
    const safe = await prepareSnapshots(id, after);
    return this.transition(id, ['applying'], `d.status = 'applied', d.after = $after, d.appliedAt = $now, d.syncHoldUntil = $hold`,
      { after: JSON.stringify(safe), hold: o.syncHoldUntil ?? null });
  }

  async markStatus(id: string, p: DecisionStatusPatch): Promise<boolean> {
    const rollback = text(p.rollback ? await prepareRollback(id, p.rollback) : null);
    return this.transition(id, p.from,
      `d.status = $status, d.decidedAt = CASE WHEN $by IS NULL THEN d.decidedAt ELSE $now END, d.decidedBy = coalesce($by, d.decidedBy),
       d.rollback = coalesce($rollback, d.rollback), d.supersededBy = coalesce($supersededBy, d.supersededBy),
       d.mode = coalesce($mode, d.mode), d.score = coalesce($score, d.score), d.confidence = coalesce($confidence, d.confidence),
       d.band = coalesce($band, d.band)`,
      {
        status: p.status, by: p.by ?? null, rollback, supersededBy: p.supersededBy ?? null, mode: p.call?.mode ?? null, score: p.call?.score ?? null,
        confidence: text(p.call?.confidence ?? null), band: p.call ? neo4j.int(p.call.confidence.band) : null,
      });
  }

  ratify(id: string, by: string): Promise<boolean> {
    return this.transition(id, ['applied'], 'd.ratifiedAt = $now, d.ratifiedBy = $by', { by });
  }

  markLabelled(id: string): Promise<boolean> {
    return this.transition(id, ['applied'], 'd.labelledAt = $now');
  }

  async addNote(decisionId: string, input: DecisionNoteInput): Promise<DecisionNote | null> {
    const note = await prepareNote(decisionId, input);
    // seq: a counter on the decision, moved under its lock, so two in the same millisecond keep their order. Counting
    // the notes already there (still how a decision noted before the counter starts it) gave a later note the seq of an
    // earlier one now and then. Concurrent notes on one decision can still deadlock on its relationship locks; Neo4j
    // aborts one, which wrote nothing, and it is run again.
    const [r] = await retryDeadlock(() => this.g.run(
      `MATCH (d:Decision {id: $decisionId}) ${LOCK('d')} WITH d OPTIONAL MATCH (o:DecisionNote)-[:ON]->(d) WITH d, count(o) AS had
       SET d.noteSeq = coalesce(d.noteSeq, had - 1) + 1
       CREATE (n:DecisionNote)-[:ON]->(d) SET n = $note, n.seq = d.noteSeq RETURN ${NOTE} AS n`,
      { decisionId, note },
    ), 12);
    return r ? r.get('n') : null;
  }

  async notes(decisionId: string): Promise<DecisionNote[]> {
    const rows = await this.g.run(`MATCH (n:DecisionNote {decisionId: $decisionId}) RETURN ${NOTE} AS n ORDER BY n.ts, n.seq`, { decisionId });
    return rows.map((r) => r.get('n'));
  }

  async dependents(id: string): Promise<Decision[]> {
    const rows = await this.g.run(`MATCH (d:Decision)-[:DEPENDS_ON]->(:Decision {id: $id}) WITH d ORDER BY d.createdAt DESC, d.id DESC RETURN ${DECISION} AS d`, { id });
    return rows.map((r) => decisionOf(r.get('d')));
  }

  async inFlight(): Promise<Decision[]> {
    const rows = await this.g.run(`MATCH (d:Decision {status: 'applying'}) WITH d ORDER BY d.createdAt, d.id RETURN ${DECISION} AS d`);
    return rows.map((r) => decisionOf(r.get('d')));
  }

  async signals(lessonId: string): Promise<LessonSignals | null> {
    const [r] = await this.g.run('MATCH (s:LessonSignals {lessonId: $lessonId}) RETURN s {.lessonId, .counts, .lastServed, .lastOwnerTouch, .updatedAt} AS s', { lessonId });
    return r ? { ...r.get('s'), counts: JSON.parse(r.get('s').counts) } : null;
  }

  async signalsOf(lessonIds: string[]): Promise<LessonSignals[]> {
    const rows = await this.g.run('MATCH (s:LessonSignals) WHERE s.lessonId IN $lessonIds RETURN s {.lessonId, .counts, .lastServed, .lastOwnerTouch, .updatedAt} AS s', { lessonIds });
    return rows.map((r) => ({ ...r.get('s'), counts: JSON.parse(r.get('s').counts) }));
  }

  async listSignals(f: { projectKeys?: string[] } = {}) {
    const rows = await this.g.run(
      `MATCH (l:Lesson)-[:HAS_SIGNALS]->(s:LessonSignals)
       WHERE $projectKeys IS NULL OR l.projectKey IS NULL OR l.projectKey IN $projectKeys
       RETURN s {.lessonId, .counts, .lastServed, .lastOwnerTouch, .updatedAt} AS s, l.projectKey AS projectKey,
         coalesce(l.source, 'postmortem') AS source, l.status AS status, l.run AS run, coalesce(l.sandbox, false) AS sandbox
       ORDER BY s.lessonId`,
      { projectKeys: f.projectKeys ?? null },
    );
    return rows.map((r) => ({
      ...(r.get('s') as LessonSignals), counts: JSON.parse(r.get('s').counts),
      projectKey: r.get('projectKey'), source: r.get('source'), status: r.get('status'), run: r.get('run') ?? null, sandbox: r.get('sandbox') === true,
    }));
  }

  async upsertSignals(rows: Omit<LessonSignals, 'updatedAt'>[]): Promise<number> {
    const [r] = await this.g.run(
      `UNWIND $rows AS row MATCH (l:Lesson {id: row.lessonId})
       MERGE (s:LessonSignals {lessonId: row.lessonId})
       SET s.counts = row.counts, s.lastServed = row.lastServed, s.lastOwnerTouch = row.lastOwnerTouch, s.updatedAt = $now
       MERGE (l)-[:HAS_SIGNALS]->(s)
       RETURN count(s) AS n`,
      { rows: rows.map((x) => ({ ...x, counts: JSON.stringify(x.counts) })), now: new Date().toISOString() },
    );
    return r.get('n');
  }

  async calibration(type: DecisionType, policyVersion: number): Promise<CalibrationBucket[]> {
    const rows = await this.g.run(`MATCH (c:LoopCalibration {type: $type, policyVersion: $v}) RETURN ${CALIBRATION} AS c ORDER BY c.band`, { type, v: neo4j.int(policyVersion) });
    return rows.map((r) => r.get('c'));
  }

  async bumpCalibration(b: CalibrationBump): Promise<CalibrationBucket> {
    const key = `${b.type}|${b.band}|${b.policyVersion}`;
    // The bucket is made on its own (a MERGE that then writes would deadlock with a concurrent one), then locked and bumped.
    await this.g.run(
      `MERGE (c:LoopCalibration {key: $key})
       ON CREATE SET c.type = $type, c.band = $band, c.policyVersion = $v, c.alpha = $prior.alpha, c.beta = $prior.beta, c.n = 0`,
      { key, type: b.type, band: neo4j.int(b.band), v: neo4j.int(b.policyVersion), prior: b.prior },
    );
    // Concurrent bumps of one bucket can still be aborted as deadlocks by Neo4j; an aborted one changed nothing and runs again.
    const [, [r]] = await retryDeadlock(() => this.g.runInTransaction([
      [`MATCH (c:LoopCalibration {key: $key}) ${LOCK('c')}`, { key }],
      [`MATCH (c:LoopCalibration {key: $key}) SET c.alpha = c.alpha + $alpha, c.beta = c.beta + $beta, c.n = c.n + $n, c.updatedAt = $now
        RETURN ${CALIBRATION} AS c`, { key, alpha: b.alpha, beta: b.beta, n: neo4j.int(b.n), now: new Date().toISOString() }],
    ]));
    return r.get('c');
  }

  async linkMisses(link: Omit<MissLink, 'createdAt'>): Promise<boolean> {
    const [r] = await this.g.run(
      `MATCH (a:Miss {id: $from}), (b:Miss {id: $to}) WHERE a <> b
       MERGE (a)-[r:REPEATS]->(b) ON CREATE SET r.decisionId = $decisionId, r.createdAt = $now, r.linkToken = $token
       WITH r, r.linkToken = $token AS created FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END | REMOVE r.linkToken) RETURN created`,
      { ...link, now: new Date().toISOString(), token: randomUUID() },
    );
    return r?.get('created') === true;
  }

  async unlinkMisses(link: Pick<MissLink, 'from' | 'to'>): Promise<boolean> {
    const [r] = await this.g.run('MATCH (:Miss {id: $from})-[r:REPEATS]->(:Miss {id: $to}) DELETE r RETURN count(r) AS n', link);
    return r.get('n') > 0;
  }

  async markDistinct(p: Omit<DistinctPair, 'at'>): Promise<boolean> {
    const [a, b] = distinctKey(p.a, p.b);
    const [r] = await this.g.run(
      `MERGE (d:DistinctPair {key: $key}) ON CREATE SET d.a = $a, d.b = $b, d.by = $by, d.at = $now, d.reason = $reason, d.decisionId = $decisionId, d._fresh = true
       WITH d, d._fresh IS NOT NULL AS created REMOVE d._fresh RETURN created`,
      { key: `${a}|${b}`, a, b, by: p.by, reason: p.reason, decisionId: p.decisionId, now: new Date().toISOString() },
    );
    return r?.get('created') === true;
  }

  async liftDistinct(x: string, y: string): Promise<boolean> {
    const [a, b] = distinctKey(x, y);
    const [r] = await this.g.run('MATCH (d:DistinctPair {key: $key}) DELETE d RETURN count(*) AS n', { key: `${a}|${b}` });
    return Number(r?.get('n') ?? 0) > 0;
  }

  async distinctPairs(ids: string[]): Promise<DistinctPair[]> {
    if (!ids.length) return [];
    const rows = await this.g.run(
      'MATCH (d:DistinctPair) WHERE d.a IN $ids OR d.b IN $ids RETURN d ORDER BY d.at, d.key',
      { ids: [...new Set(ids)] },
    );
    return rows.map((r) => {
      const d = r.get('d').properties;
      return { a: d.a, b: d.b, by: d.by, at: d.at, reason: d.reason, decisionId: d.decisionId ?? null };
    });
  }

  async missLinks(missId: string): Promise<MissLink[]> {
    const rows = await this.g.run(
      `MATCH (:Miss {id: $missId})-[r:REPEATS]-(:Miss)
       RETURN startNode(r).id AS from, endNode(r).id AS to, r.decisionId AS decisionId, r.createdAt AS createdAt
       ORDER BY createdAt, from, to`,
      { missId },
    );
    return rows.map((r) => ({ from: r.get('from'), to: r.get('to'), decisionId: r.get('decisionId'), createdAt: r.get('createdAt') }));
  }

  async loopMisses(ids: string[]): Promise<LoopMiss[]> {
    const rows = await this.g.run(
      `UNWIND $ids AS id MATCH (m:Miss {id: id})
       OPTIONAL MATCH (m)-[:EXPLAINS]->(:Feedback)-[:FROM_TURN]->(:Turn)<-[:HAS_TURN]-(s:Session)
       OPTIONAL MATCH (s)-[r:TOUCHED]->(cf:CodeFile) WHERE r.edited = true
       WITH m, s, collect(DISTINCT cf.path) AS files
       RETURN m {.id, .projectKey, .cause, .missed, .embedding, .createdAt, .subject, .run, .sandbox} AS m, s.id AS sessionId, files
       ORDER BY m.id`,
      { ids: [...new Set(ids)] },
    );
    return rows.map((r) => {
      const m = r.get('m');
      return {
        id: m.id, projectKey: m.projectKey, cause: m.cause, missed: m.missed, embedding: m.embedding ?? null, createdAt: m.createdAt,
        subject: m.subject ?? null, run: m.run ?? null, sandbox: m.sandbox === true, sessionId: r.get('sessionId') ?? null,
        editedFiles: (r.get('files') as string[]).toSorted(),
      };
    });
  }

  async redactStoredDecisions(): Promise<number> {
    let changed = 0;
    for (let after = ''; ;) {
      const rows = await this.g.run(`MATCH (d:Decision) WHERE d.id > $after WITH d ORDER BY d.id LIMIT $page RETURN ${DECISION} AS d`, { after, page: neo4j.int(REDACT_PAGE) });
      if (!rows.length) break;
      after = rows[rows.length - 1].get('d').id;
      const page = rows.flatMap((r) => redactStoredDecision(decisionOf(r.get('d'))) ?? []).map((d) => ({
        id: d.id, before: JSON.stringify(d.before), after: JSON.stringify(d.after), evidence: JSON.stringify(d.evidence),
        rationale: d.rationale, model: d.model, rollback: text(d.rollback),
      }));
      await this.g.run(
        `UNWIND $page AS c MATCH (d:Decision {id: c.id})
         SET d.before = c.before, d.after = c.after, d.evidence = c.evidence, d.rationale = c.rationale, d.model = c.model, d.rollback = c.rollback`,
        { page },
      );
      changed += page.length;
    }
    for (let after = ''; ;) {
      const rows = await this.g.run('MATCH (n:DecisionNote) WHERE n.id > $after RETURN n.id AS id, n.text AS text ORDER BY n.id LIMIT $page', { after, page: neo4j.int(REDACT_PAGE) });
      if (!rows.length) break;
      after = rows[rows.length - 1].get('id');
      const page = rows.map((r) => ({ id: r.get('id') as string, text: redactSecrets(r.get('text')) })).filter((n, i) => n.text !== rows[i].get('text'));
      await this.g.run('UNWIND $page AS c MATCH (n:DecisionNote {id: c.id}) SET n.text = c.text', { page });
      changed += page.length;
    }
    return changed;
  }
}

/**
 * Labels the loop counted before Decision.labelledAt existed (a loop-kept:<id> cursor each) are marked on their
 * decisions (ensureSchema), so labelUntouched leaves them out. Returns how many.
 */
export async function backfillDecisionLabels(g: GraphRepo): Promise<number> {
  const [r] = await g.run(
    `MATCH (c:SyncCursor) WHERE c.key STARTS WITH 'loop-kept:'
     MATCH (d:Decision {id: substring(c.key, 10)}) WHERE d.labelledAt IS NULL SET d.labelledAt = c.value
     RETURN count(d) AS n`,
  );
  return Number(r.get('n'));
}

/** Decisions stored before (:DecisionTarget) key nodes existed get theirs (ensureSchema), a page at a time. */
export async function backfillDecisionTargets(g: GraphRepo): Promise<number> {
  let made = 0;
  for (;;) {
    const [r] = await g.run(
      `MATCH (d:Decision) WHERE size(d.targetIds) > 0 AND NOT (d)-[:NAMES]->() WITH d LIMIT 500
       CALL (d) { UNWIND d.targetIds AS tid MERGE (k:DecisionTarget {id: tid}) MERGE (d)-[:NAMES]->(k) }
       RETURN count(d) AS n`,
    );
    const n = Number(r.get('n'));
    made += n;
    if (n < 500) return made;
  }
}
