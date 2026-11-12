import type { Hono } from 'hono';
import { z } from 'zod';
import { RUN_ID, RUN_ITEM_KINDS, runRemoval, storedLabel, type Activity, type ActivityKind, type ActivityStore, type Lesson, type ProjectLink, type RunItem, type RunItemKind, type RunOwner, type RunPrincipal, type RunsStore } from '@fb/core';
import type { ContextDeps } from './context.ts';
import { actingAsOperator, asActor, currentCaller, currentActor, currentRun } from './operator.ts';

/**
 * Runs: a tester (an automated agent pushing the tool) labels its requests with a run id (x-fg-run, or ?run= on the
 * MCP endpoints) and, if it likes, as a sandbox (x-fg-sandbox: 1). What a labelled request writes records the run
 * (operator.ts runIn), so `fg cleanup --run <id>` removes exactly that; a sandbox run's lessons, misses, facts,
 * documents and links are served only to that run's own agents (runScoped below, and the stores' searches).
 */

const RunParam = z.string().regex(RUN_ID, 'a run id: 1 to 64 letters, digits, dots, dashes or underscores');
/** dryRun (default true): only say what would go. */
const CleanupBody = z.object({ dryRun: z.boolean().optional() }).strict();
/** For the OpenAPI document (openapi.ts). */
export const runSchemas = { RunParam, CleanupBody };

/** A sandbox record (Lesson.sandbox, ProjectLink.sandbox) reaches an agent only in the run that wrote it. */
const visible = (x: { run?: string | null; sandbox?: boolean }) => !x.sandbox || (!!x.run && x.run === currentRun()?.id);

/** The run of the request being handled, as the stores' reads take it: null outside a labelled request. */
export const askingRun = (): string | null => currentRun()?.id ?? null;
/** The same, as a filter's `run` field: none outside a labelled request (the stores' default then lists no sandbox record). */
export const runAsked = (): { run?: string } => (currentRun() ? { run: currentRun()!.id } : {});

/**
 * The MCP endpoint's stores (and Ask's) as the run of the request being handled sees them: its writes carry the run;
 * every read is asked for the run (`run`), so the stores leave out other runs' sandbox lessons, misses, facts,
 * documents and links in their queries, and a sandbox record that still comes back is dropped here as well. Activity
 * says how each entry arrived and which run it was in (asActor).
 */
export function runScoped(d: ContextDeps): ContextDeps {
  const asked = <Q extends object>(q: Q): Q & { run: string | null } => ({ ...q, run: askingRun() });
  // Only inside a labelled run: elsewhere the writes stay as they were.
  const written = <Q extends object>(q: Q) => (currentRun() ? { ...q, run: currentRun() } : q);
  const { k, facts, docs, codegraph, links, sessions } = d;
  return {
    ...d,
    activity: asActor(d.activity),
    ...(sessions && { sessions: {
      list: async q => {
        const page = await sessions.list(asked(q));
        return { ...page, sessions: page.sessions.filter(visible) };
      },
      detail: async id => { const session = await sessions.detail(id); return session && visible(session) ? session : null; },
    } }),
    k: {
      searchLessons: (q) => k.searchLessons(asked(q)),
      relatedMisses: (q) => k.relatedMisses(asked(q)),
      missesNaming: (q) => k.missesNaming(asked(q)),
      recordPreDoneCheck: (c) => k.recordPreDoneCheck(written(c)),
      createManualFeedback: (i) => k.createManualFeedback(written(i)),
      ...(k.listLessons && { listLessons: async (f) => (await k.listLessons!(asked(f))).filter(visible) }),
    },
    ...(facts && {
      facts: {
        searchFacts: (q) => facts.searchFacts(asked(q)),
        ...(facts.listFacts && { listFacts: (q) => facts.listFacts!(asked(q)) }),
      },
    }),
    ...(docs && {
      docs: {
        searchDocs: (q) => docs.searchDocs(asked(q)),
        ...(docs.linkedDocs && { linkedDocs: (q) => docs.linkedDocs!(asked(q)) }),
      },
    }),
    ...(codegraph && {
      codegraph: {
        lessonsForPaths: async (key, paths) => (await codegraph.lessonsForPaths(key, paths, askingRun())).filter((x) => visible(x.lesson)),
        ...(codegraph.moduleContext && {
          moduleContext: async (key, path) => {
            const m = await codegraph.moduleContext!(key, path, askingRun());
            return m && { ...m, lessons: m.lessons.filter(visible) };
          },
        }),
        ...(codegraph.impact && {
          impact: async (key, paths, depth) => {
            const r = await codegraph.impact!(key, paths, depth, askingRun());
            return { ...r, lessons: r.lessons.filter((l: Lesson) => visible(l)) };
          },
        }),
        ...(codegraph.codeMapMeta && { codeMapMeta: codegraph.codeMapMeta.bind(codegraph) }),
        // The agent's own session's edited files: which facts are its own change.
        ...(codegraph.sessionFiles && { sessionFiles: codegraph.sessionFiles.bind(codegraph) }),
      },
    }),
    ...(links && { links: { listLinks: async (q) => (await links.listLinks(asked(q))).filter((l: ProjectLink) => visible(l)) } }),
  };
}

