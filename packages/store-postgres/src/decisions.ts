import {
  prepareDecision,
  prepareNote,
  prepareRollback,
  prepareSnapshots,
  REDACT_PAGE,
  redactSecrets,
  redactStoredDecision,
  type CalibrationBucket,
  type CalibrationBump,
  type Decision,
  type DecisionCount,
  type DecisionCountFilter,
  type DecisionCountKey,
  type DecisionFilter,
  type DecisionInput,
  type DecisionNote,
  type DecisionNoteInput,
  type DecisionStatusPatch,
  type DecisionsStore,
  type DecisionType,
  type LessonSignals,
  type LoopMiss,
  type MissLink,
  type TargetSnapshot,
} from '@fb/core';
import { fromVector, iso, toJson, tx, type Db } from './db.ts';

type Row = Record<string, any>;

/** A decision row with its targets and dependencies in their order (alias d). */
const DECISION = `SELECT d.*,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'id', t.target_id, 'role', t.role) ORDER BY t.idx), '[]')
       FROM decision_targets t WHERE t.decision_id = d.id) AS targets,
    (SELECT coalesce(array_agg(x.depends_on ORDER BY x.idx), '{}') FROM decision_deps x WHERE x.decision_id = d.id) AS depends_on
  FROM decisions d`;

const decisionOf = (r: Row): Decision => ({
  id: r.id, type: r.type, projectKey: r.project_key, targets: r.targets, before: r.before, after: r.after,
  evidence: r.evidence, features: r.features, score: r.score, confidence: r.confidence, tier: r.tier, mode: r.mode,
  rationale: r.rationale, model: r.model, policyVersion: r.policy_version, status: r.status, dependsOn: r.depends_on,
  supersededBy: r.superseded_by, createdAt: iso(r.created_at)!, appliedAt: iso(r.applied_at), decidedAt: iso(r.decided_at),
  decidedBy: r.decided_by, rollback: r.rollback, ratifiedAt: iso(r.ratified_at), ratifiedBy: r.ratified_by,
  syncHoldUntil: iso(r.sync_hold_until), author: r.author,
});
const signalsOf = (r: Row): LessonSignals => ({
  lessonId: r.lesson_id, counts: r.counts, lastServed: iso(r.last_served), lastOwnerTouch: iso(r.last_owner_touch), updatedAt: iso(r.updated_at)!,
});
const noteOf = (r: Row): DecisionNote => ({ id: r.id, decisionId: r.decision_id, ts: iso(r.ts)!, by: r.by, text: r.text, verdict: r.verdict, reason: r.reason });
const bucketOf = (r: Row): CalibrationBucket => ({
  type: r.type, band: r.band, policyVersion: r.policy_version, alpha: r.alpha, beta: r.beta, n: r.n, updatedAt: iso(r.updated_at)!,
});

/** DecisionsStore.count's groups as columns of decisions d. */
const COUNT_COLUMN: Record<DecisionCountKey, string> = {
  status: 'd.status', mode: 'd.mode', type: 'd.type', applied: '(d.applied_at IS NOT NULL)',
  createdWeek: `to_char(d.created_at AT TIME ZONE 'UTC', 'IYYY-"W"IW')`,
};

/**
 * The WHERE of list and count over decisions d, its parameters pushed onto `p`. q is a trigram-indexed LIKE (its % and _
 * matched as themselves); `after` is a keyset over decisions_created.
 */
