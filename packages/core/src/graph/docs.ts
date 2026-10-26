import neo4j from 'neo4j-driver';
import { REDACT_PAGE, redactDeep, redactSecrets } from '../redact.ts';
import type { DocsStore } from '../store.ts';
import type { TaskImage } from '../llm/providers.ts';
import { relevanceOf, scanRetryAt, SCAN_UNAVAILABLE_WAIT_MS, type EmbeddedFact } from './facts.ts';
import type { GraphRepo } from './repo.ts';
import type { RunTag } from '../types.ts';
import { nearest } from './nearest.ts';
import { VISIBLE_TO_RUN } from './runs.ts';
import { runWriteOwner } from '../runs.ts';

export type DocSource = 'upload' | 'github' | 'linear';
export type DocInput = { projectKey: string; source: DocSource; ref: string; title: string; url: string | null };
/**
 * Reading an upload into facts (the worker's docs stage). pending: waiting (again after a failure, until retryAt);
 * reading: the worker has it; done: its facts are stored; failed: gave up after MAX_SCAN_ATTEMPTS.
 */
export type DocReadStatus = 'pending' | 'reading' | 'done' | 'failed';
export type DocReadState = { status: DocReadStatus; attempts: number; error: string | null; retryAt: string | null; readAt: string | null; facts: number };
export type DocKind = 'text' | 'image';
/** read: null for a document that is never read into facts (PR discussions and tickets). */
/** addedBy: who uploaded it ('you', or 'operator:<name>'); null for PR discussions, tickets and older uploads. */
/** listDocs: a page (at most `limit`, after the doc `after` names), or the docs with this source and ref. */
export type DocListOpts = { limit?: number; after?: { addedAt: string; id: string } | null; source?: DocSource; ref?: string; run?: string | null };
/**
 * A large upload the API is embedding in the background (pending), or failed to (with why): set by the API on the
 * document it replaces, or on the upload not stored yet; absent once it is stored. Stores never set it.
 */
export type DocEmbed = { status: 'pending' | 'failed'; error?: string; chunks: number };
export type DocSummary = DocInput & { id: string; addedAt: string; addedBy: string | null; chunks: number; kind: DocKind; mediaType: string | null; read: DocReadState | null; embed?: DocEmbed };
/** What the docs stage reads: the text of a text upload (its chunks joined), or the image of an image upload. */
/**
 * `version`: which upload of the document this is (its addedAt). The reader passes it back, so a reading of a version
 * replaced in the meantime (the same file uploaded again) is dropped instead of overwriting the new one.
 */
export type DocToRead = { id: string; projectKey: string; ref: string; title: string; kind: DocKind; text: string; image: TaskImage | null; attempts: number; version: string };
/**
 * read: queue it to be read into facts (uploads). image: the upload is this image (stored for the reader and the
 * thumbnail). tickets: the Linear identifiers a pull request names (ticketIdsIn), linking it to those tickets' documents
 * (linkedDocs); replaced on every upsert, none when unset.
 */
/**
 * run: the run (RunTag) it was uploaded in; an upload replaced without one is no longer the run's (it is the owner's).
 * A run never replaces a document it does not own: a sandbox run's upload is its own document (docIdOf with the run),
 * beside the owner's of that name; any other run's over the owner's or another run's throws NotTheRunsError, unless
 * byOwner (the owner opened the run): then it is replaced and stays (or becomes) the owner's.
 */
export type UpsertDocOpts = { read?: boolean; image?: TaskImage; addedBy?: string; tickets?: string[]; run?: RunTag | null; byOwner?: boolean };
/**
 * A pull request's document and a Linear ticket's, linked because the pull request names the ticket's identifier
 * (UpsertDocOpts.tickets). `docId` is the document asked about, `linked` the one at the other end.
 */
export type DocLink = { docId: string; linked: { docId: string; source: DocSource; ref: string; title: string; url: string | null } };
/** A Linear ticket's document ref, from its identifier: what a pull request's `tickets` are matched against. */
export const linearDocRef = (identifier: string) => `linear:${identifier}`;
/** Images are kept in the database, so no volume is needed: at most this many bytes. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * Same project, source and ref: same document (re-adding replaces it). Takes the already-redacted ref. A sandbox run's
 * upload is its own document (doc@<run>:...), so it never replaces the owner's of that name; the project is still the
 * second part and the ref everything after the third.
 */
export const docIdOf = (d: Pick<DocInput, 'projectKey' | 'source' | 'ref'>, run?: RunTag | null) =>
  `doc${run?.sandbox ? `@${run.id}` : ''}:${d.projectKey}:${d.source}:${d.ref}`;