/** Who opened a run, in words (a refused cleanup, and the 409 for a write under someone else's run in app.ts). */
export const RUN_OPENERS: Record<RunPrincipal, string> = {
  operator: 'the operator token', owner_token: "the owner's API token", browser: 'the browser', agent: 'an API agent',
};
/** The same, naming the operator when the run recorded one; a principal another release stored is named as stored. */
export const openerOf = (o: RunOwner): string => (o.principal === 'operator' && o.actor?.startsWith('run-key:') ? 'the operator token with a private run key' : o.principal === 'operator' && o.actor ? `the operator token as ${o.actor}` : storedLabel(RUN_OPENERS, o.principal, (p) => `the ${p} credential`));

/** The credential behind each principal, as the caller configured it. */
const SENT: Record<RunPrincipal, string> = { operator: 'FG_OPERATOR_TOKEN', owner_token: 'FG_OWNER_TOKEN', browser: 'a browser sign-in', agent: 'API_TOKEN' };

/**
 * The 409 for a write under a run another caller opened: what this request sent and what to change, never the opener's
 * run key or operator name beyond openerOf.
 */
export function runConflict(runId: string, o: RunOwner, principal: RunPrincipal): string {
  const step = principal === o.principal
    ? 'this request sent a different FG_RUN_KEY: use the FG_RUN_KEY that opened it'
    : principal === 'operator' && o.principal === 'agent'
      ? 'this request sent FG_OPERATOR_TOKEN, which takes precedence over API_TOKEN: clear FG_OPERATOR_TOKEN to act with API_TOKEN and the same FG_RUN_KEY'
      : `this request sent ${SENT[principal]}, not the credential that opened it: use that credential and the same FG_RUN_KEY`;
  return `run id belongs to another caller: ${runId} was opened by ${openerOf(o)} at ${o.firstSeen}; ${step}, or choose another run id only for a genuinely separate run`;
}

/**
 * Whether a request holds the credential that opened the run. Legacy operator display names cannot authenticate it.
 */
export const sameCaller = (o: RunOwner, principal: RunPrincipal, actor: string | null): boolean =>
  o.principal === principal && (principal !== 'operator' || (!!actor && actor.startsWith('run-key:') && o.actor === actor));

