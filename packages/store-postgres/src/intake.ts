import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  AliasTakenError, aliasNorm, answerClaimIdOf, answerSourceOf, addedQuestionIdOf, archiveBeforeRedaction, claimFingerprint, claimIdOf, cleanClaimDraft,
  cleanConflictInput, cleanQuestionDraft, cleanResolution, conflictFingerprint, conflictIdOf, FORGOTTEN_NAME, questionIdOf, REMOVED_CLAIM, REDACT_PAGE, redactIntakeText, redactSecrets, redactStoredIntake as redactStoredRow,
  TargetChangedError,
} from '@fb/core';
import type {
  AnswerInput, ImportedClaim, Claim, ClaimDraft, ClaimFilter, ClaimHit, ClaimLink, ClaimPatch, ClaimSearch, Conflict, ConflictFilter, ConflictInput, ConflictSide,
  IntakeMeta, IntakeMetaInput, IntakeRedacted, IntakeRemoved, IntakeRunItem, IntakeSnapshotWrite, IntakeStore, Person, PersonPatch, Question, QuestionDraft,
  QuestionFilter, QuestionPatch, RunTag, Supersession, WindowSave,
} from '@fb/core';
import { conditionalWrite } from './conditionalWrite.ts';
import { iso, toJson, toVector, type Db } from './db.ts';
import { runSearch, vectorTerms, visibleToRun } from './vector.ts';