function decisionWhere(f: DecisionFilter, p: unknown[]): string {
  const $ = (v: unknown) => `$${p.push(v)}`;
  const w: string[] = [];
  if (f.status) w.push(`d.status = ANY(${$(f.status)}::text[])`);
  if (f.type) w.push(`d.type = ${$(f.type)}`);
  if (f.author) w.push(`d.author = ${$(f.author)}`);
  if (f.projectKey !== undefined) w.push(`d.project_key = ${$(f.projectKey)}`);
  if (f.projectKeys) w.push(`(d.project_key IS NULL OR d.project_key = ANY(${$(f.projectKeys)}::text[]))`);
  if (f.mode) w.push(`d.mode = ${$(f.mode)}`);
  if (f.band !== undefined) w.push(`d.band = ${$(f.band)}`);
  if (f.target !== undefined) w.push(`d.id IN (SELECT decision_id FROM decision_targets WHERE target_id = ${$(f.target)})`);
  if (f.idPrefix !== undefined) w.push(`starts_with(d.id, ${$(f.idPrefix)})`);
  if (f.targets) w.push(`d.id IN (SELECT decision_id FROM decision_targets WHERE target_id = ANY(${$(f.targets)}::text[]))`);
  if (f.since) w.push(`d.created_at >= ${$(f.since)}::timestamptz`);
  if (f.until) w.push(`d.created_at < ${$(f.until)}::timestamptz`);
  if (f.appliedSince) w.push(`d.applied_at >= ${$(f.appliedSince)}::timestamptz`);
  if (f.appliedBefore) w.push(`d.applied_at < ${$(f.appliedBefore)}::timestamptz`);
  if (f.decidedSince) w.push(`d.decided_at >= ${$(f.decidedSince)}::timestamptz`);
  if (f.unlabelled) w.push('d.labelled_at IS NULL');
  if (f.order === 'applied') w.push('d.applied_at IS NOT NULL');
  if (f.after) w.push(`(d.created_at, d.id) < (${$(f.after.createdAt)}::timestamptz, ${$(f.after.id)}::text)`);
  if (f.q) {
    const like = `'%' || replace(replace(replace(lower(${$(f.q)}), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;
    w.push(`d.id IN (SELECT id FROM decisions WHERE lower(rationale) LIKE ${like} UNION SELECT decision_id FROM decision_targets WHERE lower(target_id) LIKE ${like})`);
  }
  return w.length ? `WHERE ${w.join(' AND ')}` : '';
}

/** The learning loop's records (DecisionsStore): decisions, decision_targets, decision_deps, decision_notes, miss_links, lesson_signals, loop_calibration. */
export class PgDecisionsStore implements DecisionsStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private q(sql: string, params: unknown[] = []) {
    return this.db.pool.query(sql, params);
  }

  async propose(input: DecisionInput): Promise<{ decision: Decision; created: boolean }> {
    const d = await prepareDecision(input);
    const created = await tx(this.db, async (c) => {
      const { rowCount } = await c.query(
        `INSERT INTO decisions (id, type, project_key, status, tier, mode, before, after, evidence, features, score, confidence, band,
                                rationale, model, policy_version, created_at, author)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, d.type, d.projectKey, d.status, d.tier, d.mode, toJson(d.before), toJson(d.after), toJson(d.evidence), toJson(d.features),
          d.score, toJson(d.confidence), d.confidence.band, d.rationale, d.model, d.policyVersion, new Date(), d.author ?? 'loop'],
      );
      if (!rowCount) return false;
      await c.query(
        `INSERT INTO decision_targets (decision_id, idx, kind, target_id, role)
         SELECT $1, i - 1, t->>'kind', t->>'id', t->>'role' FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS x(t, i)`,
        [d.id, toJson(d.targets)],
      );
      await c.query(
        'INSERT INTO decision_deps (decision_id, idx, depends_on) SELECT $1, i - 1, dep FROM unnest($2::text[]) WITH ORDINALITY AS x(dep, i)',
        [d.id, d.dependsOn],
      );
      return true;
    });
    return { decision: (await this.get(d.id))!, created };
  }

  async get(id: string): Promise<Decision | null> {
    const { rows } = await this.q(`${DECISION} WHERE d.id = $1`, [id]);
    return rows[0] ? decisionOf(rows[0]) : null;
  }

  async list(f: DecisionFilter = {}): Promise<Decision[]> {
    const p: unknown[] = [];
    const where = decisionWhere(f, p);
    const order = f.order === 'applied' ? 'd.applied_at DESC, ' : '';
    p.push(f.offset ?? 0, f.limit ?? 100);
    const { rows } = await this.q(`${DECISION} ${where} ORDER BY ${order}d.created_at DESC, d.id DESC OFFSET $${p.length - 1} LIMIT $${p.length}`, p);
    return rows.map(decisionOf);
  }

  async count(f: DecisionCountFilter, by: readonly DecisionCountKey[]): Promise<DecisionCount[]> {
    const p: unknown[] = [];
    const where = decisionWhere(f, p);
    const cols = by.map((k) => `${COUNT_COLUMN[k]} AS "${k}"`);
    const { rows } = await this.q(
      `SELECT ${[...cols, 'count(*)::int AS n'].join(', ')} FROM decisions d ${where}${by.length ? ` GROUP BY ${by.map((_, i) => i + 1).join(', ')}` : ''}`, p,
    );
    return rows as DecisionCount[];
  }

  async forTarget(id: string): Promise<Decision[]> {
    const { rows } = await this.q(
      `${DECISION} WHERE d.id IN (SELECT decision_id FROM decision_targets WHERE target_id = $1) ORDER BY d.created_at DESC, d.id DESC`,
      [id],
    );
    return rows.map(decisionOf);
  }

  async loopChanged(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const { rows } = await this.q(
      `SELECT DISTINCT t.target_id AS id FROM decision_targets t JOIN decisions d ON d.id = t.decision_id
       WHERE t.target_id = ANY($1::text[]) AND d.status = 'applied' AND d.decided_by LIKE 'loop:%'
         AND d.after @> jsonb_build_array(jsonb_build_object('id', t.target_id))`,
      [[...new Set(ids)]],
    );
    return rows.map((r) => r.id);
  }

  /** One UPDATE: a move only from one of `from`, so two racing moves cannot both win. */
  private async transition(id: string, from: string[], set: string, params: unknown[] = []): Promise<boolean> {
    const { rowCount } = await this.q(`UPDATE decisions SET ${set} WHERE id = $1 AND status = ANY($2::text[])`, [id, from, ...params]);
    return rowCount! > 0;
  }

  markApplying(id: string, o: { by?: string; syncHoldUntil?: string | null } = {}): Promise<boolean> {
    return this.transition(id, ['proposed', 'observed'], `status = 'applying', decided_at = $3, decided_by = coalesce($4, decided_by), sync_hold_until = $5`,
      [new Date(), o.by ?? null, o.syncHoldUntil ?? null]);
  }

  async markApplied(id: string, after: TargetSnapshot[], o: { syncHoldUntil?: string | null } = {}): Promise<boolean> {
    const safe = await prepareSnapshots(id, after);
    return this.transition(id, ['applying'], `status = 'applied', after = $4::jsonb, applied_at = $3, sync_hold_until = $5`, [new Date(), toJson(safe), o.syncHoldUntil ?? null]);
  }

  async markStatus(id: string, p: DecisionStatusPatch): Promise<boolean> {
    const rollback = p.rollback ? toJson(await prepareRollback(id, p.rollback)) : null;
    return this.transition(id, p.from,
      `status = $4, decided_at = CASE WHEN $5::text IS NULL THEN decided_at ELSE $3 END, decided_by = coalesce($5, decided_by),
       rollback = coalesce($6::jsonb, rollback), superseded_by = coalesce($7, superseded_by), mode = coalesce($8, mode),
       score = coalesce($9, score), confidence = coalesce($10::jsonb, confidence), band = coalesce($11, band)`,
      [new Date(), p.status, p.by ?? null, rollback, p.supersededBy ?? null, p.call?.mode ?? null, p.call?.score ?? null,
        p.call ? toJson(p.call.confidence) : null, p.call?.confidence.band ?? null]);
  }

  ratify(id: string, by: string): Promise<boolean> {
    return this.transition(id, ['applied'], 'ratified_at = $3, ratified_by = $4', [new Date(), by]);
  }

  markLabelled(id: string): Promise<boolean> {
    return this.transition(id, ['applied'], 'labelled_at = $3', [new Date()]);
  }

  async addNote(decisionId: string, input: DecisionNoteInput): Promise<DecisionNote | null> {
    const n = await prepareNote(decisionId, input);
    const { rows } = await this.q(
      `INSERT INTO decision_notes (id, decision_id, ts, by, text, verdict, reason)
       SELECT $1, id, $3, $4, $5, $6, $7 FROM decisions WHERE id = $2 RETURNING *`,
      [n.id, decisionId, n.ts, n.by, n.text, n.verdict, n.reason],
    );
    return rows[0] ? noteOf(rows[0]) : null;
  }

  async notes(decisionId: string): Promise<DecisionNote[]> {
    const { rows } = await this.q('SELECT * FROM decision_notes WHERE decision_id = $1 ORDER BY ts, seq', [decisionId]);
    return rows.map(noteOf);
  }

  async dependents(id: string): Promise<Decision[]> {
    const { rows } = await this.q(
      `${DECISION} WHERE d.id IN (SELECT decision_id FROM decision_deps WHERE depends_on = $1) ORDER BY d.created_at DESC, d.id DESC`,
      [id],
    );
    return rows.map(decisionOf);
  }

  async inFlight(): Promise<Decision[]> {
    const { rows } = await this.q(`${DECISION} WHERE d.status = 'applying' ORDER BY d.created_at, d.id`);
    return rows.map(decisionOf);
  }

  async signals(lessonId: string): Promise<LessonSignals | null> {
    const { rows } = await this.q('SELECT * FROM lesson_signals WHERE lesson_id = $1', [lessonId]);
    return rows[0] ? signalsOf(rows[0]) : null;
  }

  async signalsOf(lessonIds: string[]): Promise<LessonSignals[]> {
    const { rows } = await this.q('SELECT * FROM lesson_signals WHERE lesson_id = ANY($1::text[])', [lessonIds]);
    return rows.map(signalsOf);
  }

  async listSignals(f: { projectKeys?: string[] } = {}) {
    const { rows } = await this.q(
      `SELECT s.*, l.project_key, l.source, l.status, l.run, l.sandbox FROM lesson_signals s JOIN lessons l ON l.id = s.lesson_id
        WHERE $1::text[] IS NULL OR l.project_key IS NULL OR l.project_key = ANY($1)
        ORDER BY s.lesson_id COLLATE "C"`,
      [f.projectKeys ?? null],
    );
    return rows.map((r) => ({
      lessonId: r.lesson_id as string, counts: r.counts, lastServed: iso(r.last_served), lastOwnerTouch: iso(r.last_owner_touch), updatedAt: iso(r.updated_at)!,
      projectKey: r.project_key as string | null, source: r.source, status: r.status, run: r.run as string | null, sandbox: r.sandbox as boolean,
    }));
  }

  async upsertSignals(rows: Omit<LessonSignals, 'updatedAt'>[]): Promise<number> {
    const { rowCount } = await this.q(
      `INSERT INTO lesson_signals (lesson_id, counts, last_served, last_owner_touch, updated_at)
       SELECT s."lessonId", s.counts, s."lastServed", s."lastOwnerTouch", $2
         FROM jsonb_to_recordset($1::jsonb) AS s("lessonId" text, counts jsonb, "lastServed" timestamptz, "lastOwnerTouch" timestamptz)
         JOIN lessons l ON l.id = s."lessonId"
       ON CONFLICT (lesson_id) DO UPDATE SET counts = excluded.counts, last_served = excluded.last_served,
         last_owner_touch = excluded.last_owner_touch, updated_at = excluded.updated_at`,
      [toJson(rows), new Date()],
    );
    return rowCount!;
  }

  async calibration(type: DecisionType, policyVersion: number): Promise<CalibrationBucket[]> {
    const { rows } = await this.q('SELECT * FROM loop_calibration WHERE type = $1 AND policy_version = $2 ORDER BY band', [type, policyVersion]);
    return rows.map(bucketOf);
  }

  async bumpCalibration(b: CalibrationBump): Promise<CalibrationBucket> {
    const { rows } = await this.q(
      `INSERT INTO loop_calibration AS c (type, band, policy_version, alpha, beta, n, updated_at)
       VALUES ($1, $2, $3, $4::float8 + $6::float8, $5::float8 + $7::float8, $8, $9)
       ON CONFLICT (type, band, policy_version) DO UPDATE
         SET alpha = c.alpha + $6::float8, beta = c.beta + $7::float8, n = c.n + $8::int, updated_at = $9
       RETURNING *`,
      [b.type, b.band, b.policyVersion, b.prior.alpha, b.prior.beta, b.alpha, b.beta, b.n, new Date()],
    );
    return bucketOf(rows[0]);
  }

  async linkMisses(link: Omit<MissLink, 'createdAt'>): Promise<boolean> {
    const { rowCount } = await this.q(
      `INSERT INTO miss_links (from_miss_id, to_miss_id, decision_id, created_at)
       SELECT a.id, b.id, $3, $4 FROM misses a, misses b WHERE a.id = $1 AND b.id = $2 AND a.id <> b.id
       ON CONFLICT DO NOTHING`,
      [link.from, link.to, link.decisionId, new Date()],
    );
    return rowCount! > 0;
  }

  async unlinkMisses(link: Pick<MissLink, 'from' | 'to'>): Promise<boolean> {
    const { rowCount } = await this.q('DELETE FROM miss_links WHERE from_miss_id = $1 AND to_miss_id = $2', [link.from, link.to]);
    return rowCount! > 0;
  }

  async missLinks(missId: string): Promise<MissLink[]> {
    const { rows } = await this.q(
      `SELECT * FROM miss_links WHERE from_miss_id = $1 OR to_miss_id = $1
        ORDER BY created_at, from_miss_id COLLATE "C", to_miss_id COLLATE "C"`,
      [missId],
    );
    return rows.map((r) => ({ from: r.from_miss_id, to: r.to_miss_id, decisionId: r.decision_id, createdAt: iso(r.created_at)! }));
  }

  async loopMisses(ids: string[]): Promise<LoopMiss[]> {
    const { rows } = await this.q(
      `SELECT m.id, m.project_key, m.cause, m.missed, m.embedding::text AS embedding, m.created_at, m.subject, m.run, m.sandbox,
              t.session_id,
              coalesce((SELECT array_agg(DISTINCT sf.path) FROM session_files sf WHERE sf.session_id = t.session_id AND sf.edited), '{}') AS files
       FROM misses m JOIN feedback f ON f.id = m.feedback_id LEFT JOIN turns t ON t.uuid = f.turn_uuid
       WHERE m.id = ANY($1::text[])
       ORDER BY m.id COLLATE "C"`,
      [ids],
    );
    return rows.map((r: Row) => ({
      id: r.id, projectKey: r.project_key, cause: r.cause, missed: r.missed, embedding: fromVector(r.embedding), createdAt: iso(r.created_at)!,
      subject: r.subject ?? null, run: r.run ?? null, sandbox: r.sandbox === true, sessionId: r.session_id ?? null,
      editedFiles: (r.files as string[]).toSorted(),
    }));
  }

  async redactStoredDecisions(): Promise<number> {
    let changed = 0;
    for (let after = ''; ;) {
      const { rows } = await this.q(`${DECISION} WHERE d.id > $1 ORDER BY d.id LIMIT $2`, [after, REDACT_PAGE]);
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const page = rows.flatMap((r) => redactStoredDecision(decisionOf(r)) ?? []);
      await this.q(
        `UPDATE decisions x SET before = c.before, after = c.after, evidence = c.evidence, rationale = c.rationale, model = c.model, rollback = c.rollback
         FROM jsonb_to_recordset($1::jsonb) AS c(id text, before jsonb, after jsonb, evidence jsonb, rationale text, model text, rollback jsonb)
         WHERE x.id = c.id`,
        [toJson(page)],
      );
      changed += page.length;
    }
    for (let after = ''; ;) {
      const { rows } = await this.q('SELECT id, text FROM decision_notes WHERE id > $1 ORDER BY id LIMIT $2', [after, REDACT_PAGE]);
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const page = rows.map((r) => ({ id: r.id, text: redactSecrets(r.text) })).filter((n, i) => n.text !== rows[i].text);
      await this.q('UPDATE decision_notes x SET text = c.text FROM jsonb_to_recordset($1::jsonb) AS c(id text, text text) WHERE x.id = c.id', [toJson(page)]);
      changed += page.length;
    }
    return changed;
  }
}
