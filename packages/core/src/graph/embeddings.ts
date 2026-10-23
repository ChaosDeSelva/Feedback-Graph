import neo4j from 'neo4j-driver';
import type { EmbeddingsStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

/** The embedding model every graph used before the model was recorded. */
export const LEGACY_EMBED_MODEL = 'nomic-embed-text';

/** What each embedded label was embedded from; must match the texts the pipeline embeds. */
const SOURCES: { label: string; text: string; where?: string }[] = [
  { label: 'Lesson', text: `n.title + '\\n' + n.rule + '\\nApplies when: ' + coalesce(n.appliesWhen, '')` },
  { label: 'Miss', text: `n.missed + '\\n' + coalesce(n.causeExplanation, '')` },
  { label: 'Fact', text: `n.path + ': ' + n.statement`, where: 'n.current = true' },
  { label: 'Chunk', text: 'n.text' },
];

const BATCH = 64;

/**
 * Vectors from different embedding models live in different spaces: comparing them gives noise, and a different
 * size matches nothing. The graph records its model so a changed OLLAMA_EMBED_MODEL is refused, not silently wrong.
 */
export class EmbeddingsRepo implements EmbeddingsStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async stored(): Promise<string | null> {
    const [r] = await this.g.run(`MATCH (c:GraphConfig {id: 'embedding'}) RETURN c.model AS m`);
    return r?.get('m') ?? null;
  }

  private async record(model: string) {
    await this.g.run(`MERGE (c:GraphConfig {id: 'embedding'}) SET c.model = $model, c.updatedAt = $now`, { model, now: new Date().toISOString() });
  }

  /** Records the model on first use; afterwards reports whether `model` matches the graph's vectors. */
  async check(model: string): Promise<{ ok: boolean; stored: string }> {
    let stored = await this.stored();
    if (!stored) {
      const [r] = await this.g.run(`MATCH (n) WHERE n.embedding IS NOT NULL RETURN count(n) > 0 AS any LIMIT 1`);
      stored = r?.get('any') ? LEGACY_EMBED_MODEL : model;
      await this.record(stored);
    }
    return { ok: stored === model, stored };
  }

  /**
   * Re-embed everything with `model`. Closed facts lose their vectors (they are never searched). Returns nodes
   * re-embedded. Mark-and-sweep: every node is marked first, then GraphConfig 'reembedding' records the target model;
   * a run that stopped part way (crash, Ollama gone) is resumed by the next run for the same model, which skips the
   * marking and embeds only the nodes still pending.
   */
  async reembed(model: string, embed: (texts: string[]) => Promise<number[][]>, progress?: (label: string, done: number) => void): Promise<number> {
    let total = 0;
    const [running] = await this.g.run(`MATCH (c:GraphConfig {id: 'reembedding'}) RETURN c.model AS m`);
    if (running?.get('m') !== model) {
      await this.g.run(`MATCH (n:Fact) WHERE coalesce(n.current, false) = false SET n.embedding = null`);
      for (const s of SOURCES) {
        await this.g.run(`MATCH (n:${s.label}) WHERE n.reembedPending IS NOT NULL REMOVE n.reembedPending`);
        await this.g.run(`MATCH (n:${s.label}) WHERE n.embedding IS NOT NULL ${s.where ? `AND ${s.where}` : ''} SET n.reembedPending = true`);
      }
      await this.g.run(`MERGE (c:GraphConfig {id: 'reembedding'}) SET c.model = $model, c.updatedAt = $now`, { model, now: new Date().toISOString() });
    }
    for (const s of SOURCES) {
      let done = 0;
      for (;;) {
        const rows = await this.g.run(
          `MATCH (n:${s.label}) WHERE n.reembedPending = true RETURN elementId(n) AS id, ${s.text} AS text LIMIT $batch`,
          { batch: neo4j.int(BATCH) },
        );
        if (!rows.length) break;
        const vectors = await embed(rows.map((r) => r.get('text') ?? ''));
        await this.g.run(
          `UNWIND $rows AS row MATCH (n) WHERE elementId(n) = row.id SET n.embedding = row.v REMOVE n.reembedPending`,
          { rows: rows.map((r, i) => ({ id: r.get('id'), v: vectors[i] })) },
        );
        done += rows.length;
        progress?.(s.label, done);
      }
      total += done;
    }
    await this.record(model);
    await this.g.run(`MATCH (c:GraphConfig {id: 'reembedding'}) DELETE c`);
    return total;
  }
}
