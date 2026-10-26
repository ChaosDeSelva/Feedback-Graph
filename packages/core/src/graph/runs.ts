import { removedCounts, runItems, runRemoval, type RunRow } from '../runs.ts';
import type { RunsStore } from '../store.ts';
import { RUN_ITEM_KINDS, type RunItem, type RunItemKind, type RunOwner, type RunPrincipal } from '../types.ts';
import type { GraphRepo } from './repo.ts';

/**
 * A record a sandbox run wrote is served only to that run: `$run` is the asking agent's run id, or null (then no
 * sandbox record is). Always true or false, never null, so it is safe under NOT.
 */
export const VISIBLE_TO_RUN = (x: string) => `(NOT coalesce(${x}.sandbox, false) OR coalesce(${x}.run = $run, false))`;

/** Each kind's records with a run id (the label's `run` property), as RunRow columns. */
const FIND: Record<RunItemKind, string> = {
  feedback: `MATCH (x:Candidate {run: $run}) RETURN x.id AS id, x.projectKey AS projectKey, coalesce(x.sandbox, false) AS sandbox, coalesce(x.detected, false) AS merged`,
  lesson: `MATCH (x:Lesson {run: $run}) RETURN x.id AS id, coalesce(x.projectKey, x.originProjectKey) AS projectKey, coalesce(x.sandbox, false) AS sandbox, false AS merged`,
  miss: `MATCH (x:Miss {run: $run}) RETURN x.id AS id, x.projectKey AS projectKey, coalesce(x.sandbox, false) AS sandbox, false AS merged`,
  predone_check: `MATCH (x:PreDoneCheck {run: $run}) RETURN x.id AS id, x.projectKey AS projectKey, false AS sandbox, false AS merged`,
  // A document's facts go with it: only the facts written on their own.
  fact: `MATCH (x:Fact {run: $run}) WHERE x.docId IS NULL RETURN x.id AS id, x.projectKey AS projectKey, coalesce(x.sandbox, false) AS sandbox, false AS merged`,
  doc: `MATCH (x:Doc {run: $run}) RETURN x.id AS id, x.projectKey AS projectKey, coalesce(x.sandbox, false) AS sandbox, false AS merged`,
  link: `MATCH (x:ProjectLink {run: $run}) RETURN x.id AS id, x.a AS projectKey, coalesce(x.sandbox, false) AS sandbox, false AS merged`,
  chat: `MATCH (x:ChatConversation {run: $run}) RETURN x.id AS id, x.projectKey AS projectKey, false AS sandbox, false AS merged`,
};

/**
 * Each kind's delete, by `$ids`, and only while the record still carries the run's id (an upload replaced by the owner
 * since is not the run's any more). Lessons and misses first, so a report's chain goes from its end.
 */