/** Activity kinds that change a record: one of these on a run's record, made outside the run, means someone else touched it. */
const TOUCHES: ReadonlySet<ActivityKind> = new Set(['feedback_decided', 'lesson_decided', 'link_decided', 'fact_relevance_set', 'lesson_to_fact', 'doc_added', 'doc_removed']);
/** Entries that record what an agent was served or checked, not a change. */
const SERVED: ReadonlySet<ActivityKind> = new Set(['context_served', 'predone_check', 'run_cleaned']);
/** Entries made by a request (asActor records how it arrived), not the worker's own processing. */
const byRequest = (a: Activity) => typeof a.details?.via === 'string';
/** The server stamps transport principal; display names and model/provider actors are not authentication. */
const ownRequestEntry = (a: Activity, owner: RunOwner | null): boolean => {
  if (!byRequest(a)) return true;
  const via = owner?.principal === 'operator' ? 'operator' : owner?.principal === 'browser' ? 'browser' : owner ? 'api' : null;
  return via !== null && a.details?.via === via;
};
/** The page size a plan reads a run's Activity entries in (it reads every page). */
const RUN_ENTRIES = 500;

export type CleanupPlan = {
  run: string;
  dryRun: boolean;
  /** Any of its records is from a sandbox request. */
  sandbox: boolean;
  /** What a cleanup removes, per kind. */
  remove: Record<RunItemKind, number>;
  /** The run's records that stay, and why: someone outside the run decided on them since, or the detector made a report its own. */
  kept: { kind: RunItemKind; id: string; why: string }[];
  /** The run's other changes (deciding the owner's Inbox item, a pin, a scan): never undone, listed so you can. */
  changed: { kind: ActivityKind; subject: string; targets: string[]; ts: string }[];
  /** Its Activity entries: a real cleanup removes them (all but its own run_cleaned entry, which is not the run's). */
  entries: number;
};

/** activity: as createApp wraps it (asActor), so the cleanup is logged as whoever asked for it. */
export type RunsDeps = { store: Pick<RunsStore, 'items' | 'remove' | 'owner' | 'sandbox'>; activity: Pick<ActivityStore, 'record' | 'list' | 'removeRun'> };

