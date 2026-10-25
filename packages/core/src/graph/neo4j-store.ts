import type { Store } from '../store.ts';
import { ActivityRepo } from './activity.ts';
import { ChatRepo } from './chat.ts';
import { CodeGraphRepo } from './codegraph.ts';
import { DocsRepo } from './docs.ts';
import { EmbeddingsRepo } from './embeddings.ts';
import { FactsRepo } from './facts.ts';
import { InsightsRepo } from './insights.ts';
import { KnowledgeRepo } from './knowledge.ts';
import { LinksRepo } from './links.ts';
import { PortabilityRepo } from './portability.ts';
import { GraphRepo } from './repo.ts';
import { SelectionRepo } from './selection.ts';
import { backfillSessionStats, SessionsRepo } from './sessions.ts';

export type Neo4jConfig = { url: string; user: string; password: string };

/** A Store over one Neo4j connection. `graph` is the GraphRepo itself (Neo4j-only tests may reach its run()). */
export function neo4jStore(g: GraphRepo): Store {
  return {
    kind: 'neo4j',
    graph: g,
    knowledge: new KnowledgeRepo(g),
    facts: new FactsRepo(g),
    docs: new DocsRepo(g),
    links: new LinksRepo(g),
    activity: new ActivityRepo(g),
    insights: new InsightsRepo(g),
    portability: new PortabilityRepo(g),
    embeddings: new EmbeddingsRepo(g),
    selection: new SelectionRepo(g),
    codegraph: new CodeGraphRepo(g),
    sessions: new SessionsRepo(g),
    chats: new ChatRepo(g),
    ensureSchema: async () => {
      await g.ensureSchema();
      await backfillSessionStats(g);
    },
    ping: () => g.ping(),
    close: () => g.close(),
  };
}

/** Connect to Neo4j (fails fast when it does not answer). Call ensureSchema() before first use. */
export async function openNeo4jStore(config: Neo4jConfig): Promise<Store> {
  return neo4jStore(await GraphRepo.connect(config.url, config.user, config.password));
}