export type DocHit = { docId: string; source: DocSource; ref: string; title: string; url: string | null; text: string; score: number };

/** Context that isn't code: uploaded documents, PR discussions, tickets. Stored as embedded chunks per document. */
export class DocsRepo implements DocsStore {
  readonly g: GraphRepo;

  constructor(g: GraphRepo) {
    this.g = g;
  }

  /** Insert or replace a document (same project + source + ref replaces its chunks). Returns the doc id. */
  async upsertDoc(input: DocInput, raw: { text: string; embedding: number[] }[], o: UpsertDocOpts = {}): Promise<string> {
    // Docs come from outside (uploads, PRs, tickets): redact here so no caller can skip it.
    const doc = { ...input, title: redactSecrets(input.title), ref: redactSecrets(input.ref) };
    const chunks = raw.map((c) => ({ ...c, text: redactSecrets(c.text) }));
    const id = docIdOf(doc, o.run);
    this.g.sandbox.wrote(o.run);
    // A run replaces only its own document (runWriteOwner); the owner's write makes a run's document the owner's.
    const [cur] = await this.g.run(`MATCH (d:Doc {id: $id}) RETURN d.run AS run`, { id });
    const run = runWriteOwner(`the document ${doc.ref}`, cur ? (cur.get('run') ?? null) : undefined, o.run, o.byOwner);
    // A new version of the document: what was read from the old one goes, and it is read again when asked.
    // The Doc is written first, so its lock orders this against a reading being saved (saveDocReading locks it too).
    await this.g.runInTransaction([
      [
        `MERGE (p:Project {key: $doc.projectKey})
         MERGE (d:Doc {id: $id})
         SET d.projectKey = $doc.projectKey, d.source = $doc.source, d.ref = $doc.ref, d.title = $doc.title,
             d.url = $doc.url, d.addedAt = $now, d.addedBy = $addedBy, d.kind = $kind, d.mediaType = $mediaType, d.tickets = $tickets,
             d.run = $run, d.sandbox = $sandbox,
             d.readStatus = CASE WHEN $read THEN 'pending' ELSE null END, d.readAttempts = 0, d.readError = null,
             d.readRetryAt = null, d.readAt = null
         MERGE (d)-[:IN]->(p)
         WITH d
         OPTIONAL MATCH (d)-[:HAS_CHUNK]->(old:Chunk)
         DETACH DELETE old
         WITH DISTINCT d
         UNWIND range(0, size($chunks) - 1) AS i
           CREATE (d)-[:HAS_CHUNK]->(:Chunk {id: $id + '#' + toString(i), docId: $id, projectKey: $doc.projectKey,
                                             idx: i, text: $chunks[i].text, embedding: $chunks[i].embedding})`,
        { id, doc, chunks, tickets: o.tickets ?? [], now: new Date().toISOString(), addedBy: o.addedBy ?? null, read: !!o.read, kind: o.image ? 'image' : 'text', mediaType: o.image?.mediaType ?? null, run: run?.id ?? null, sandbox: !!run?.sandbox },
      ],
      [`MATCH (x:Fact {docId: $id}) DETACH DELETE x`, { id }],
      [`MATCH (b:DocBlob {docId: $id}) DETACH DELETE b`, { id }],
      ...(o.image
        ? [[
            `MATCH (d:Doc {id: $id}) CREATE (d)-[:HAS_BLOB]->(:DocBlob {docId: $id, projectKey: d.projectKey, mediaType: $mediaType, data: $data})`,
            { id, mediaType: o.image.mediaType, data: o.image.data },
          ] as [string, Record<string, unknown>]]
        : []),
    ]);
    return id;
  }

  async nextDocToRead(now = new Date()): Promise<DocToRead | null> {
    const [r] = await this.g.run(
      `MATCH (d:Doc {readStatus: 'pending'}) WHERE coalesce(d.readRetryAt, '') <= $now
       WITH d ORDER BY d.addedAt, d.id LIMIT 1
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
       WITH d, c ORDER BY c.idx
       WITH d, collect(c.text) AS texts
       OPTIONAL MATCH (d)-[:HAS_BLOB]->(b:DocBlob)
       RETURN d, texts, b`,
      { now: now.toISOString() },
    );
    if (!r) return null;
    const p = r.get('d').properties;
    const b = r.get('b')?.properties;
    const image = b ? { mediaType: b.mediaType, data: b.data } : null;
    return { id: p.id, projectKey: p.projectKey, ref: p.ref, title: p.title, kind: p.kind ?? 'text', text: image ? '' : r.get('texts').join('\n\n'), image, attempts: Number(p.readAttempts ?? 0), version: p.addedAt };
  }

