import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import type { Activity, ActivityInput, ActivityKind } from '../types.ts';
import { redactDeep, redactSecrets } from '../redact.ts';
import type { ActivityStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

/** Sub-millisecond, monotonic within a process: keeps activities recorded in one burst in order. */
let last = 0;
const order = () => (last = Math.max(last + 0.001, performance.timeOrigin + performance.now()));

/** The provenance log: an append-only record of what created or decided each thing in the graph, and why. */
function parseDetails(raw: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw ?? '{}');
  } catch {
    return { unreadable: raw }; // one bad row must not take the whole log down
  }
}

export class ActivityRepo implements ActivityStore {
  readonly g: GraphRepo;

  constructor(g: GraphRepo) {
    this.g = g;
  }

  async record(a: ActivityInput): Promise<void> {
    await this.g.run(
      `CREATE (:Activity {id: $id, ts: $ts, order: $order, kind: $a.kind, actor: $a.actor, projectKey: $a.projectKey,
                          subject: $a.subject, why: $a.why, details: $details, targets: $targets})`,
      {
        id: `act:${randomUUID()}`,
        ts: new Date().toISOString(),
        order: order(),
        // Subjects and details quote feedback, PR titles and model output: redact before it is stored.
        a: { ...a, subject: redactSecrets(a.subject), why: redactSecrets(a.why) },
        details: JSON.stringify(redactDeep(a.details ?? {})), // redact values, not JSON text
        targets: a.targets ?? [],
      },
    );
  }

  async list(q: { projectKey?: string; kind?: ActivityKind; target?: string; limit?: number }): Promise<Activity[]> {
    const rows = await this.g.run(
      `MATCH (x:Activity)
       WHERE ($projectKey IS NULL OR x.projectKey = $projectKey) AND ($kind IS NULL OR x.kind = $kind)
         AND ($target IS NULL OR $target IN x.targets)
       RETURN x ORDER BY x.order DESC LIMIT $limit`,
      { projectKey: q.projectKey ?? null, kind: q.kind ?? null, target: q.target ?? null, limit: neo4j.int(q.limit ?? 200) },
    );
    return rows.map((r) => {
      const p = r.get('x').properties;
      return {
        id: p.id, ts: p.ts, kind: p.kind, actor: p.actor, projectKey: p.projectKey ?? null,
        subject: p.subject, why: p.why, details: parseDetails(p.details), targets: p.targets ?? [],
      };
    });
  }
}
