import neo4j, { type Record as NeoRecord } from 'neo4j-driver';
import type { GraphRepo } from './repo.ts';
import { VISIBLE_TO_RUN } from './runs.ts';
import { EMBEDDING_DIMENSIONS } from './schema.ts';

/**
 * Index candidates read per hit asked for: the filters (project, status, run) drop the other projects' records.
 * Bounded so a k of 1 still reads enough, and a large k does not walk the whole graph.
 */
const OVERSAMPLE = 10;
const MIN_FETCH = 100;
const MAX_FETCH = 2000;
export const fetchFor = (k: number) => Math.min(MAX_FETCH, Math.max(MIN_FETCH, Math.trunc(k) * OVERSAMPLE));

/**
 * The run filter for `x` when any sandbox record exists, else none (the same answer, at no cost): see
 * GraphRepo.sandbox.
 */
export async function visibleToRun(g: GraphRepo, x: string): Promise<string> {
  return (await g.sandbox.any()) ? VISIBLE_TO_RUN(x) : 'true';
}

/**
 * The k nearest `label` nodes that pass `where` (as `node`, with `score`: Neo4j's cosine, (1 + cos) / 2), then `tail`,
 * which orders by score, cuts to $k and returns.
 *
 * First through the vector index (db.index.vector.queryNodes): the fetchFor(k) nearest of the whole index, filtered,
 * and scored exactly (the index's own score is quantized, a little off in the fourth decimal). When that leaves k,
 * they are the k nearest of those that pass (any closer one would have been fetched). When it
 * leaves fewer (the nearest belong to other projects or runs, the project holds fewer than k, the index is not online
 * yet, or the query vector is not the index's length), the exact scan answers, as before. The same results either
 * way; the index serves the common case.
 */
export async function nearest(
  g: GraphRepo,
  q: { index: string; label: string; where: string; tail: string; embedding: number[]; k: number; params: Record<string, unknown> },
): Promise<NeoRecord[]> {
  const params = { ...q.params, embedding: q.embedding, k: neo4j.int(q.k) };
  if (q.k > 0 && q.embedding.length === EMBEDDING_DIMENSIONS) {
    try {
      const rows = await g.run(
        `CALL db.index.vector.queryNodes('${q.index}', $fetch, $embedding) YIELD node
         WITH node WHERE ${q.where}
         WITH node, vector.similarity.cosine(node.embedding, $embedding) AS score
         ${q.tail}`,
        { ...params, fetch: neo4j.int(fetchFor(q.k)) },
      );
      if (rows.length >= q.k) return rows;
    } catch {
      // Not online yet (created moments ago), or dropped: the exact scan below answers.
    }
  }
  return g.run(
    `MATCH (node:${q.label}) WHERE ${q.where} AND node.embedding IS NOT NULL AND size(node.embedding) = size($embedding)
     WITH node, vector.similarity.cosine(node.embedding, $embedding) AS score
     ${q.tail}`,
    params,
  );
}