  async markDocReading(id: string, version?: string): Promise<boolean> {
    const [r] = await this.g.run(
      `MATCH (d:Doc {id: $id}) WHERE $version IS NULL OR d.addedAt = $version SET d.readStatus = 'reading' RETURN count(d) AS n`,
      { id, version: version ?? null },
    );
    return Number(r.get('n')) > 0;
  }

  async saveDocReading(id: string, r: { version?: string; chunks?: { text: string; embedding: number[] }[]; facts: EmbeddedFact[]; source: string }): Promise<boolean> {
    // The version read must still be the current one; checked again inside the write, so a re-upload in between wins.
    const [cur] = await this.g.run(`MATCH (d:Doc {id: $id}) RETURN d.addedAt AS v, coalesce(d.sandbox, false) AS sandbox`, { id });
    if (!cur || (r.version !== undefined && cur.get('v') !== r.version)) return false;
    // A sandbox upload's facts and chunks are sandbox records too.
    this.g.sandbox.wrote(cur.get('sandbox') === true);
    // Model output about a document someone gave you: redact at the door, like code facts.
    const facts = redactDeep(r.facts).map((f) => ({ ...f, relevance: relevanceOf(f) }));
    const chunks = r.chunks?.map((c) => ({ ...c, text: redactSecrets(c.text) })) ?? null;
    const now = new Date().toISOString();
    const version = r.version ?? cur.get('v');
    const out = await this.g.runInTransaction([
      // Takes the document's write lock first: a re-upload either lands before (and this sees a new version) or after.
      [`MATCH (d:Doc {id: $id}) SET d._lock = coalesce(d._lock, 0) + 1 REMOVE d._lock RETURN d.addedAt = $version AS same`, { id, version }],
      [`MATCH (d:Doc {id: $id}) WHERE d.addedAt = $version MATCH (x:Fact {docId: $id}) DETACH DELETE x`, { id, version }],
      ...(chunks
        ? [[
            `MATCH (d:Doc {id: $id}) WHERE d.addedAt = $version
             OPTIONAL MATCH (d)-[:HAS_CHUNK]->(old:Chunk)
             DETACH DELETE old
             WITH DISTINCT d
             UNWIND range(0, size($chunks) - 1) AS i
               CREATE (d)-[:HAS_CHUNK]->(:Chunk {id: $id + '#' + toString(i), docId: $id, projectKey: d.projectKey,
                                                 idx: i, text: $chunks[i].text, embedding: $chunks[i].embedding})`,
            { id, chunks, version },
          ] as [string, Record<string, unknown>]]
        : []),
      [
        `MATCH (d:Doc {id: $id}) WHERE d.addedAt = $version
         SET d.readStatus = 'done', d.readAt = $now, d.readError = null, d.readRetryAt = null
         WITH d
         UNWIND $facts AS fx
           CREATE (n:Fact {id: randomUUID(), projectKey: d.projectKey, docId: $id, kind: fx.kind, statement: fx.statement,
                           path: d.ref, lines: fx.lines, confidence: fx.confidence, why: fx.why, embedding: fx.embedding,
                           relevance: fx.relevance, relevanceBy: CASE WHEN fx.relevance IS NULL THEN null ELSE 'model' END,
                           source: $source, scanJobId: null, fileHash: null, current: true, createdAt: $now, validFrom: $now,
                           run: d.run, sandbox: coalesce(d.sandbox, false)})
           CREATE (n)-[:FROM]->(d)`,
        { id, facts, source: r.source, now, version },
      ],
    ]);
    return out[0]?.[0]?.get('same') === true;
  }

  async recordDocFailure(id: string, error: string, o: { counted: boolean; final?: boolean; version?: string }, now = new Date()): Promise<{ attempts: number; retryAt: string | null } | null> {
    const [cur] = await this.g.run(`MATCH (d:Doc {id: $id}) RETURN coalesce(d.readAttempts, 0) AS a, d.addedAt AS v`, { id });
    if (!cur || (o.version !== undefined && cur.get('v') !== o.version)) return null;
    const attempts = Number(cur?.get('a') ?? 0) + (o.counted ? 1 : 0);
    const retryAt = o.final ? null : o.counted ? scanRetryAt(attempts, now) : new Date(now.getTime() + SCAN_UNAVAILABLE_WAIT_MS).toISOString();
    await this.g.run(
      `MATCH (d:Doc {id: $id}) WHERE $version IS NULL OR d.addedAt = $version
       SET d.readAttempts = $attempts, d.readError = $error, d.readRetryAt = $retryAt,
         d.readStatus = CASE WHEN $retryAt IS NULL THEN 'failed' ELSE 'pending' END`,
      { id, attempts: neo4j.int(attempts), error: redactSecrets(error).slice(0, 2000), retryAt, version: o.version ?? null },
    );
    return { attempts, retryAt };
  }

