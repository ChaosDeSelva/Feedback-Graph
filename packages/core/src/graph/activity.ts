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

function activityOf(p: Record<string, any>): Activity {
  return {
    id: p.id, ts: p.ts, kind: p.kind, actor: p.actor, projectKey: p.projectKey ?? null,
    subject: p.subject, why: p.why, details: parseDetails(p.details), targets: p.targets ?? [],
  };
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

  async list(q: { projectKey?: string; projectKeys?: string[]; kind?: ActivityKind; target?: string; limit?: number; maxDetailBytes?: number }): Promise<Activity[]> {
    // details is a JSON string: one bigger than maxDetailBytes is never sent from the database.
    const rows = await this.g.run(
      `MATCH (x:Activity)
       WHERE ($projectKey IS NULL OR x.projectKey = $projectKey) AND ($kind IS NULL OR x.kind = $kind)
         AND ($projectKeys IS NULL OR x.projectKey IS NULL OR x.projectKey IN $projectKeys)
         AND ($target IS NULL OR $target IN x.targets)
       WITH x, $max IS NOT NULL AND size(coalesce(x.details, '')) > $max AS omitted
       RETURN x {.id, .ts, .kind, .actor, .projectKey, .subject, .why, .targets, details: CASE WHEN omitted THEN null ELSE x.details END} AS row, omitted
       ORDER BY x.order DESC LIMIT $limit`,
      {
        projectKey: q.projectKey ?? null, projectKeys: q.projectKeys ?? null, kind: q.kind ?? null, target: q.target ?? null,
        limit: neo4j.int(q.limit ?? 200), max: q.maxDetailBytes === undefined ? null : neo4j.int(q.maxDetailBytes),
      },
    );
    return rows.map((r) => ({ ...activityOf(r.get('row')), ...(r.get('omitted') && { detailsOmitted: true }) }));
  }

  async get(id: string): Promise<Activity | null> {
    const [r] = await this.g.run('MATCH (x:Activity {id: $id}) RETURN x', { id });
    return r ? activityOf(r.get('x').properties) : null;
  }
}
