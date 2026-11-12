import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import type { Activity, ActivityInput, ActivityKind } from '../types.ts';
import { REDACT_PAGE, redactDeep, redactSecrets, redactStoredRow } from '../redact.ts';
import type { ActivityPage, ActivityQuery, ActivitySinceQuery, ActivityStore } from '../store.ts';
import { retryDeadlock, type GraphRepo } from './repo.ts';
import { SchemaLease } from './schemaTasks.ts';

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

/** Each target of an entry once, sorted: entries naming the same records take their keys' locks in one order. */
const targetKeys = (targets: readonly string[]) => [...new Set(targets)].sort();
/** In a CALL (x) { } after the entry x: its -[:ABOUT]-> edge to each $keys target's (:ActivityTarget) key. */
const ABOUT_TARGETS = 'UNWIND $keys AS tid MERGE (k:ActivityTarget {id: tid}) CREATE (x)-[:ABOUT]->(k)';

/** The one-off upgrade that links every stored entry to its targets' keys, once (ActivityTargetIndex). */
export const ACTIVITY_TARGETS_TASK = 'activity-targets';
/** Entries a page of the upgrade reads, at most; a page over the transaction memory limit is halved. */
const BACKFILL_PAGE = 500;

/** A transaction over db.memory.transaction.max (or the global pool): rolled back whole, so the same page is retried smaller. */
const outOfMemory = (err: unknown) => /^Neo\.TransientError\.General\..*Memory/.test((err as { code?: string }).code ?? '');

/**
 * Whether every entry is linked to its (:ActivityTarget) keys, and the upgrade that links them. Entries stored before
 * the keys existed have none, and an earlier 0.8.0 build, run by the api and the worker at once, linked them twice.
 * The upgrade walks the log by id from a cursor kept on its SchemaTask, so a restart resumes it: per entry it drops
 * duplicate edges and MERGEs one per target. It runs in the background under a lease (one process at a time), in
 * pages halved while one is over the transaction memory limit, and a failure is logged and retried later: start-up
 * never waits for it. Until it is done, list() finds a target's entries by their targets list instead.
 */
