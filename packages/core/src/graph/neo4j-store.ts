import type { Store } from '../store.ts';
import { ActivityRepo, ActivityTargetIndex, capStoredActivitySubjects } from './activity.ts';
import { ChatRepo } from './chat.ts';
import { CodeGraphRepo } from './codegraph.ts';
import { backfillDecisionLabels, backfillDecisionTargets, DecisionsRepo } from './decisions.ts';
import { DocsRepo } from './docs.ts';
import { EmbeddingsRepo } from './embeddings.ts';
import { FactsRepo } from './facts.ts';
import { InsightsRepo } from './insights.ts';
import { IntakeRepo } from './intake.ts';
import { KnowledgeRepo } from './knowledge.ts';
import { LinksRepo } from './links.ts';
import { PortabilityRepo } from './portability.ts';
import { GraphRepo } from './repo.ts';
import { RunsRepo } from './runs.ts';
import { underLease } from './schemaTasks.ts';
import { SelectionRepo } from './selection.ts';
import { backfillSessionStats, SessionsRepo } from './sessions.ts';

export type Neo4jConfig = { url: string; user: string; password: string };

/** A Store over one Neo4j connection. `graph` is the GraphRepo itself (Neo4j-only tests may reach its run()). */
export function neo4jStore(g: GraphRepo): Store {
  const targets = new ActivityTargetIndex(g);
  return {
    kind: 'neo4j',
    graph: g,
    knowledge: new KnowledgeRepo(g),
    facts: new FactsRepo(g),
    docs: new DocsRepo(g),
    links: new LinksRepo(g),
    activity: new ActivityRepo(g, targets),
    insights: new InsightsRepo(g),
    portability: new PortabilityRepo(g),
    embeddings: new EmbeddingsRepo(g),
    selection: new SelectionRepo(g),
    codegraph: new CodeGraphRepo(g),
    sessions: new SessionsRepo(g),
    chats: new ChatRepo(g),
    runs: new RunsRepo(g),
    decisions: new DecisionsRepo(g),
    intake: new IntakeRepo(g),
    ensureSchema: async (o) => {
      await g.ensureSchema();
      // The api and the worker start together: one of them runs these while the other waits, rather than both
      // doing the same pages at once.
      await underLease(g, 'startup-backfills', async () => {
        await backfillSessionStats(g);
        await backfillDecisionTargets(g);
        await backfillDecisionLabels(g);
        await capStoredActivitySubjects(g);
      });
      await targets.start(o?.log);
    },
    ping: () => g.ping(),
    close: async () => {
      await targets.stop();
      await g.close();
    },
  };
}

/** Connect to Neo4j (fails fast when it does not answer). Call ensureSchema() before first use. */
export async function openNeo4jStore(config: Neo4jConfig): Promise<Store> {
  return neo4jStore(await GraphRepo.connect(config.url, config.user, config.password));
}