  async requeueStaleDocs() {
    await this.g.run(`MATCH (d:Doc {readStatus: 'reading'}) SET d.readStatus = 'pending'`);
  }

  async requeueDocRead(id: string): Promise<boolean> {
    const [r] = await this.g.run(
      `MATCH (d:Doc {id: $id}) WHERE d.readStatus IN ['failed', 'pending']
       SET d.readStatus = 'pending', d.readAttempts = 0, d.readError = null, d.readRetryAt = null
       RETURN count(d) AS n`,
      { id },
    );
    return Number(r?.get('n') ?? 0) > 0;
  }

  async docImage(id: string): Promise<TaskImage | null> {
    const [r] = await this.g.run(`MATCH (b:DocBlob {docId: $id}) RETURN b.mediaType AS mediaType, b.data AS data LIMIT 1`, { id });
    return r ? { mediaType: r.get('mediaType'), data: r.get('data') } : null;
  }

  async listDocs(projectKey: string, o: DocListOpts = {}): Promise<DocSummary[]> {
    // The page first, then the counts for its docs only.
    const rows = await this.g.run(
      `MATCH (d:Doc {projectKey: $projectKey})
       WHERE ${VISIBLE_TO_RUN('d')} AND ($source IS NULL OR d.source = $source) AND ($ref IS NULL OR d.ref = $ref)
         AND ($afterAt IS NULL OR d.addedAt < $afterAt OR (d.addedAt = $afterAt AND d.id > $afterId))
       WITH d ORDER BY d.addedAt DESC, d.id
       ${o.limit !== undefined ? 'LIMIT $limit' : ''}
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
       WITH d, count(c) AS chunks
       OPTIONAL MATCH (x:Fact {docId: d.id, current: true})
       RETURN d, chunks, count(x) AS facts ORDER BY d.addedAt DESC, d.id`,
      {
        projectKey, run: o.run ?? null, source: o.source ?? null, ref: o.ref ?? null, afterAt: o.after?.addedAt ?? null, afterId: o.after?.id ?? null,
        limit: neo4j.int(Math.max(0, Math.floor(o.limit ?? 0))),
      },
    );
    return rows.map((r) => {
      const p = r.get('d').properties;
      return {
        id: p.id, projectKey: p.projectKey, source: p.source, ref: p.ref, title: p.title, url: p.url ?? null, addedAt: p.addedAt, addedBy: p.addedBy ?? null, chunks: r.get('chunks'),
        kind: p.kind ?? 'text', mediaType: p.mediaType ?? null,
        read: p.readStatus
          ? { status: p.readStatus, attempts: Number(p.readAttempts ?? 0), error: p.readError ?? null, retryAt: p.readRetryAt ?? null, readAt: p.readAt ?? null, facts: Number(r.get('facts')) }
          : null,
      };
    });
  }

  async deleteDoc(id: string, o: { run?: string | null } = {}): Promise<boolean> {
    const [r] = await this.g.run(
      `OPTIONAL MATCH (d:Doc {id: $id}) WHERE $run IS NULL OR d.run = $run
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
       WITH d, collect(c) AS cs, d IS NOT NULL AS existed
       OPTIONAL MATCH (x:Fact {docId: $id}) WHERE existed
       WITH d, cs, existed, collect(x) AS xs
       OPTIONAL MATCH (b:DocBlob {docId: $id}) WHERE existed
       WITH d, cs, existed, xs, collect(b) AS bs
       FOREACH (x IN xs | DETACH DELETE x)
       FOREACH (b IN bs | DETACH DELETE b)
       FOREACH (c IN cs | DETACH DELETE c)
       FOREACH (_ IN CASE WHEN existed THEN [1] ELSE [] END | DETACH DELETE d)
       RETURN existed`,
      { id, run: o.run ?? null },
    );
    return r.get('existed');
  }

