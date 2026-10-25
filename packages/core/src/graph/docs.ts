import neo4j from 'neo4j-driver';
import { redactDeep, redactSecrets } from '../redact.ts';
import type { DocsStore } from '../store.ts';
import type { TaskImage } from '../llm/providers.ts';
import { relevanceOf, scanRetryAt, SCAN_UNAVAILABLE_WAIT_MS, type EmbeddedFact } from './facts.ts';
import type { GraphRepo } from './repo.ts';

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
export type DocSummary = DocInput & { id: string; addedAt: string; addedBy: string | null; chunks: number; kind: DocKind; mediaType: string | null; read: DocReadState | null };
/** What the docs stage reads: the text of a text upload (its chunks joined), or the image of an image upload. */
/**
 * `version`: which upload of the document this is (its addedAt). The reader passes it back, so a reading of a version
 * replaced in the meantime (the same file uploaded again) is dropped instead of overwriting the new one.
 */
export type DocToRead = { id: string; projectKey: string; ref: string; title: string; kind: DocKind; text: string; image: TaskImage | null; attempts: number; version: string };
/** read: queue it to be read into facts (uploads). image: the upload is this image (stored for the reader and the thumbnail). */
export type UpsertDocOpts = { read?: boolean; image?: TaskImage; addedBy?: string };
/** Images are kept in the database, so no volume is needed: at most this many bytes. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Same project, source and ref: same document (re-adding replaces it). Takes the already-redacted ref. */
export const docIdOf = (d: Pick<DocInput, 'projectKey' | 'source' | 'ref'>) => `doc:${d.projectKey}:${d.source}:${d.ref}`;
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
    const id = docIdOf(doc);
    // A new version of the document: what was read from the old one goes, and it is read again when asked.
    // The Doc is written first, so its lock orders this against a reading being saved (saveDocReading locks it too).
    await this.g.runInTransaction([
      [
        `MERGE (p:Project {key: $doc.projectKey})
         MERGE (d:Doc {id: $id})
         SET d.projectKey = $doc.projectKey, d.source = $doc.source, d.ref = $doc.ref, d.title = $doc.title,
             d.url = $doc.url, d.addedAt = $now, d.addedBy = $addedBy, d.kind = $kind, d.mediaType = $mediaType,
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
        { id, doc, chunks, now: new Date().toISOString(), addedBy: o.addedBy ?? null, read: !!o.read, kind: o.image ? 'image' : 'text', mediaType: o.image?.mediaType ?? null },
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
    const [cur] = await this.g.run(`MATCH (d:Doc {id: $id}) RETURN d.addedAt AS v`, { id });
    if (!cur || (r.version !== undefined && cur.get('v') !== r.version)) return false;
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
                           source: $source, scanJobId: null, fileHash: null, current: true, createdAt: $now, validFrom: $now})
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

  async listDocs(projectKey: string): Promise<DocSummary[]> {
    const rows = await this.g.run(
      `MATCH (d:Doc {projectKey: $projectKey})
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
       WITH d, count(c) AS chunks
       OPTIONAL MATCH (x:Fact {docId: d.id, current: true})
       RETURN d, chunks, count(x) AS facts ORDER BY d.addedAt DESC, d.id`,
      { projectKey },
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

  async deleteDoc(id: string): Promise<boolean> {
    const [r] = await this.g.run(
      `OPTIONAL MATCH (d:Doc {id: $id})
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
       WITH d, collect(c) AS cs, d IS NOT NULL AS existed
       OPTIONAL MATCH (x:Fact {docId: $id})
       WITH d, cs, existed, collect(x) AS xs
       OPTIONAL MATCH (b:DocBlob {docId: $id})
       WITH d, cs, existed, xs, collect(b) AS bs
       FOREACH (x IN xs | DETACH DELETE x)
       FOREACH (b IN bs | DETACH DELETE b)
       FOREACH (c IN cs | DETACH DELETE c)
       FOREACH (_ IN CASE WHEN existed THEN [1] ELSE [] END | DETACH DELETE d)
       RETURN existed`,
      { id },
    );
    return r.get('existed');
  }

  async searchDocs(q: { embedding: number[]; projectKey: string; k: number }): Promise<DocHit[]> {
    const rows = await this.g.run(
      `MATCH (node:Chunk {projectKey: $projectKey}) WHERE node.embedding IS NOT NULL AND size(node.embedding) = size($embedding)
       WITH node, vector.similarity.cosine(node.embedding, $embedding) AS score
       ORDER BY score DESC LIMIT $k
       MATCH (d:Doc {id: node.docId})
       RETURN node.text AS text, score, d`,
      { embedding: q.embedding, k: neo4j.int(q.k), projectKey: q.projectKey },
    );
    return rows.map((r) => {
      const p = r.get('d').properties;
      return { docId: p.id, source: p.source, ref: p.ref, title: p.title, url: p.url ?? null, text: r.get('text'), score: r.get('score') };
    });
  }

  /** Small key/value store for integration sync cursors (e.g. last GitHub sync time per project). */
  async getCursor(key: string): Promise<string | null> {
    const [r] = await this.g.run('MATCH (c:SyncCursor {key: $key}) RETURN c.value AS v', { key });
    return r ? r.get('v') : null;
  }

  async setCursor(key: string, value: string) {
    await this.g.run('MERGE (c:SyncCursor {key: $key}) SET c.value = $value', { key, value });
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
