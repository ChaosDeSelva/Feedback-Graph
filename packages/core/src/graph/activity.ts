import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import type { Activity, ActivityInput, ActivityKind } from '../types.ts';
import { REDACT_PAGE, redactDeep, redactSecrets, redactStoredRow } from '../redact.ts';
import type { ActivityQuery, ActivityStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

/** How many entries one delete of removeRun takes. */
const REMOVE_BATCH = 5000;

/** Sub-millisecond, monotonic within a process: keeps activities recorded in one burst in order. */
let last = 0;
const order = () => (last = Math.max(last + 0.001, performance.timeOrigin + performance.now()));

/**
 * An Activity subject is one line of the log, at most this long. A longer one (an agent's report quoted whole, a
 * probe's megabyte) is cut at write; details.subjectChars says how long it was. The full text stays on its record
 * (the Inbox item, the document), which the entry's targets name.
 */
export const MAX_ACTIVITY_SUBJECT = 500;

export function capActivitySubject<A extends { subject: string; details?: Record<string, unknown> | null }>(a: A): A {
  if (a.subject.length <= MAX_ACTIVITY_SUBJECT) return a;
  return { ...a, subject: `${a.subject.slice(0, MAX_ACTIVITY_SUBJECT - 1)}…`, details: { ...(a.details ?? {}), subjectChars: a.subject.length } };
}

/**
 * An entry as both stores write it. Subjects quote feedback, PR titles and model output: they are redacted BEFORE the
 * cut, because a token that crosses the cap and is cut first no longer matches its pattern and its head would be kept.
 */
export function prepareActivity<A extends { subject: string; why: string; details?: Record<string, unknown> | null }>(a: A): A {
  return capActivitySubject({ ...a, subject: redactSecrets(a.subject), why: redactSecrets(a.why) });
}

/**
 * On start: subjects an older version stored over the cap are cut as record() cuts them now (details, JSON text here,
 * gain subjectChars). Returns how many.
 */
export async function capStoredActivitySubjects(g: GraphRepo): Promise<number> {
  const [r] = await g.run(
    `MATCH (x:Activity) WHERE size(x.subject) > $max
     WITH x, size(x.subject) AS n, trim(coalesce(x.details, '{}')) AS d
     SET x.subject = left(x.subject, $max - 1) + '…',
         x.details = CASE WHEN d = '{}' OR NOT d STARTS WITH '{' THEN '{"subjectChars":' + toString(n) + '}'
                          ELSE left(d, size(d) - 1) + ',"subjectChars":' + toString(n) + '}' END
     RETURN count(x) AS n`,
    { max: neo4j.int(MAX_ACTIVITY_SUBJECT) },
  );
  return Number(r?.get('n') ?? 0);
}

/**
 * The provenance log: an append-only record of what created or decided each thing in the graph, and why. The one
 * exception: cleaning up a test run removes the entries made in it (removeRun).
 */
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
    ...(p.run ? { run: p.run as string } : {}), ...(p.sandbox === true && { sandbox: true as const }),
  };
}

export class ActivityRepo implements ActivityStore {
  readonly g: GraphRepo;

  constructor(g: GraphRepo) {
    this.g = g;
  }

  async record(input: ActivityInput): Promise<void> {
    const a = prepareActivity(input); // redacted, then cut
    await this.g.run(
      `CREATE (:Activity {id: $id, ts: $ts, order: $order, kind: $a.kind, actor: $a.actor, projectKey: $a.projectKey,
                          subject: $a.subject, why: $a.why, details: $details, targets: $targets,
                          run: $run, sandbox: $sandbox})`,
      {
        id: `act:${randomUUID()}`,
        ts: new Date().toISOString(),
        order: order(),
        a,
        details: JSON.stringify(redactDeep(a.details ?? {})), // redact values, not JSON text
        targets: a.targets ?? [],
        run: a.run ?? null,
        sandbox: !!a.run && !!a.sandbox,
      },
    );
  }

  async redactStoredActivity(): Promise<number> {
    let changed = 0;
    for (let after = ''; ;) {
      const rows = await this.g.run(
        'MATCH (x:Activity) WHERE x.id > $after RETURN x.id AS id, x.subject AS subject, x.why AS why, x.details AS details ORDER BY x.id LIMIT $page',
        { after, page: neo4j.int(REDACT_PAGE) },
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].get('id');
      const page = rows.flatMap((r) => redactStoredRow({ id: r.get('id') as string, subject: r.get('subject') ?? null, why: r.get('why') ?? null, details: r.get('details') ?? null }, ['subject', 'why'], ['details']) ?? []);
      if (!page.length) continue;
      await this.g.run('UNWIND $page AS c MATCH (x:Activity {id: c.id}) SET x.subject = c.subject, x.why = c.why, x.details = c.details', { page });
      changed += page.length;
    }
    return changed;
  }

  async list(q: ActivityQuery): Promise<Activity[]> {
    // details is a JSON string: one bigger than maxDetailBytes is never sent from the database.
    const rows = await this.g.run(
      `MATCH (x:Activity)
       WHERE ($projectKey IS NULL OR x.projectKey = $projectKey) AND ($kind IS NULL OR x.kind = $kind)
         AND ($projectKeys IS NULL OR x.projectKey IS NULL OR x.projectKey IN $projectKeys)
         AND ($target IS NULL OR $target IN x.targets) AND ($run IS NULL OR x.run = $run)
         AND (NOT $unlabelled OR x.run IS NULL) AND (NOT $noSandbox OR NOT coalesce(x.sandbox, false))
       WITH x, $max IS NOT NULL AND size(coalesce(x.details, '')) > $max AS omitted
       RETURN x {.id, .ts, .kind, .actor, .projectKey, .subject, .why, .targets, .run, .sandbox, details: CASE WHEN omitted THEN null ELSE x.details END} AS row, omitted
       ORDER BY x.order DESC LIMIT $limit`,
      {
        projectKey: q.projectKey ?? null, projectKeys: q.projectKeys ?? null, kind: q.kind ?? null, target: q.target ?? null, run: q.run ?? null,
        limit: neo4j.int(q.limit ?? 200), max: q.maxDetailBytes === undefined ? null : neo4j.int(q.maxDetailBytes),
        unlabelled: !!q.unlabelled, noSandbox: !!q.noSandbox,
      },
    );
    return rows.map((r) => ({ ...activityOf(r.get('row')), ...(r.get('omitted') && { detailsOmitted: true }) }));
  }

  async get(id: string): Promise<Activity | null> {
    const [r] = await this.g.run('MATCH (x:Activity {id: $id}) RETURN x', { id });
    return r ? activityOf(r.get('x').properties) : null;
  }

  async removeRun(run: string, keep: readonly ActivityKind[] = [], o: { ids?: readonly string[]; targets?: readonly string[] } = {}): Promise<number> {
    let removed = 0;
    // Batched: a stress run logs thousands.
    for (;;) {
      const [r] = await this.g.run(
        `MATCH (x:Activity {run: $run}) WHERE NOT x.kind IN $keep AND ($ids IS NULL OR x.id IN $ids)
           AND none(t IN coalesce(x.targets, []) WHERE t IN $targets)
         WITH x LIMIT $batch DETACH DELETE x RETURN count(*) AS n`,
        { run, keep: [...keep], ids: o.ids ? [...o.ids] : null, targets: [...(o.targets ?? [])], batch: neo4j.int(REMOVE_BATCH) },
      );
      const n = Number(r?.get('n') ?? 0);
      removed += n;
      if (n < REMOVE_BATCH) return removed;
    }
  }
}