export class ActivityTargetIndex {
  ready = false;
  readonly g: GraphRepo;
  readonly lease: SchemaLease;
  readonly retryMs: number;
  /** Halved for good when a page does not fit: the keys' edges only grow as the upgrade goes on. */
  page = BACKFILL_PAGE;
  private log: (msg: string, extra?: object) => void = () => {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(g: GraphRepo, o: { retryMs?: number } = {}) {
    this.g = g;
    this.lease = new SchemaLease(g, ACTIVITY_TARGETS_TASK);
    this.retryMs = o.retryMs ?? 30_000;
  }

  /** Reads whether the upgrade is done; when it is not, starts it in the background. */
  async start(log?: (msg: string, extra?: object) => void): Promise<void> {
    if (log) this.log = log;
    this.stopped = false;
    this.ready = await this.lease.done();
    if (!this.ready && !this.running) this.tick();
  }

  /** The background attempt in flight, if any, settled; then whether the upgrade is done. */
  async settled(): Promise<boolean> {
    while (this.running) await this.running;
    return this.ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.settled();
  }

  private tick() {
    this.timer = null;
    this.running = (async () => {
      try {
        const linked = await this.run();
        if (linked !== null) {
          this.ready = true;
          if (linked) this.log('activity targets linked', { entries: linked });
        }
      } catch (err) {
        if (!this.stopped) this.log('activity target upgrade failed; it is tried again later', { error: String(err) });
      }
    })().finally(() => {
      this.running = null;
      if (!this.ready && !this.stopped) {
        this.timer = setTimeout(() => this.tick(), this.retryMs);
        this.timer.unref?.();
      }
    });
  }

  /** One attempt: how many entries it walked once the upgrade is done, null while another process holds it. */
  async run(): Promise<number | null> {
    if (await this.lease.done()) return 0;
    const claimed = await this.lease.claim();
    if (!claimed) return null;
    let cursor = claimed.cursor ?? '';
    let walked = 0;
    for (;;) {
      if (this.stopped) {
        // Closing: the next process takes the upgrade over from the cursor at once, not after the lease runs out.
        await this.lease.release();
        return null;
      }
      let r;
      try {
        [r] = await this.g.run(
          `MATCH (x:Activity) WHERE x.id > $after WITH x ORDER BY x.id LIMIT $page
           CALL (x) { MATCH (x)-[e:ABOUT]->(k) WITH k, collect(e) AS es WHERE size(es) > 1 FOREACH (d IN tail(es) | DELETE d) }
           CALL (x) { UNWIND coalesce(x.targets, []) AS tid WITH DISTINCT x, tid MERGE (k:ActivityTarget {id: tid}) MERGE (x)-[:ABOUT]->(k) }
           WITH collect(x.id) AS ids
           MATCH (t:SchemaTask {id: $task}) WHERE t.owner = $me
           SET t.beat = $now, t.cursor = CASE WHEN size(ids) > 0 THEN ids[-1] ELSE t.cursor END
           RETURN size(ids) AS n, ids[-1] AS last`,
          { after: cursor, page: neo4j.int(this.page), task: ACTIVITY_TARGETS_TASK, me: this.lease.me, now: Date.now() },
        );
      } catch (err) {
        // Beside the api's and worker's own writes a page can deadlock: Neo4j rolled it back, so it is run again.
        if ((err as { code?: string }).code === 'Neo.TransientError.Transaction.DeadlockDetected') {
          await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
          continue;
        }
        if (!outOfMemory(err) || this.page === 1) throw err;
        this.page = Math.max(1, Math.floor(this.page / 2));
        continue;
      }
      if (!r) return null; // another process took the lease over
      const n = Number(r.get('n'));
      walked += n;
      if (n < this.page) {
        await this.lease.release(true);
        return walked;
      }
      cursor = r.get('last');
    }
  }
}

/** The whole upgrade now, in this process (tests, and scripts that need it done). Returns how many entries it walked. */
export async function backfillActivityTargets(g: GraphRepo): Promise<number> {
  const index = new ActivityTargetIndex(g);
  for (;;) {
    const n = await index.run();
    if (n !== null) return n;
    await new Promise((r) => setTimeout(r, 200));
  }
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
  /** Whether a target's entries can be found by its key yet; without one, they always can. */
  readonly targets: ActivityTargetIndex | null;

  constructor(g: GraphRepo, targets: ActivityTargetIndex | null = null) {
    this.g = g;
    this.targets = targets;
  }

  async record(input: ActivityInput): Promise<void> {
    const a = prepareActivity(input); // redacted, then cut
    // A record beside the Activity target upgrade's pages can deadlock on a key both link to: Neo4j aborts one,
    // which wrote nothing, and it is run again.
    await retryDeadlock(() => this.g.run(
      `CREATE (x:Activity {id: $id, ts: $ts, order: $order, kind: $a.kind, actor: $a.actor, projectKey: $a.projectKey,
                           subject: $a.subject, why: $a.why, details: $details, targets: $targets,
                           run: $run, sandbox: $sandbox})
       WITH x CALL (x) { ${ABOUT_TARGETS} }`,
      {
        id: `act:${randomUUID()}`,
        ts: new Date().toISOString(),
        order: order(),
        a,
        details: JSON.stringify(redactDeep(a.details ?? {})), // redact values, not JSON text
        targets: a.targets ?? [],
        keys: targetKeys(a.targets ?? []),
        run: a.run ?? null,
        sandbox: !!a.run && !!a.sandbox,
      },
    ));
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
    // details is a JSON string: one bigger than maxDetailBytes is never sent from the database. A target is found
    // through its (:ActivityTarget) key, and a kind by the (kind, order) index, rather than by reading every entry: the
    // index is used only with a predicate on order too, and gives its order (the page, not every entry of the kind) only
    // when sorted by both its properties and not behind the cursor's OPTIONAL MATCH (only a next page has one).
    // Until the upgrade has linked every older entry, a target's entries are read from their targets lists (every
    // entry has one), which reads the whole log but misses none.
    const byKind = q.target === undefined && q.kind !== undefined;
    const byKey = this.targets?.ready !== false;
    const rows = await this.g.run(
      `${q.before ? 'OPTIONAL MATCH (cursor:Activity {id: $before}) WITH cursor ' : ''}${q.target !== undefined ? (byKey ? 'MATCH (:ActivityTarget {id: $target})<-[:ABOUT]-(x:Activity) WHERE' : 'MATCH (x:Activity) WHERE $target IN coalesce(x.targets, []) AND') : byKind ? 'MATCH (x:Activity {kind: $kind}) WHERE x.order IS NOT NULL AND' : 'MATCH (x:Activity) WHERE'}
       ${q.before ? '(x.order < cursor.order OR (x.order = cursor.order AND x.id < cursor.id)) AND ' : ''}($projectKey IS NULL OR x.projectKey = $projectKey) AND ($kind IS NULL OR x.kind = $kind)
         AND ($projectKeys IS NULL OR x.projectKey IS NULL OR x.projectKey IN $projectKeys)
         AND ($run IS NULL OR x.run = $run)
         AND (NOT $unlabelled OR x.run IS NULL) AND (NOT $noSandbox OR NOT coalesce(x.sandbox, false))
       WITH x, $max IS NOT NULL AND size(coalesce(x.details, '')) > $max AS omitted
       RETURN x {.id, .ts, .kind, .actor, .projectKey, .subject, .why, .targets, .run, .sandbox, details: CASE WHEN omitted THEN null ELSE x.details END} AS row, omitted
       ORDER BY ${byKind ? 'x.kind DESC, ' : ''}x.order DESC, x.id DESC LIMIT $limit`,
      {
        projectKey: q.projectKey ?? null, projectKeys: q.projectKeys ?? null, kind: q.kind ?? null, target: q.target ?? null, run: q.run ?? null,
        limit: neo4j.int(q.limit ?? 200), max: q.maxDetailBytes === undefined ? null : neo4j.int(q.maxDetailBytes),
        unlabelled: !!q.unlabelled, noSandbox: !!q.noSandbox, before: q.before ?? null,
      },
    );
    return rows.map((r) => ({ ...activityOf(r.get('row')), ...(r.get('omitted') && { detailsOmitted: true }) }));
  }

  /**
   * The cursor is `<order>/<id>` of the last entry read: `order` is the log's sort key (indexed), the id breaks ties.
   * The tie is a NOT, not an OR with the id: an OR over two properties is planned as a union of two index reads of the
   * whole log, where this walks the order index from the cursor and stops at the page.
   */
  async since(q: ActivitySinceQuery): Promise<ActivityPage> {
    const slash = q.after ? q.after.indexOf('/') : -1;
    const afterOrder = q.after ? Number(q.after.slice(0, slash)) : -1;
    if (q.after && (slash < 0 || !Number.isFinite(afterOrder))) throw new Error(`not an Activity cursor: ${q.after}`);
    const rows = await this.g.run(
      `MATCH (x:Activity) WHERE x.order >= $afterOrder AND NOT (x.order = $afterOrder AND x.id <= $afterId)
         AND ($kinds IS NULL OR x.kind IN $kinds) AND (NOT $unlabelled OR x.run IS NULL) AND ($until IS NULL OR x.ts < $until)
       RETURN x ORDER BY x.order ${q.last ? 'DESC' : ''}, x.id ${q.last ? 'DESC' : ''} LIMIT $limit`,
      { afterOrder, afterId: q.after ? q.after.slice(slash + 1) : '', kinds: q.kinds ?? null, unlabelled: !!q.unlabelled, until: q.until ?? null, limit: neo4j.int(q.limit) },
    );
    if (q.last) rows.reverse();
    const last = rows.at(-1)?.get('x').properties;
    return { entries: rows.map((r) => activityOf(r.get('x').properties)), next: last ? `${last.order}/${last.id}` : (q.after ?? null) };
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
