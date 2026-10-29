import { guardStore, openNeo4jStore, redactUrl, type Config, type Neo4jConfig, type Store } from '@fb/core';
import type { PostgresConfig } from './db.ts';
import { openPostgresStore } from './store.ts';

type Openers = { neo4j: (c: Neo4jConfig) => Promise<Store>; postgres: (c: PostgresConfig) => Promise<Store> };
const DEFAULT_OPENERS: Openers = { neo4j: openNeo4jStore, postgres: openPostgresStore };

/**
 * The store the configuration names (STORE=neo4j, the default, or postgres), connected. The api, the worker and the
 * re-embed command all open their store here, so they always agree. Call ensureSchema() before first use.
 * Lives in this package because it is the one that sees both backends (@fb/core cannot depend on it).
 */
export async function openStore(config: Pick<Config, 'store' | 'neo4j' | 'postgres'>, openers: Openers = DEFAULT_OPENERS): Promise<Store> {
  if (config.store === 'postgres') {
    if (!config.postgres) throw new Error('STORE=postgres needs DATABASE_URL');
    const { url } = config.postgres;
    try {
      return guardStore(await openers.postgres({ url }));
    } catch (err) {
      // Driver messages can echo the connection string; never let the password reach a log.
      const msg = String((err as Error)?.message ?? err).split(url).join(redactUrl(url));
      throw new Error(`could not connect to Postgres at ${redactUrl(url)}: ${msg}`, { cause: err });
    }
  }
  if (!config.neo4j) throw new Error('STORE=neo4j needs the NEO4J_* settings');
  return guardStore(await openers.neo4j(config.neo4j));
}