  async linkedDocs(q: { projectKey: string; docIds: string[]; run?: string | null }): Promise<DocLink[]> {
    if (!q.docIds.length) return [];
    const rows = await this.g.run(
      `MATCH (d:Doc {projectKey: $projectKey}) WHERE d.id IN $docIds
       MATCH (o:Doc {projectKey: $projectKey})
       WHERE ((o.source = 'linear' AND o.ref IN [t IN coalesce(d.tickets, []) | 'linear:' + t])
          OR (d.source = 'linear' AND substring(d.ref, 7) IN coalesce(o.tickets, []) AND d.ref STARTS WITH 'linear:'))
         AND ${VISIBLE_TO_RUN('o')}
       RETURN d.id AS docId, o ORDER BY d.id, o.title, o.id`,
      { projectKey: q.projectKey, docIds: q.docIds, run: q.run ?? null },
    );
    return rows.map((r) => {
      const o = r.get('o').properties;
      return { docId: r.get('docId'), linked: { docId: o.id, source: o.source, ref: o.ref, title: o.title, url: o.url ?? null } };
    });
  }

  async projectTickets(q: { projectKey: string; ids: string[] }): Promise<string[]> {
    if (!q.ids.length) return [];
    const rows = await this.g.run(
      `UNWIND $ids AS id
       WITH DISTINCT id
       WHERE EXISTS { MATCH (d:Doc {projectKey: $projectKey}) WHERE (d.source = 'linear' AND d.ref = 'linear:' + id) OR id IN coalesce(d.tickets, []) }
       RETURN id`,
      { projectKey: q.projectKey, ids: q.ids },
    );
    return rows.map((r) => r.get('id') as string);
  }

  async searchDocs(q: { embedding: number[]; projectKey: string; k: number; run?: string | null }): Promise<DocHit[]> {
    // A chunk is another run's sandbox upload when its document is (only looked up while any sandbox record exists).
    const visible = (await this.g.sandbox.any()) ? `NOT EXISTS { MATCH (sd:Doc {id: node.docId}) WHERE NOT ${VISIBLE_TO_RUN('sd')} }` : 'true';
    const rows = await nearest(this.g, {
      index: 'chunk_embedding', label: 'Chunk', embedding: q.embedding, k: q.k,
      where: `node.projectKey = $projectKey AND ${visible}`,
      tail: `WITH node, score ORDER BY score DESC LIMIT $k
       MATCH (d:Doc {id: node.docId})
       RETURN node.text AS text, score, d`,
      params: { projectKey: q.projectKey, run: q.run ?? null },
    });
    return rows.map((r) => {
      const p = r.get('d').properties;
      return { docId: p.id, source: p.source, ref: p.ref, title: p.title, url: p.url ?? null, text: r.get('text'), score: r.get('score') };
    });
  }

  /** Small key/value store for integration sync cursors (e.g. last GitHub sync time per project). */
  async redactStoredDocs(): Promise<number> {
    let changed = 0;
    for (const [label, prop] of [['Doc', 'title'], ['Chunk', 'text']] as const) {
      for (let after = ''; ;) {
        const rows = await this.g.run(`MATCH (x:${label}) WHERE x.id > $after RETURN x.id AS id, x.${prop} AS text ORDER BY x.id LIMIT $page`, { after, page: neo4j.int(REDACT_PAGE) });
        if (!rows.length) break;
        after = rows[rows.length - 1].get('id');
        const page = rows.flatMap((r) => { const was: string = r.get('text') ?? ''; const text = redactSecrets(was); return text === was ? [] : [{ id: r.get('id') as string, text }]; });
        if (!page.length) continue;
        await this.g.run(`UNWIND $page AS c MATCH (x:${label} {id: c.id}) SET x.${prop} = c.text`, { page });
        changed += page.length;
      }
    }
    return changed;
  }

  async getCursor(key: string): Promise<string | null> {
    const [r] = await this.g.run('MATCH (c:SyncCursor {key: $key}) RETURN c.value AS v', { key });
    return r ? r.get('v') : null;
  }

  async setCursor(key: string, value: string) {
    await this.g.run('MERGE (c:SyncCursor {key: $key}) SET c.value = $value', { key, value });
  }

  async cursorsWithPrefix(prefix: string): Promise<{ key: string; value: string }[]> {
    const rows = await this.g.run('MATCH (c:SyncCursor) WHERE c.key STARTS WITH $prefix RETURN c.key AS key, c.value AS value', { prefix });
    return rows.map((r) => ({ key: r.get('key') as string, value: r.get('value') as string }));
  }

  async deleteCursor(key: string) {
    await this.g.run('MATCH (c:SyncCursor {key: $key}) DELETE c', { key });
  }
}

/** Split text into ~`size`-char chunks on paragraph, then line, boundaries. */
export function chunkText(text: string, size = 1500): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const pieces = para.length > size ? para.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'))! : [para];
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 2 > size) {
        out.push(cur.trim());
        cur = '';
      }
      cur += (cur ? '\n\n' : '') + piece;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