/** What cleaning up `run` would do (see CleanupPlan), and the ids it keeps. */
export async function planCleanup(run: string, d: RunsDeps): Promise<{ plan: Omit<CleanupPlan, 'dryRun'>; keep: string[]; keptIds: string[]; entries: Activity[]; items: RunItem[] }> {
  const items = await d.store.items(run);
  const entries: Activity[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await d.activity.list({ run, limit: RUN_ENTRIES, ...(before && { before }) });
    entries.push(...page);
    if (page.length < RUN_ENTRIES) break;
    const next = page.at(-1)!.id;
    if (next === before) throw new Error('run Activity pagination did not advance');
    before = next;
  }
  const ids = new Set(items.map((i) => i.id));
  const report = (i: RunItem) => i.group ?? i.id;
  const kept = new Map<string, { kind: RunItemKind; id: string; why: string }>();
  for (const i of items) {
    if (i.merged && (i.kind === 'feedback' || !kept.has(report(i)))) {
      kept.set(report(i), { kind: 'feedback', id: report(i), why: 'the detector flagged the same pushback in a session, so it is that session\'s Inbox item now' });
    }
  }
  for (const i of items) {
    const key = i.kind === 'feedback' || i.group ? report(i) : i.id;
    if (kept.has(key)) continue;
    const touches = (await d.activity.list({ target: i.id, limit: 50 })).filter((a) => TOUCHES.has(a.kind) && byRequest(a) && a.run !== run);
    if (touches.length) {
      const t = touches[0];
      kept.set(key, { kind: i.kind === 'feedback' || i.group ? 'feedback' : i.kind, id: key, why: `${t.actor} touched it outside the run (${t.subject}, ${t.ts})` });
    }
  }
  // A merged report is never removed by the store anyway: only what someone touched needs keeping.
  const keep = [...kept.keys()].filter((key) => !items.some((i) => i.merged && report(i) === key));
  // Every record that stays (with a report, its lesson and miss): the entries about them stay too.
  const keptIds = [...new Set([...kept.keys(), ...items.filter((i) => kept.has(i.kind === 'feedback' || i.group ? report(i) : i.id)).map((i) => i.id)])];
  const remove = Object.fromEntries(Object.entries(runRemoval(items, keep)).map(([kind, list]) => [kind, list.length])) as Record<RunItemKind, number>;
  // What the run did through a request beyond writing its own records (a decision on the owner's item, a pin, a scan);
  // what it was served is not a change.
  const changed = entries
    .filter((a) => byRequest(a) && !SERVED.has(a.kind) && (!a.targets.length || a.targets.some((t) => !ids.has(t))))
    .map((a) => ({ kind: a.kind, subject: a.subject, targets: a.targets.filter((t) => !ids.has(t)), ts: a.ts }));
  // Preview the same permissions and keep rules already enforced by removeRun; leave the deletion path unchanged.
  const owner = await d.store.owner(run);
  const removableIds = new Set(items.filter(i => !keep.includes(i.id) && !keptIds.includes(i.id) && !i.merged).map(i => i.id));
  const previewEntries = entries.filter(a => (!TOUCHES.has(a.kind) || (a.targets.length > 0 && a.targets.every(id => removableIds.has(id))))
    && !a.targets.some(t => keptIds.includes(t))
    && ownRequestEntry(a, owner));
  const order = (k: RunItemKind) => RUN_ITEM_KINDS.indexOf(k);
  return {
    plan: {
      run, sandbox: (await d.store.sandbox(run)) || items.some((i) => i.sandbox) || entries.some(a => a.sandbox), remove,
      kept: [...kept.values()].sort((a, b) => order(a.kind) - order(b.kind) || (a.id < b.id ? -1 : 1)),
      changed, entries: previewEntries.length,
    },
    keep,
    keptIds,
    entries,
    items,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KIND_WORDS: Record<RunItemKind, [string, string]> = {
  feedback: ['report', 'reports'], lesson: ['lesson', 'lessons'], miss: ['miss', 'misses'], predone_check: ['pre-done check', 'pre-done checks'],
  fact: ['fact', 'facts'], doc: ['document', 'documents'], link: ['link', 'links'], chat: ['conversation', 'conversations'],
};
const summary = (counts: Record<RunItemKind, number>) =>
  RUN_ITEM_KINDS.filter((k) => counts[k]).map((k) => plural(counts[k], ...KIND_WORDS[k])).join(', ') || 'nothing';


/**
 * Whether the operator request being handled may clean up a run `owner` opened (null: never opened, or before owners
 * were recorded). Its own runs: those it opened under the same name (or with no name recorded). And a run an agent
 * without a token opened: such an agent has no credential to clean up with, and a cleanup removes only what the run
 * wrote, never what anyone outside it touched since. A run you opened (the browser, the API token) stays yours.
 */
function operatorMayClean(owner: RunOwner | null): boolean {
  if (!owner) return false;
  return sameCaller(owner, 'operator', currentCaller());
}

/**
 * GET /api/runs/:id: the plan (a read). DELETE /api/runs/:id: a dry run unless the body says dryRun: false; owner-only
 * (OWNER_ROUTES), and the operator's run_cleanup verb is on by default because it removes only what a run wrote. The
 * operator token may clean up the runs opened with its private run key
 * (operatorMayClean); you may clean up any. A real cleanup removes the run's Activity entries as well.
 */
export function runRoutes(app: Hono, d: RunsDeps) {
  const { activity } = d;
  app.get('/api/runs/:id', async (c) => {
    const run = RunParam.safeParse(c.req.param('id'));
    if (!run.success) return c.json({ error: run.error.issues[0].message }, 400);
    return c.json({ ...(await planCleanup(run.data, d)).plan, dryRun: true });
  });
  app.delete('/api/runs/:id', async (c) => {
    const run = RunParam.safeParse(c.req.param('id'));
    if (!run.success) return c.json({ error: run.error.issues[0].message }, 400);
    const body = CleanupBody.safeParse((await c.req.json().catch(() => null)) ?? {});
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const { plan, keep, keptIds, entries, items } = await planCleanup(run.data, d);
    // Who opened the run (RunsStore.claim), not what its Activity says: a run opened with the API token, by an agent or
    // in the browser is the owner's to clean up, and so is one opened before owners were recorded (none stored).
    const owner = await d.store.owner(run.data);
    // No owner and nothing to remove: a run already cleaned up (cleanup releases the owner) or never opened. Saying
    // "nothing to remove" tells a caller no more than an unused run id would; a run someone owns, or legacy records
    // without an owner, stay refused.
    const empty = !owner && !Object.values(plan.remove).some(Boolean) && !plan.kept.length && !plan.entries;
    if (!actingAsOperator() && currentCaller() && !empty && (owner?.principal !== 'agent' || owner.actor !== currentCaller())) {
      return c.json({ error: `run ${run.data} belongs to another caller; use the same FG_RUN_KEY that opened it, or the authenticated owner UI` }, 403);
    }
    if (actingAsOperator()) {
      if (!operatorMayClean(owner) && !empty) {
        const by = owner ? `was opened by ${openerOf(owner)}` : 'was opened before run owners were recorded';
        const who = owner?.principal === 'operator' && owner.actor
          ? 'only the original FG_RUN_KEY or the owner can clean it up; legacy runs require the owner'
          : 'only the owner can clean it up: use fg cleanup --run <id> --owner with FG_OWNER_TOKEN, or the authenticated browser UI';
        return c.json({ error: `run ${run.data} ${by}: ${who}; the operator token cleans up only runs opened with its private FG_RUN_KEY` }, 403);
      }
    }
    if (body.data.dryRun !== false) return c.json({ ...plan, dryRun: true });
    // Nothing to remove, and no run_cleaned entry for a cleanup that did nothing (a re-run would log one each time).
    if (empty) return c.json({ ...plan, dryRun: false, removed: plan.remove, entriesRemoved: 0 });
    const removed = await d.store.remove(run.data, keep);
    // The run's own entries go too (a stress run's thousands would fill the log); what it changed outside its own
    // records is kept in the run_cleaned entry below, which is not the run's.
    // A decision the run made on a record it does not own stays in that record's history (TOUCHES): a cleanup never
    // erases the trace of a change it cannot undo.
    // Only the entries the plan read, so every change removed is one listed below; and never an entry about a record that
    // stays (the one that created it included).
    const removedIds = new Set(items.filter(item => !keep.includes(item.id) && !keptIds.includes(item.id) && !item.merged).map(item => item.id));
    const removableEntries = entries.filter(a => ownRequestEntry(a, owner) && (!TOUCHES.has(a.kind) || (a.targets.length > 0 && a.targets.every(id => removedIds.has(id)))));
    const entriesRemoved = await activity.removeRun(run.data, [], { ids: removableEntries.map(a => a.id), targets: keptIds });
    await activity.record({
      // Not tagged with a run (null, not the asking request's): the entry is about the run, not made in it.
      kind: 'run_cleaned', actor: 'you', projectKey: null, run: null,
      subject: `cleaned up run ${run.data}: removed ${summary(removed)}${plan.kept.length ? `; kept ${plural(plan.kept.length, 'record')}` : ''}${entriesRemoved ? `; ${plural(entriesRemoved, 'Activity entry', 'Activity entries')}` : ''}`,
      why: `you asked for it (fg cleanup): only what the run wrote is removed, and not what anyone outside the run touched since; its Activity entries go too, except its decisions on records it does not own, which stay on those records, and the entries about records that stay (this entry lists what the run changed outside its own records)`,
      details: {
        run: run.data, removed, kept: plan.kept.length, keptItems: plan.kept, changed: plan.changed.length, changedItems: plan.changed,
        entriesRemoved, openedBy: owner?.principal ?? null,
      },
      targets: [],
    });
    return c.json({ ...plan, dryRun: false, removed, entriesRemoved });
  });
}
