import neo4j from 'neo4j-driver';
import { redactSecrets } from '../redact.ts';
import type { DocsStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

export type DocSource = 'upload' | 'github' | 'linear';
export type DocInput = { projectKey: string; source: DocSource; ref: string; title: string; url: string | null };
export type DocSummary = DocInput & { id: string; addedAt: string; chunks: number };
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
  async upsertDoc(input: DocInput, raw: { text: string; embedding: number[] }[]): Promise<string> {
    // Docs come from outside (uploads, PRs, tickets): redact here so no caller can skip it.
    const doc = { ...input, title: redactSecrets(input.title), ref: redactSecrets(input.ref) };
    const chunks = raw.map((c) => ({ ...c, text: redactSecrets(c.text) }));
    const id = docIdOf(doc);
    await this.g.run(
      `MERGE (p:Project {key: $doc.projectKey})
       MERGE (d:Doc {id: $id})
       SET d.projectKey = $doc.projectKey, d.source = $doc.source, d.ref = $doc.ref, d.title = $doc.title,
           d.url = $doc.url, d.addedAt = $now
       MERGE (d)-[:IN]->(p)
       WITH d
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(old:Chunk)
       DETACH DELETE old
       WITH DISTINCT d
       UNWIND range(0, size($chunks) - 1) AS i
         CREATE (d)-[:HAS_CHUNK]->(:Chunk {id: $id + '#' + toString(i), docId: $id, projectKey: $doc.projectKey,
                                           idx: i, text: $chunks[i].text, embedding: $chunks[i].embedding})`,
      { id, doc, chunks, now: new Date().toISOString() },
    );
    return id;
  }

  async listDocs(projectKey: string): Promise<DocSummary[]> {
    const rows = await this.g.run(
      `MATCH (d:Doc {projectKey: $projectKey})
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
       RETURN d, count(c) AS chunks ORDER BY d.addedAt DESC`,
      { projectKey },
    );
    return rows.map((r) => {
      const p = r.get('d').properties;
      return { id: p.id, projectKey: p.projectKey, source: p.source, ref: p.ref, title: p.title, url: p.url ?? null, addedAt: p.addedAt, chunks: r.get('chunks') };
    });
  }

  async deleteDoc(id: string): Promise<boolean> {
    const [r] = await this.g.run(
      `OPTIONAL MATCH (d:Doc {id: $id})
       OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
       WITH d, collect(c) AS cs, d IS NOT NULL AS existed
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