type Query = (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
type Row = Record<string, any>;

const UNDECIDED = ['proposed', 'rejected'];
const UNANSWERED = ['open', 'assigned', 'dismissed'];
const DEFAULT_LIMIT = 100;
const TABLE_OF: Record<ConflictSide['kind'], string> = { claim: 'claims', fact: 'facts', lesson: 'lessons' };
const limits = (f: { limit?: number; offset?: number }) => [Math.max(0, Math.floor(f.limit ?? DEFAULT_LIMIT)), Math.max(0, Math.floor(f.offset ?? 0))];

const claimOf = (r: Row): Claim => ({
  id: r.id, projectKey: r.project_key, docId: r.doc_id, window: r.window, span: r.utt === null ? null : { utt: r.utt, start: r.span_start, end: r.span_end },
  type: r.type, statement: r.statement, quote: r.quote, speakerId: r.speaker_id, assertedAt: r.asserted_at, confidence: r.confidence,
  scope: { area: r.scope?.area ?? null, files: r.scope?.files ?? [] }, about: r.about, due: r.due, flags: r.flags ?? [], status: r.status,
  decidedBy: r.decided_by, decidedAt: iso(r.decided_at), factId: r.fact_id, createdAt: iso(r.created_at)!, run: r.run, sandbox: r.sandbox === true,
});
const questionOf = (r: Row): Question => ({
  id: r.id, projectKey: r.project_key, docId: r.doc_id, window: r.window, text: r.text, kind: r.kind, quote: r.quote, askedBy: r.asked_by,
  assignee: r.assignee, status: r.status, answerClaimId: r.answer_claim_id, decidedBy: r.decided_by, decidedAt: iso(r.decided_at),
  createdAt: iso(r.created_at)!, run: r.run, sandbox: r.sandbox === true,
});
const sideOf = (s: Row): ConflictSide => ({ kind: s.kind, id: s.ref_id, fingerprint: s.fingerprint, assertedAt: s.asserted_at });
const conflictOf = (r: Row): Conflict => ({
  id: r.id, kind: r.kind, status: r.status, projectKey: r.project_key, a: sideOf(r.a), b: sideOf(r.b), signals: r.signals ?? [], judge: r.judge,
  resolution: r.resolution, decisionId: r.decision_id, createdAt: iso(r.created_at)!, resolvedAt: iso(r.resolved_at), resolvedBy: r.resolved_by,
  run: r.run, sandbox: r.sandbox === true,
});
const personOf = (r: Row): Person => ({
  id: r.id, displayName: r.display_name, isOwner: r.is_owner, status: r.status, aliases: r.aliases ?? [], claims: r.claims ?? 0, createdAt: iso(r.created_at)!,
});

/** A conflict with its two sides as `a` and `b` (jsonb rows of conflict_sides). */
const CONFLICT_SELECT = `SELECT c.*,
  (SELECT to_jsonb(s) FROM conflict_sides s WHERE s.conflict_id = c.id AND s.role = 'a') AS a,
  (SELECT to_jsonb(s) FROM conflict_sides s WHERE s.conflict_id = c.id AND s.role = 'b') AS b
  FROM conflicts c`;
const PERSON_SELECT = `SELECT p.*,
  coalesce((SELECT array_agg(a.alias_norm ORDER BY a.alias_norm COLLATE "C") FROM person_aliases a WHERE a.person_id = p.id), '{}') AS aliases,
  (SELECT count(*) FROM claims c WHERE c.speaker_id = p.id) AS claims
  FROM people p`;
/** `ref` (kind, id columns or parameters) names a record that exists. */
const exists = (kind: string, id: string) =>
  `CASE ${kind} WHEN 'claim' THEN EXISTS (SELECT 1 FROM claims WHERE id = ${id}) WHEN 'fact' THEN EXISTS (SELECT 1 FROM facts WHERE id = ${id})
   ELSE EXISTS (SELECT 1 FROM lessons WHERE id = ${id}) END`;

/** The claim columns a draft sets, in insert order after id. */
const CLAIM_DRAFT_COLUMNS = 'type, statement, quote, speaker_id, utt, span_start, span_end, asserted_at, confidence, scope, about, due, flags, embedding';
const draftValues = (c: ClaimDraft) => [
  c.type, c.statement, c.quote, c.speakerId, c.span?.utt ?? null, c.span?.start ?? null, c.span?.end ?? null, c.assertedAt, c.confidence, toJson(c.scope),
  c.about, c.due, c.flags, toVector(c.embedding),
];

/** A source's details, with who attended (Neo4j: properties of its Doc). */
const META_SELECT = `SELECT s.*, d.added_at,
  coalesce((SELECT array_agg(person_id ORDER BY person_id COLLATE "C") FROM source_people p WHERE p.doc_id = s.doc_id), '{}') AS participants
  FROM intake_sources s JOIN docs d ON d.id = s.doc_id`;

/** Knowledge intake on Postgres (0062_intake.sql). */
/**
 * Delete these claims whatever their status, with what names them: their links, supersessions and the conflicts they
 * are a side of (the judge quoted them), and their text in Activity (a claim_decided subject quotes the statement).
 */
async function deleteClaimsIn(query: Query, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  await query('DELETE FROM conflicts WHERE id IN (SELECT conflict_id FROM conflict_sides WHERE kind = \'claim\' AND ref_id = ANY($1::text[]))', [ids]);
  await query('DELETE FROM supersessions WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[])', [ids]);
  await query('DELETE FROM claim_links WHERE to_id = ANY($1::text[])', [ids]);
  await query(`UPDATE activity SET subject = $2 WHERE kind = 'claim_decided' AND targets && $1::text[]`, [ids, REMOVED_CLAIM]);
  const r = await query('DELETE FROM claims WHERE id = ANY($1::text[])', [ids]);
  return r.rowCount ?? 0;
}

export class PgIntakeStore implements IntakeStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private write<T>(fn: (query: Query) => Promise<T>, changed: (r: T) => boolean = () => true): Promise<T> {
    return conditionalWrite(this.db, fn, changed);
  }

  async upsertMeta(meta: IntakeMetaInput): Promise<boolean> {
    return this.write(async (query) => {
      const { rowCount } = await query(
        `INSERT INTO intake_sources (doc_id, kind, format, occurred_at, origin, private)
         SELECT id, $2, $3, $4, $5, $6 FROM docs WHERE id = $1
         ON CONFLICT (doc_id) DO UPDATE SET kind = EXCLUDED.kind, format = EXCLUDED.format, occurred_at = EXCLUDED.occurred_at,
           origin = EXCLUDED.origin, private = EXCLUDED.private`,
        [meta.docId, meta.kind, meta.format, meta.occurredAt, meta.origin === null ? null : redactIntakeText(meta.origin), meta.private],
      );
      if (!rowCount) return false;
      await query('DELETE FROM source_people WHERE doc_id = $1', [meta.docId]);
      await query(
        `INSERT INTO source_people (doc_id, person_id) SELECT $1, p.id FROM people p WHERE p.id = ANY($2::text[]) ON CONFLICT DO NOTHING`,
        [meta.docId, meta.participants],
      );
      return true;
    }, (ok) => ok);
  }

  async metas(docIds: string[]): Promise<IntakeMeta[]> {
    if (!docIds.length) return [];
    const { rows } = await this.db.pool.query(`${META_SELECT} WHERE s.doc_id = ANY($1::text[])`, [docIds]);
    return rows.map((r) => {
      const current = r.windows_version === iso(r.added_at);
      return {
        docId: r.doc_id, kind: r.kind, format: r.format, occurredAt: r.occurred_at, origin: r.origin, private: r.private, participants: r.participants,
        windowsDone: current ? r.windows_done : 0, windowsTotal: current ? r.windows_total : null,
      };
    });
  }

  async nextWindow(docId: string): Promise<{ window: number; version: string } | null> {
    const { rows: [r] } = await this.db.pool.query(`${META_SELECT} WHERE s.doc_id = $1`, [docId]);
    if (!r) return null;
    const version = iso(r.added_at)!;
    return { window: r.windows_version === version ? r.windows_done : 0, version };
  }

  async saveWindow(docId: string, w: WindowSave): Promise<boolean> {
    const claims = w.claims.map(cleanClaimDraft).map((c, n) => ({ id: claimIdOf(docId, w.version, w.window, n), c }));
    const questions = w.questions.map(cleanQuestionDraft).map((q, n) => ({ id: questionIdOf(docId, w.version, w.window, n), q }));
    return this.write(async (query) => {
      // The source row's lock orders this against another save of the same source.
      const { rows: [s] } = await query(
        `SELECT s.windows_version, d.added_at, d.project_key, d.run, d.sandbox FROM intake_sources s JOIN docs d ON d.id = s.doc_id WHERE s.doc_id = $1 FOR UPDATE OF s`,
        [docId],
      );
      if (!s || iso(s.added_at) !== w.version) return false;
      if (s.windows_version !== w.version) {
        // The first save of a new upload: the old upload's undecided records go.
        await query(`DELETE FROM claims WHERE doc_id = $1 AND "window" IS NOT NULL AND status = ANY($2::text[])`, [docId, UNDECIDED]);
        await query(`DELETE FROM questions WHERE doc_id = $1 AND "window" IS NOT NULL AND status = ANY($2::text[])`, [docId, UNANSWERED]);
        await query('UPDATE intake_sources SET windows_done = 0, windows_total = NULL, windows_version = $2 WHERE doc_id = $1', [docId, w.version]);
      }
      const now = new Date();
      for (const { id, c } of claims) {
        await query(
          `INSERT INTO claims (id, ${CLAIM_DRAFT_COLUMNS}, project_key, doc_id, "window", version, status, created_at, run, sandbox)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::text[], $15::vector, $16, $17, $18, $19, 'proposed', $20, $21, $22)
           ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, statement = EXCLUDED.statement, quote = EXCLUDED.quote, speaker_id = EXCLUDED.speaker_id,
             utt = EXCLUDED.utt, span_start = EXCLUDED.span_start, span_end = EXCLUDED.span_end, asserted_at = EXCLUDED.asserted_at,
             confidence = EXCLUDED.confidence, scope = EXCLUDED.scope, about = EXCLUDED.about, due = EXCLUDED.due, flags = EXCLUDED.flags,
             embedding = EXCLUDED.embedding
           WHERE claims.status = 'proposed'`,
          [id, ...draftValues(c), s.project_key, docId, w.window, w.version, now, s.run, s.sandbox],
        );
      }
      await query(
        `DELETE FROM claims WHERE doc_id = $1 AND "window" = $2 AND version = $3 AND status = 'proposed' AND NOT (id = ANY($4::text[]))`,
        [docId, w.window, w.version, claims.map((c) => c.id)],
      );
      for (const { id, q } of questions) {
        await query(
          `INSERT INTO questions (id, text, kind, quote, asked_by, project_key, doc_id, "window", version, status, created_at, run, sandbox)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12)
           ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, kind = EXCLUDED.kind, quote = EXCLUDED.quote, asked_by = EXCLUDED.asked_by
           WHERE questions.status = 'open'`,
          [id, q.text, q.kind, q.quote, q.askedBy, s.project_key, docId, w.window, w.version, now, s.run, s.sandbox],
        );
      }
      await query(
        `DELETE FROM questions WHERE doc_id = $1 AND "window" = $2 AND version = $3 AND status = 'open' AND NOT (id = ANY($4::text[]))`,
        [docId, w.window, w.version, questions.map((q) => q.id)],
      );
      await query(
        'UPDATE intake_sources SET windows_done = GREATEST(windows_done, $2), windows_total = coalesce($3, windows_total) WHERE doc_id = $1',
        [docId, w.window + 1, w.total ?? null],
      );
      return true;
    }, (ok) => ok);
  }

  async removeSource(docId: string, o: { everything?: boolean; people?: string[] } = {}): Promise<{ claim: number; question: number; people: number }> {
    return this.write(async (query) => {
      // Everything: every claim whatever its status, and the proposed people nothing else names, found before their ties go.
      const { rows: people } = o.everything
        ? await query('SELECT person_id AS id FROM source_people WHERE doc_id = $1 UNION SELECT speaker_id FROM claims WHERE doc_id = $1 AND speaker_id IS NOT NULL', [docId])
        : { rows: [] };
      const { rows: ids } = await query('SELECT id FROM claims WHERE doc_id = $1 AND ($2 OR status = ANY($3::text[]))', [docId, !!o.everything, UNDECIDED]);
      const claim = await deleteClaimsIn(query, ids.map((r) => r.id as string));
      const q = await query('DELETE FROM questions WHERE doc_id = $1', [docId]);
      await query('DELETE FROM intake_sources WHERE doc_id = $1', [docId]);
      const named = [...new Set([...people.map((r) => r.id as string), ...(o.people ?? [])])];
      const gone = named.length
        ? await query(
          `DELETE FROM people p WHERE p.id = ANY($1::text[]) AND p.status = 'proposed' AND NOT p.is_owner
             AND NOT EXISTS (SELECT 1 FROM source_people s WHERE s.person_id = p.id) AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.speaker_id = p.id)
             AND NOT EXISTS (SELECT 1 FROM questions x WHERE x.asked_by = p.id OR x.assignee = p.id)`,
          [named],
        )
        : null;
      return { claim, question: q.rowCount ?? 0, people: gone?.rowCount ?? 0 };
    });
  }

  async deleteClaims(ids: string[]): Promise<number> {
    return this.write((query) => deleteClaimsIn(query, ids), (n) => n > 0);
  }

  async listClaims(f: ClaimFilter = {}): Promise<Claim[]> {
    const { rows } = await this.db.pool.query(
      `SELECT * FROM claims x
       WHERE ($1::text[] IS NULL OR x.id = ANY($1)) AND ($2::text[] IS NULL OR x.status = ANY($2)) AND ($3::text[] IS NULL OR x.type = ANY($3))
         AND ($4::text[] IS NULL OR x.project_key IS NULL OR x.project_key = ANY($4)) AND ($5::text IS NULL OR x.doc_id = $5)
         AND ($6::text IS NULL OR x.speaker_id = $6) AND ${visibleToRun('x', '$7')}
       ORDER BY x.created_at DESC, x.id COLLATE "C" LIMIT $8 OFFSET $9`,
      [f.ids ?? null, f.status ?? null, f.type ?? null, f.projectKeys ?? null, f.docId ?? null, f.speakerId ?? null, f.run ?? null, ...limits(f)],
    );
    return rows.map(claimOf);
  }

  async claim(id: string): Promise<Claim | null> {
    const { rows: [r] } = await this.db.pool.query('SELECT * FROM claims WHERE id = $1', [id]);
    return r ? claimOf(r) : null;
  }

  async decideClaim(id: string, patch: ClaimPatch, o: { by: string; expect?: string }): Promise<Claim | null> {
    const changed = await this.write(async (query) => {
      const { rows: [r] } = await query('SELECT * FROM claims WHERE id = $1 FOR UPDATE', [id]);
      if (!r) return false;
      const cur = claimOf(r);
      if (o.expect !== undefined && claimFingerprint(cur) !== o.expect) throw new TargetChangedError(id, o.expect, claimFingerprint(cur));
      const set: [string, unknown][] = [];
      if (patch.status !== undefined) set.push(['status', patch.status]);
      if (patch.statement !== undefined) set.push(['statement', redactIntakeText(patch.statement)]);
      if (patch.type !== undefined) set.push(['type', patch.type]);
      if (patch.about !== undefined) set.push(['about', redactIntakeText(patch.about)]);
      if (patch.factId !== undefined) set.push(['fact_id', patch.factId]);
      if (patch.embedding !== undefined) set.push(['embedding', toVector(patch.embedding)]);
      if (patch.scope !== undefined) set.push(['scope', toJson({ area: patch.scope.area === null ? null : redactIntakeText(patch.scope.area), files: patch.scope.files.map(redactSecrets) })]);
      if (patch.status !== undefined && patch.status !== cur.status) set.push(['decided_by', o.by], ['decided_at', new Date()]);
      if (set.length) {
        const cast: Record<string, string> = { embedding: '::vector', scope: '::jsonb' };
        await query(`UPDATE claims SET ${set.map(([k], i) => `${k} = $${i + 2}${cast[k] ?? ''}`).join(', ')} WHERE id = $1`, [id, ...set.map(([, v]) => v)]);
      }
      return true;
    }, (ok) => ok);
    return changed ? this.claim(id) : null;
  }

  async searchClaims(q: ClaimSearch): Promise<ClaimHit[]> {
    const v = vectorTerms(this.db, 'c.embedding', '$1', q.embedding.length);
    const rows = await runSearch(this.db, {
      sql: `SELECT x.*, 1 - x.distance / 2 AS score
            FROM (SELECT c.*, ${v.distance} AS distance FROM claims c
                  WHERE c.status = ANY($2::text[]) AND ($3::text[] IS NULL OR c.type = ANY($3)) AND ($4::text[] IS NULL OR c.project_key IS NULL OR c.project_key = ANY($4))
                    AND ($5::text IS NULL OR c.speaker_id = $5) AND ${visibleToRun('c', '$6')} AND ${v.where}
                  ORDER BY ${v.distance}, c.id LIMIT $7) x
            ORDER BY score DESC, x.id COLLATE "C"`,
      params: [q.embedding.length ? toVector(q.embedding) : null, q.status ?? ['accepted'], q.type ?? null, q.projectKeys ?? null, q.speakerId ?? null, q.run ?? null, q.k],
    }, q.k);
    return rows.map((r) => ({ claim: claimOf(r), score: r.score }));
  }

  async addLinks(links: ClaimLink[]): Promise<number> {
    if (!links.length) return 0;
    return this.write(async (query) => {
      const { rowCount } = await query(
        `INSERT INTO claim_links (from_id, to_kind, to_id, rel, created_at)
         SELECT l.from_id, l.to_kind, l.to_id, l.rel, $5 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS l(from_id, to_kind, to_id, rel)
         WHERE EXISTS (SELECT 1 FROM claims WHERE id = l.from_id) AND ${exists('l.to_kind', 'l.to_id')}
         ON CONFLICT DO NOTHING`,
        [links.map((l) => l.from), links.map((l) => l.to.kind), links.map((l) => l.to.id), links.map((l) => l.rel), new Date()],
      );
      return rowCount ?? 0;
    }, (n) => n > 0);
  }

  async importClaims(claims: ImportedClaim[]): Promise<string[]> {
    if (!claims.length) return [];
    return this.write(async (query) => {
      const added: string[] = [];
      const now = new Date();
      for (const c of claims) {
        const draft = cleanClaimDraft({ ...c, span: null, flags: [] });
        const { rowCount } = await query(
          `INSERT INTO claims (id, ${CLAIM_DRAFT_COLUMNS}, project_key, doc_id, "window", version, status, decided_by, decided_at, fact_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::text[], $15::vector, $16, $17, NULL, NULL, $18, $19, $20, $21, $22)
           ON CONFLICT (id) DO NOTHING`,
          [c.id, ...draftValues(draft), c.projectKey, c.docId, c.status, c.decidedBy, c.decidedAt === null ? null : new Date(c.decidedAt), c.factId, now],
        );
        if (rowCount) added.push(c.id);
      }
      return added;
    }, (ids) => ids.length > 0);
  }

  async removeLinks(links: ClaimLink[]): Promise<number> {
    if (!links.length) return 0;
    return this.write(async (query) => {
      const { rowCount } = await query(
        `DELETE FROM claim_links c USING unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS l(from_id, to_kind, to_id, rel)
         WHERE c.from_id = l.from_id AND c.to_kind = l.to_kind AND c.to_id = l.to_id AND c.rel = l.rel`,
        [links.map((l) => l.from), links.map((l) => l.to.kind), links.map((l) => l.to.id), links.map((l) => l.rel)],
      );
      return rowCount ?? 0;
    }, (n) => n > 0);
  }

  async links(ids: string[]): Promise<ClaimLink[]> {
    if (!ids.length) return [];
    const { rows } = await this.db.pool.query(
      `SELECT * FROM claim_links WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[])
       ORDER BY from_id COLLATE "C", to_kind COLLATE "C", to_id COLLATE "C", rel COLLATE "C"`,
      [ids],
    );
    return rows.map((r) => ({ from: r.from_id, to: { kind: r.to_kind, id: r.to_id }, rel: r.rel }));
  }

  async people(f: { status?: Person['status'][] } = {}): Promise<Person[]> {
    const { rows } = await this.db.pool.query(
      `${PERSON_SELECT} WHERE $1::text[] IS NULL OR p.status = ANY($1) ORDER BY p.is_owner DESC, p.display_name COLLATE "C", p.id COLLATE "C"`,
      [f.status ?? null],
    );
    return rows.map(personOf);
  }

  async person(id: string): Promise<Person | null> {
    const { rows: [r] } = await this.db.pool.query(`${PERSON_SELECT} WHERE p.id = $1`, [id]);
    return r ? personOf(r) : null;
  }

  async ensureOwner(displayName: string): Promise<Person> {
    const norm = aliasNorm(displayName);
    await this.write(async (query) => {
      // One owner however many start at once: a fixed id, and the one-owner index.
      const { rowCount } = await query(
        `INSERT INTO people (id, display_name, is_owner, status, created_at) VALUES ('person:owner', $1, true, 'confirmed', $2) ON CONFLICT DO NOTHING`,
        [displayName, new Date()],
      );
      if (rowCount && norm) await query(`INSERT INTO person_aliases (alias_norm, person_id) VALUES ($1, 'person:owner') ON CONFLICT DO NOTHING`, [norm]);
      return (rowCount ?? 0) > 0;
    }, (made) => made);
    const { rows: [r] } = await this.db.pool.query(`${PERSON_SELECT} WHERE p.is_owner`);
    return personOf(r);
  }

  async resolveAlias(name: string, o: { create?: boolean } = {}): Promise<{ person: Person; created: boolean } | null> {
    const norm = aliasNorm(name);
    if (!norm) return null;
    const found = async () => (await this.db.pool.query('SELECT person_id FROM person_aliases WHERE alias_norm = $1', [norm])).rows[0]?.person_id as string | undefined;
    const known = await found();
    if (known) return { person: (await this.person(known))!, created: false };
    if (!o.create) return null;
    const id = `person:${randomUUID()}`;
    const created = await this.write(async (query) => {
      await query(`INSERT INTO people (id, display_name, is_owner, status, created_at) VALUES ($1, $2, false, 'proposed', $3)`, [id, redactIntakeText(name.trim()), new Date()]);
      // Two resolving the same new name at once: the alias's key lets one in, and the other's person is rolled back.
      const { rowCount } = await query('INSERT INTO person_aliases (alias_norm, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [norm, id]);
      return (rowCount ?? 0) > 0;
    }, (made) => made);
    return { person: (await this.person(created ? id : (await found())!))!, created };
  }

  async updatePerson(id: string, patch: PersonPatch): Promise<Person | null> {
    const ok = await this.write(async (query) => {
      const { rows: [p] } = await query('SELECT id FROM people WHERE id = $1 FOR UPDATE', [id]);
      if (!p) return false;
      if (patch.displayName !== undefined) await query('UPDATE people SET display_name = $2 WHERE id = $1', [id, redactIntakeText(patch.displayName.trim())]);
      if (patch.status !== undefined) await query('UPDATE people SET status = $2 WHERE id = $1', [id, patch.status]);
      const removed = (patch.removeAliases ?? []).map(aliasNorm).filter(Boolean);
      if (removed.length) await query('DELETE FROM person_aliases WHERE person_id = $1 AND alias_norm = ANY($2::text[])', [id, removed]);
      for (const norm of (patch.addAliases ?? []).map(aliasNorm).filter(Boolean)) {
        const { rows: [held] } = await query(
          `INSERT INTO person_aliases (alias_norm, person_id) VALUES ($1, $2)
           ON CONFLICT (alias_norm) DO UPDATE SET alias_norm = EXCLUDED.alias_norm RETURNING person_id`,
          [norm, id],
        );
        if (held.person_id !== id) throw new AliasTakenError(norm, held.person_id);
      }
      return true;
    }, (done) => done);
    return ok ? this.person(id) : null;
  }

  async mergePeople(keepId: string, mergedId: string): Promise<Person | null> {
    if (keepId === mergedId) throw new Error('a person cannot be merged into itself');
    const ok = await this.write(async (query) => {
      const { rows } = await query('SELECT id, is_owner FROM people WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [[keepId, mergedId]]);
      if (rows.length < 2) return false;
      if (rows.some((r) => r.id === mergedId && r.is_owner)) throw new Error('the owner cannot be merged into someone else');
      await query('UPDATE person_aliases SET person_id = $1 WHERE person_id = $2', [keepId, mergedId]);
      await query('UPDATE claims SET speaker_id = $1 WHERE speaker_id = $2', [keepId, mergedId]);
      await query('UPDATE questions SET asked_by = $1 WHERE asked_by = $2', [keepId, mergedId]);
      await query('UPDATE questions SET assignee = $1 WHERE assignee = $2', [keepId, mergedId]);
      await query(
        'INSERT INTO source_people (doc_id, person_id) SELECT doc_id, $1 FROM source_people WHERE person_id = $2 ON CONFLICT DO NOTHING',
        [keepId, mergedId],
      );
      await query('DELETE FROM people WHERE id = $1', [mergedId]);
      return true;
    }, (done) => done);
    return ok ? this.person(keepId) : null;
  }

  async forgetPerson(id: string): Promise<{ person: Person; claimsRemoved: number } | null> {
    const removed = await this.write(async (query) => {
      const { rows: [p] } = await query('SELECT is_owner, display_name FROM people WHERE id = $1 FOR UPDATE', [id]);
      if (!p) return null;
      if (p.is_owner) throw new Error('the owner cannot be forgotten');
      // Their name leaves what still carries it: the facts their accepted claims became ("Ana, 2026-11-10 call"), and
      // the person entries in Activity about them (subjects; details hold names and aliases, so they go).
      await query('UPDATE facts f SET why = replace(f.why, $2, $3) FROM claims c WHERE c.speaker_id = $1 AND c.fact_id = f.id', [id, p.display_name, FORGOTTEN_NAME]);
      await query(`UPDATE activity SET subject = replace(subject, $2, $3), details = '{}' WHERE kind = 'person_changed' AND $1 = ANY(targets)`, [id, p.display_name, FORGOTTEN_NAME]);
      await query('DELETE FROM person_aliases WHERE person_id = $1', [id]);
      const c = await query('DELETE FROM claims WHERE speaker_id = $1 AND status = ANY($2::text[])', [id, UNDECIDED]);
      await query(`UPDATE people SET display_name = $2, status = 'forgotten' WHERE id = $1`, [id, FORGOTTEN_NAME]);
      return c.rowCount ?? 0;
    }, (n) => n !== null);
    return removed === null ? null : { person: (await this.person(id))!, claimsRemoved: removed };
  }

  async listQuestions(f: QuestionFilter = {}): Promise<Question[]> {
    const { rows } = await this.db.pool.query(
      `SELECT * FROM questions x
       WHERE ($1::text[] IS NULL OR x.id = ANY($1)) AND ($2::text[] IS NULL OR x.status = ANY($2)) AND ($3::text[] IS NULL OR x.kind = ANY($3))
         AND ($4::text[] IS NULL OR x.project_key IS NULL OR x.project_key = ANY($4)) AND ($5::text IS NULL OR x.doc_id = $5)
         AND ($6::text IS NULL OR x.assignee = $6) AND ${visibleToRun('x', '$7')}
       ORDER BY x.created_at DESC, x.id COLLATE "C" LIMIT $8 OFFSET $9`,
      [f.ids ?? null, f.status ?? null, f.kind ?? null, f.projectKeys ?? null, f.docId ?? null, f.assignee ?? null, f.run ?? null, ...limits(f)],
    );
    return rows.map(questionOf);
  }

  async question(id: string): Promise<Question | null> {
    const { rows: [r] } = await this.db.pool.query('SELECT * FROM questions WHERE id = $1', [id]);
    return r ? questionOf(r) : null;
  }

  async addQuestion(q: QuestionDraft & { docId: string; projectKey: string | null; run?: RunTag | null }): Promise<{ question: Question; created: boolean }> {
    const clean = cleanQuestionDraft(q);
    const id = addedQuestionIdOf(q.docId, clean.text);
    const created = await this.write(async (query) => {
      const { rowCount } = await query(
        `INSERT INTO questions (id, text, kind, quote, asked_by, project_key, doc_id, status, created_at, run, sandbox)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [id, clean.text, clean.kind, clean.quote, clean.askedBy, q.projectKey, q.docId, new Date(), q.run?.id ?? null, !!q.run?.sandbox],
      );
      return (rowCount ?? 0) > 0;
    }, (made) => made);
    return { question: (await this.question(id))!, created };
  }

  async updateQuestion(id: string, patch: QuestionPatch, by: string): Promise<Question | null> {
    const ok = await this.write(async (query) => {
      const { rowCount } = await query(
        `UPDATE questions SET status = CASE WHEN $2 THEN $3 ELSE status END, assignee = CASE WHEN $4 THEN $5 ELSE assignee END,
           answer_claim_id = CASE WHEN $8 THEN $9 ELSE answer_claim_id END, decided_by = $6, decided_at = $7 WHERE id = $1`,
        [id, patch.status !== undefined, patch.status ?? null, patch.assignee !== undefined, patch.assignee ?? null, by, new Date(), patch.answerClaimId !== undefined, patch.answerClaimId ?? null],
      );
      return (rowCount ?? 0) > 0;
    }, (done) => done);
    return ok ? this.question(id) : null;
  }

  async answerQuestion(id: string, answer: AnswerInput, by: string): Promise<{ question: Question; claim: Claim } | null> {
    const claimId = answerClaimIdOf(id);
    const ok = await this.write(async (query) => {
      const { rows: [q] } = await query('SELECT * FROM questions WHERE id = $1 FOR UPDATE', [id]);
      if (!q) return false;
      const now = new Date();
      const draft = cleanClaimDraft({ ...answer, quote: answer.statement, span: null, assertedAt: now.toISOString(), confidence: 1, due: null, flags: [] });
      await query(
        `INSERT INTO claims (id, ${CLAIM_DRAFT_COLUMNS}, project_key, doc_id, "window", version, status, decided_by, decided_at, created_at, run, sandbox)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::text[], $15::vector, $16, $17, NULL, NULL, 'accepted', $18, $19, $19, $20, $21)
         ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, statement = EXCLUDED.statement, quote = EXCLUDED.quote, speaker_id = EXCLUDED.speaker_id,
           asserted_at = EXCLUDED.asserted_at, scope = EXCLUDED.scope, about = EXCLUDED.about, embedding = EXCLUDED.embedding, status = 'accepted',
           decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at`,
        [claimId, ...draftValues(draft), q.project_key, answerSourceOf(id), by, now, q.run, q.sandbox],
      );
      await query(`UPDATE questions SET status = 'answered', answer_claim_id = $2, decided_by = $3, decided_at = $4 WHERE id = $1`, [id, claimId, by, now]);
      return true;
    }, (done) => done);
    return ok ? { question: (await this.question(id))!, claim: (await this.claim(claimId))! } : null;
  }

  async openConflict(raw: ConflictInput): Promise<{ conflict: Conflict; created: boolean }> {
    const input = cleanConflictInput(raw);
    const id = conflictIdOf(input.a, input.b);
    const created = await this.write(async (query) => {
      const { rows: [cur] } = await query(`${CONFLICT_SELECT} WHERE c.id = $1 FOR UPDATE OF c`, [id]);
      if (cur) {
        const c = conflictOf(cur);
        const stored = new Map([c.a, c.b].map((s) => [`${s.kind}:${s.id}`, s.fingerprint]));
        if (c.status !== 'dismissed' || [input.a, input.b].every((s) => stored.get(`${s.kind}:${s.id}`) === s.fingerprint)) return false;
        await query(
          `UPDATE conflicts SET kind = $2, project_key = $3, signals = $4::jsonb, judge = $5::jsonb, status = 'open', resolution = NULL, resolved_at = NULL,
             resolved_by = NULL, decision_id = NULL WHERE id = $1`,
          [id, input.kind, input.projectKey, toJson(input.signals), input.judge === null ? null : toJson(input.judge)],
        );
        await query('DELETE FROM conflict_sides WHERE conflict_id = $1', [id]);
      } else {
        await query(
          `INSERT INTO conflicts (id, kind, status, project_key, signals, judge, created_at, run, sandbox) VALUES ($1, $2, 'open', $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
          [id, input.kind, input.projectKey, toJson(input.signals), input.judge === null ? null : toJson(input.judge), new Date(), input.run?.id ?? null, !!input.run?.sandbox],
        );
      }
      await query(
        `INSERT INTO conflict_sides (conflict_id, role, kind, ref_id, fingerprint, asserted_at) VALUES ($1, 'a', $2, $3, $4, $5), ($1, 'b', $6, $7, $8, $9)`,
        [id, input.a.kind, input.a.id, input.a.fingerprint, input.a.assertedAt, input.b.kind, input.b.id, input.b.fingerprint, input.b.assertedAt],
      );
      return true;
    }, (made) => made);
    return { conflict: (await this.conflict(id))!, created };
  }

  async conflict(id: string): Promise<Conflict | null> {
    const { rows: [r] } = await this.db.pool.query(`${CONFLICT_SELECT} WHERE c.id = $1`, [id]);
    return r ? conflictOf(r) : null;
  }

  async listConflicts(f: ConflictFilter = {}): Promise<Conflict[]> {
    const { rows } = await this.db.pool.query(
      `${CONFLICT_SELECT}
       WHERE ($1::text[] IS NULL OR c.id = ANY($1)) AND ($2::text[] IS NULL OR c.status = ANY($2)) AND ($3::text[] IS NULL OR c.kind = ANY($3))
         AND ($4::text[] IS NULL OR c.project_key IS NULL OR c.project_key = ANY($4)) AND ${visibleToRun('c', '$5')}
       ORDER BY c.created_at DESC, c.id COLLATE "C" LIMIT $6 OFFSET $7`,
      [f.ids ?? null, f.status ?? null, f.kind ?? null, f.projectKeys ?? null, f.run ?? null, ...limits(f)],
    );
    return rows.map(conflictOf);
  }

  async conflictsFor(ids: string[], o: { status?: Conflict['status'][] } = {}): Promise<Conflict[]> {
    if (!ids.length) return [];
    const { rows } = await this.db.pool.query(
      `${CONFLICT_SELECT}
       WHERE c.status = ANY($2::text[]) AND EXISTS (SELECT 1 FROM conflict_sides s LEFT JOIN claims x ON s.kind = 'claim' AND x.id = s.ref_id
                                                   WHERE s.conflict_id = c.id AND (s.ref_id = ANY($1::text[]) OR x.fact_id = ANY($1::text[])))
       ORDER BY c.created_at DESC, c.id COLLATE "C"`,
      [ids, o.status ?? ['open']],
    );
    return rows.map(conflictOf);
  }

  async writeSnapshots(writes: IntakeSnapshotWrite[], o: { supersede?: Supersession[]; unsupersede?: Supersession[] } = {}): Promise<void> {
    const claims = writes.flatMap((w) => (w.kind === 'claim' ? [w] : []));
    const conflicts = writes.flatMap((w) => (w.kind === 'conflict' ? [w] : []));
    await this.write(async (query) => {
      // Every target locked and compared before any is written: one that changed leaves them all as they were.
      const { rows: cRows } = await query('SELECT * FROM claims WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [claims.map((w) => w.id)]);
      const { rows: kRows } = await query(`${CONFLICT_SELECT} WHERE c.id = ANY($1::text[]) ORDER BY c.id FOR UPDATE OF c`, [conflicts.map((w) => w.id)]);
      const now = new Map<string, string>([
        ...cRows.map((r) => [`claim:${r.id}`, claimFingerprint(claimOf(r))] as [string, string]),
        ...kRows.map((r) => [`conflict:${r.id}`, conflictFingerprint(conflictOf(r))] as [string, string]),
      ]);
      for (const w of writes) {
        const actual = now.get(`${w.kind}:${w.id}`) ?? null;
        if (actual !== w.expect) throw new TargetChangedError(w.id, w.expect, actual);
      }
      for (const { id, fields: f } of claims) {
        await query(
          `UPDATE claims SET status = $2, statement = $3, type = $4, scope = $5::jsonb, decided_by = $6, decided_at = $7, fact_id = $8 WHERE id = $1`,
          [id, f.status, redactIntakeText(f.statement), f.type, toJson(f.scope), f.decidedBy, f.decidedAt, f.factId],
        );
      }
      for (const { id, fields: f } of conflicts) {
        const resolution = cleanResolution(f.resolution);
        await query(
          'UPDATE conflicts SET status = $2, resolution = $3::jsonb, resolved_by = $4, resolved_at = $5, decision_id = $6 WHERE id = $1',
          [id, f.status, resolution === null ? null : toJson(resolution), f.resolvedBy, f.resolvedAt, f.decisionId],
        );
      }
      for (const s of o.supersede ?? []) {
        await query(
          `INSERT INTO supersessions (from_kind, from_id, to_kind, to_id, conflict_id) SELECT $1, $2, $3, $4, $5
           WHERE ${exists('$1::text', '$2')} AND ${exists('$3::text', '$4')} ON CONFLICT DO NOTHING`,
          [s.from.kind, s.from.id, s.to.kind, s.to.id, s.conflictId],
        );
      }
      for (const s of o.unsupersede ?? []) {
        await query('DELETE FROM supersessions WHERE from_id = $1 AND to_id = $2 AND conflict_id = $3', [s.from.id, s.to.id, s.conflictId]);
      }
      return true;
    });
  }

  async supersessions(ids: string[]): Promise<Supersession[]> {
    if (!ids.length) return [];
    const { rows } = await this.db.pool.query(
      `SELECT * FROM supersessions WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[])
       ORDER BY from_id COLLATE "C", to_id COLLATE "C", conflict_id COLLATE "C"`,
      [ids],
    );
    return rows.map((r) => ({ from: { kind: r.from_kind, id: r.from_id }, to: { kind: r.to_kind, id: r.to_id }, conflictId: r.conflict_id }));
  }

  async redactStoredIntake(): Promise<IntakeRedacted> {
    const passes: { table: string; columns: string[]; kind: string; where: string; doc: string; count: keyof IntakeRedacted | null }[] = [
      { table: 'docs', columns: ['title'], kind: 'document', where: `x.source = 'intake'`, doc: 'x.id', count: null },
      { table: 'chunks', columns: ['text'], kind: 'chunk', where: `EXISTS (SELECT 1 FROM docs d WHERE d.id = x.doc_id AND d.source = 'intake')`, doc: 'x.doc_id', count: null },
      { table: 'claims', columns: ['statement', 'quote', 'about'], kind: 'claim', where: 'true', doc: 'x.doc_id', count: 'claims' },
      { table: 'questions', columns: ['text', 'quote'], kind: 'question', where: 'true', doc: 'x.doc_id', count: 'questions' },
    ];
    const out: IntakeRedacted = { sources: 0, claims: 0, questions: 0 };
    const sources = new Set<string>();
    for (const p of passes) {
      for (let after = ''; ;) {
        const { rows } = await this.db.pool.query(
          `SELECT x.id, ${p.doc} AS doc_ref, ${p.columns.map((c) => `x.${c}`).join(', ')} FROM ${p.table} x
           WHERE x.id COLLATE "C" > $1 AND ${p.where} ORDER BY x.id COLLATE "C" LIMIT $2`,
          [after, REDACT_PAGE],
        );
        if (!rows.length) break;
        after = rows[rows.length - 1].id;
        for (const r of rows) {
          const was = Object.fromEntries(p.columns.map((c) => [c, r[c]]));
          const now = redactStoredRow(was, p.columns);
          if (!now) continue;
          await archiveBeforeRedaction(p.kind, r.id, was);
          await this.db.pool.query(`UPDATE ${p.table} SET ${p.columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [r.id, ...p.columns.map((c) => now[c])]);
          if (p.count) out[p.count]++;
          else sources.add(r.doc_ref);
        }
      }
    }
    out.sources = sources.size;
    return out;
  }

  async runItems(run: string): Promise<IntakeRunItem[]> {
    const { rows } = await this.db.pool.query(
      `SELECT * FROM (SELECT 'claim' AS kind, id, project_key, sandbox FROM claims WHERE run = $1
         UNION ALL SELECT 'question', id, project_key, sandbox FROM questions WHERE run = $1
         UNION ALL SELECT 'conflict', id, project_key, sandbox FROM conflicts WHERE run = $1) x
       ORDER BY kind COLLATE "C", id COLLATE "C"`,
      [run],
    );
    return rows.map((r) => ({ kind: r.kind, id: r.id, projectKey: r.project_key, sandbox: r.sandbox }));
  }

  async removeRun(run: string, keep: string[] = []): Promise<IntakeRemoved> {
    return this.write(async (query) => {
      const out: IntakeRemoved = { claim: 0, question: 0, conflict: 0 };
      for (const [kind, table] of [['claim', 'claims'], ['question', 'questions'], ['conflict', 'conflicts']] as const) {
        const { rows } = await query(`DELETE FROM ${table} WHERE run = $1 AND NOT (id = ANY($2::text[])) RETURNING id`, [run, keep]);
        out[kind] = rows.length;
        await removeEdges(query, rows.map((r) => r.id));
      }
      return out;
    });
  }
}

/** Supersessions and claim links naming removed records (Neo4j's edges go with their nodes). */
async function removeEdges(query: Query, ids: string[]) {
  if (!ids.length) return;
  await query('DELETE FROM supersessions WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[]) OR conflict_id = ANY($1::text[])', [ids]);
  await query('DELETE FROM claim_links WHERE to_id = ANY($1::text[])', [ids]);
}

/**
 * deleteProject's intake part (PgPortabilityStore), run before the project's facts and lessons go: conflicts with a
 * side among them or filed under it, its claims and questions, and the links naming any of them. Sources go with
 * their docs (intake_sources references docs).
 */
export const DELETE_PROJECT_INTAKE: string[] = [
  `DELETE FROM supersessions s WHERE EXISTS (SELECT 1 FROM claims c WHERE c.project_key = $1 AND c.id IN (s.from_id, s.to_id))
     OR EXISTS (SELECT 1 FROM facts f WHERE f.project_key = $1 AND f.id IN (s.from_id, s.to_id))
     OR EXISTS (SELECT 1 FROM lessons l WHERE (l.project_key = $1 OR l.origin_project_key = $1) AND l.id IN (s.from_id, s.to_id))`,
  `DELETE FROM claim_links k WHERE EXISTS (SELECT 1 FROM facts f WHERE f.project_key = $1 AND f.id = k.to_id)
     OR EXISTS (SELECT 1 FROM lessons l WHERE (l.project_key = $1 OR l.origin_project_key = $1) AND l.id = k.to_id)
     OR EXISTS (SELECT 1 FROM claims c WHERE c.project_key = $1 AND c.id = k.to_id)`,
  `DELETE FROM conflicts c WHERE c.project_key = $1 OR EXISTS (SELECT 1 FROM conflict_sides s WHERE s.conflict_id = c.id AND (
     (s.kind = 'claim' AND EXISTS (SELECT 1 FROM claims x WHERE x.id = s.ref_id AND x.project_key = $1))
     OR (s.kind = 'fact' AND EXISTS (SELECT 1 FROM facts x WHERE x.id = s.ref_id AND x.project_key = $1))
     OR (s.kind = 'lesson' AND EXISTS (SELECT 1 FROM lessons x WHERE x.id = s.ref_id AND (x.project_key = $1 OR x.origin_project_key = $1)))))`,
  `DELETE FROM questions WHERE project_key = $1`,
  `DELETE FROM claims WHERE project_key = $1`,
];