const DELETE: [RunItemKind, string][] = [
  ['lesson', `UNWIND $ids AS id MATCH (x:Lesson {id: id, run: $run}) DETACH DELETE x RETURN count(*) AS n`],
  ['miss', `UNWIND $ids AS id MATCH (x:Miss {id: id, run: $run})
            OPTIONAL MATCH (ci:ContextItem)-[:WOULD_HAVE_PREVENTED]->(x)
            WITH x, collect(ci) AS items
            FOREACH (ci IN items | DETACH DELETE ci)
            DETACH DELETE x RETURN count(*) AS n`],
  // The report's stand-in session and turn (never a real session's: a merged report is not deleted), its feedback and task.
  ['feedback', `UNWIND $ids AS id MATCH (x:Candidate {id: id, run: $run}) WHERE NOT coalesce(x.detected, false)
                OPTIONAL MATCH (x)-[:FLAGS]->(t:Turn)<-[:HAS_TURN]-(s:Session {manual: true})
                OPTIONAL MATCH (f:Feedback {id: id})
                OPTIONAL MATCH (task:Task {id: 'task:' + id})
                WITH x, collect(t) + collect(s) + collect(f) + collect(task) AS rest
                FOREACH (r IN rest | DETACH DELETE r)
                DETACH DELETE x RETURN count(*) AS n`],
  ['predone_check', `UNWIND $ids AS id MATCH (x:PreDoneCheck {id: id, run: $run}) DETACH DELETE x RETURN count(*) AS n`],
  ['fact', `UNWIND $ids AS id MATCH (x:Fact {id: id, run: $run}) WHERE x.docId IS NULL DETACH DELETE x RETURN count(*) AS n`],
  ['doc', `UNWIND $ids AS id MATCH (x:Doc {id: id, run: $run})
           OPTIONAL MATCH (x)-[:HAS_CHUNK]->(c:Chunk)
           WITH x, id, collect(c) AS chunks
           OPTIONAL MATCH (f:Fact {docId: id})
           WITH x, id, chunks, collect(f) AS facts
           OPTIONAL MATCH (b:DocBlob {docId: id})
           WITH x, chunks, facts, collect(b) AS blobs
           WITH x, chunks + facts + blobs AS rest
           FOREACH (r IN rest | DETACH DELETE r)
           DETACH DELETE x RETURN count(*) AS n`],
  ['link', `UNWIND $ids AS id MATCH (x:ProjectLink {id: id, run: $run}) DETACH DELETE x RETURN count(*) AS n`],
  ['chat', `UNWIND $ids AS id MATCH (x:ChatConversation {id: id, run: $run})
            OPTIONAL MATCH (t:ChatTurn {conversationId: id})
            WITH x, collect(t) AS turns
            FOREACH (t IN turns | DETACH DELETE t)
            DETACH DELETE x RETURN count(*) AS n`],
];

const OWNER = 'o.run AS run, o.principal AS principal, o.actor AS actor, o.firstSeen AS firstSeen';
const ownerOf = (r: { get(k: string): unknown }): RunOwner => ({
  run: r.get('run') as string, principal: r.get('principal') as RunPrincipal, actor: (r.get('actor') as string | null) ?? null, firstSeen: r.get('firstSeen') as string,
});

export class RunsRepo implements RunsStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async items(run: string): Promise<RunItem[]> {
    const rows: RunRow[] = [];
    for (const kind of RUN_ITEM_KINDS) {
      for (const r of await this.g.run(FIND[kind], { run })) {
        rows.push({ kind, id: r.get('id'), projectKey: r.get('projectKey') ?? null, sandbox: r.get('sandbox') === true, merged: r.get('merged') === true });
      }
    }
    return runItems(rows);
  }

  async remove(run: string, keep: string[]): Promise<Record<RunItemKind, number>> {
    const ids = runRemoval(await this.items(run), keep);
    const out = await this.g.runInTransaction(DELETE.map(([kind, cypher]) => [cypher, { run, ids: ids[kind] }]));
    // The run's sandbox records may have been the last ones: the searches may skip the run filter again.
    this.g.sandbox.recheck();
    return removedCounts(Object.fromEntries(DELETE.map(([kind], i) => [kind, Number(out[i]?.[0]?.get('n') ?? 0)])));
  }

  async claim(run: string, principal: RunPrincipal, actor: string | null = null): Promise<RunOwner> {
    // MERGE on the unique run (schema.ts run_owner_run): a claim that loses a race matches the winner's node.
    const [r] = await this.g.run(
      `MERGE (o:RunOwner {run: $run}) ON CREATE SET o.principal = $principal, o.actor = $actor, o.firstSeen = $now
       RETURN ${OWNER}`,
      { run, principal, actor: principal === 'operator' ? actor : null, now: new Date().toISOString() },
    );
    return ownerOf(r);
  }

  async owner(run: string): Promise<RunOwner | null> {
    const [r] = await this.g.run(`MATCH (o:RunOwner {run: $run}) RETURN ${OWNER}`, { run });
    return r ? ownerOf(r) : null;
  }
}
