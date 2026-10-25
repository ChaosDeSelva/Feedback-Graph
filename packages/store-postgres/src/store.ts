import type { Store } from '@fb/core';
import { PgActivityStore } from './activity.ts';
import { PgChatStore } from './chat.ts';
import { PgCodeGraphStore } from './codegraph.ts';
import { openDb, type Db, type PostgresConfig } from './db.ts';
import { PgDocsStore } from './docs.ts';
import { PgEmbeddingsStore } from './embeddings.ts';
import { PgFactsStore } from './facts.ts';
import { PgGraphStore } from './graph.ts';
import { PgInsightsStore } from './insights.ts';
import { PgKnowledgeStore } from './knowledge.ts';
import { PgLinksStore } from './links.ts';
import { migrate } from './migrate.ts';
import { PgPortabilityStore } from './portability.ts';
import { PgSelectionStore } from './selection.ts';
import { PgSessionsStore } from './sessions.ts';
import { checkPgvector } from './vector.ts';

export type PostgresStore = Store & { readonly kind: 'postgres'; readonly db: Db };

/** A Store over one connection pool. */
export function postgresStore(db: Db): PostgresStore {
  return {
    kind: 'postgres',
    db,
    graph: new PgGraphStore(db),
    knowledge: new PgKnowledgeStore(db),
    facts: new PgFactsStore(db),
    docs: new PgDocsStore(db),
    links: new PgLinksStore(db),
    activity: new PgActivityStore(db),
    insights: new PgInsightsStore(db),
    portability: new PgPortabilityStore(db),
    embeddings: new PgEmbeddingsStore(db),
    selection: new PgSelectionStore(db),
    codegraph: new PgCodeGraphStore(db),
    sessions: new PgSessionsStore(db),
    chats: new PgChatStore(db),
    ensureSchema: async () => {
      await migrate(db.pool, { embeddingDimensions: db.dims });
      await checkPgvector(db);
    },
    ping: async () => {
      try {
        await db.pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => db.pool.end(),
  };
}

/** Connect (fails fast when the database does not answer). Call ensureSchema() before first use. */
export async function openPostgresStore(config: PostgresConfig): Promise<PostgresStore> {
  const db = openDb(config);
  try {
    await db.pool.query('SELECT 1');
  } catch (err) {
    await db.pool.end();
    throw err;
  }
  return postgresStore(db);
}
