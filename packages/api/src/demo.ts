import type { Hono } from 'hono';
import { z } from 'zod';
import { DEMO_SOURCE, demoPrefix, type ActivityStore, type Cause, type CodeGraphStore, type FactKind, type FactsStore, type KnowledgeStore, type OperatorConfig, type Project } from '@fb/core';
import { currentRun, hasOperatorToken, operatorName, runAs } from './operator.ts';

/**
 * fg demo seed / remove: a small, clearly labelled corpus in a demo project, so a tester whose own projects have no
 * approved lesson yet sees the lesson path fire (get_task_context, the edit hook, check_before_done). Everything it
 * writes is marked demo (lessons with source 'demo' and "[demo]" titles, a miss under a demo: session, facts with
 * source 'demo') and `fg demo remove` takes back exactly that. The lessons are approved because the owner ran the
 * command: the output says so. Another project than the demo one only on request, and only for the owner.
 */

/** examples/demo-shop: a small multi-tenant API whose CLAUDE.md states the rules the corpus is about. */
export const DEMO_PROJECT = 'demo-shop';
const SOURCE = DEMO_SOURCE;
/** Synthetic diff only: no host repository is edited or probed. */
export const DEMO_PROBE = {
  task: 'Edit src/probes/no-console.ts', files: ['src/probes/no-console.ts'],
  diff: 'diff --git a/src/probes/no-console.ts b/src/probes/no-console.ts\n--- a/src/probes/no-console.ts\n+++ b/src/probes/no-console.ts\n@@ -0,0 +1 @@\n+console.log("request started");\n',
  expectedLessonSlug: 'no-console-probe', expectedVerdict: 'gap',
};


type DemoLesson = { slug: string; title: string; rule: string; appliesWhen: string; paths: string[] };
type DemoFact = { path: string; kind: FactKind; statement: string; lines: string | null };

export const DEMO_CORPUS: {
  lessons: DemoLesson[];
  miss: { slug: string; feedbackText: string; whatWasDone: string; missed: string; cause: Cause; causeExplanation: string; files: string[] };
  facts: DemoFact[];
} = {
  lessons: [
    {
      slug: 'no-console-probe', title: 'No console.log in the isolated probe module',
      rule: 'Do not call console.log in src/probes/no-console.ts.',
      appliesWhen: 'editing src/probes/no-console.ts', paths: ['src/probes/no-console.ts'],
    },
    {
      slug: 'tenant-scoping', title: 'Routes read data only through db.scoped(orgId)',
      rule: 'Every route query goes through db.scoped(req.auth.orgId). Never call db.raw() from src/routes: it returns every org\'s rows.',
      appliesWhen: 'adding or changing a route or any query a route makes', paths: ['src/routes/customers.ts', 'src/db.ts'],
    },
    {
      slug: 'pagination', title: 'List endpoints paginate on the server',
      rule: 'A list endpoint returns paginate(rows, req.query) (default 20, at most 50), never the whole list.',
      appliesWhen: 'an endpoint that returns a list', paths: ['src/routes/customers.ts', 'src/http.ts'],
    },
    {
      slug: 'errors', title: 'Errors go through sendError',
      rule: 'Respond to a failure with sendError(res, status, code, message), which sends { error: { code, message } }; never a bare string.',
      appliesWhen: 'a route that can fail (not found, bad input, forbidden)', paths: ['src/http.ts', 'src/routes/customers.ts'],
    },
    {
      slug: 'cross-tenant-test', title: 'Every route has a cross-tenant test',
      rule: 'Each new route gets a test in test/ that calls it as another org and expects no data from this one (404 or an empty page).',
      appliesWhen: 'adding a route or changing what one returns', paths: ['test/customers.test.ts', 'src/routes/customers.ts'],
    },
  ],
  miss: {
    slug: 'orders-raw',
    feedbackText: 'This returns every org\'s orders. Routes must use db.scoped, it is in CLAUDE.md.',
    whatWasDone: 'added GET /customers/:id/orders reading db.raw(\'orders\') and filtering by customer id',
    missed: 'The new orders route read db.raw() and filtered only by customer id, so it served other orgs\' orders; no cross-tenant test caught it.',
    cause: 'context_available_ignored',
    causeExplanation: 'CLAUDE.md and the comment on db.raw() both say routes use db.scoped; the agent did not read them before writing the route.',
    files: ['src/routes/customers.ts'],
  },
  facts: [
    { path: 'src/db.ts', kind: 'invariant', statement: 'db.scoped(orgId) filters every list and get by orgId; db.raw() is unscoped and meant for admin scripts only.', lines: null },
    { path: 'src/http.ts', kind: 'api', statement: 'paginate(rows, query) pages a list (default 20, at most 50); sendError(res, status, code, message) sends { error: { code, message } }.', lines: null },
    { path: 'src/routes/customers.ts', kind: 'convention', statement: 'Customer routes read through db.scoped(req.auth.orgId) and return lists through paginate.', lines: null },
  ],
};

export type DemoDeps = {
  knowledge: Pick<KnowledgeStore, 'upsertLesson'> & Partial<Pick<KnowledgeStore, 'saveDemoMiss' | 'removeDemo'>>;
  facts: Pick<FactsStore, 'listFacts' | 'saveFileFacts'>;
  codegraph?: Pick<CodeGraphStore, 'recordSessionFiles'>;
  embed(texts: string[]): Promise<number[][]>;
  activity?: Pick<ActivityStore, 'record'>;
  /** The project for a key (its folder under the roots), or null when no folder has it. */
  project(key: string): Project | null;
  /** Is it in the owner's selection (agents get its lessons only then)? Unset: not said. */
  selected?: (key: string) => Promise<boolean>;
};

export type DemoSeeded = { probe: typeof DEMO_PROBE; project: string; lessons: number; misses: number; facts: number; skippedFacts: string[]; message: string };
export type DemoRemovedResult = { project: string; lessons: number; misses: number; facts: number; message: string };

/**
 * Refused: not the owner for another project, a bad key, or a store without the demo methods; or a seed that failed
 * part-way and was taken back (500). status: the HTTP answer.
 */
export class DemoRefused extends Error {
  status: 400 | 403 | 500 | 501;
  constructor(message: string, status: 400 | 403 | 500 | 501) {
    super(message);
    this.status = status;
  }
}

const KEY = /^\w[\w.-]{0,199}$/;
const n = (k: number, w: string, ws = `${w}s`) => `${k} ${k === 1 ? w : ws}`;

/** The project to write to: the demo one, or `project` when the owner asked for it. */
function target(o: { project?: string; owner?: boolean }): string {
  const key = o.project ?? DEMO_PROJECT;
  if (!KEY.test(key) || key.includes('..')) throw new DemoRefused(`not a project key: ${JSON.stringify(key)}`, 400);
  if (key !== DEMO_PROJECT && !o.owner) {
    throw new DemoRefused(`the demo corpus goes into ${DEMO_PROJECT}; putting approved demo lessons into ${key} needs the owner (the UI, or FG_OPERATOR_TOKEN with lesson_decide in OPERATOR_ALLOW)`, 403);
  }
  return key;
}

/**
 * Seed (again, in place) the demo corpus. Idempotent: ids are fixed, so a second run rewrites the same records. All or
 * nothing: a write that fails part-way takes back what the seed wrote (removeDemo) and says so. In a labelled run
 * (x-fg-run) the lessons and the miss carry the run, so `fg cleanup --run` removes them as well.
 */
export async function seedDemo(o: { project?: string; owner?: boolean }, d: DemoDeps): Promise<DemoSeeded> {
  const key = target(o);
  const k = d.knowledge;
  if (!k.saveDemoMiss || !k.removeDemo) throw new DemoRefused('this store cannot hold a demo corpus (no saveDemoMiss / removeDemo)', 501);
  const found = d.project(key);
  const project: Project = found ?? { key, name: key, repoPath: '' };
  const prefix = demoPrefix(key);
  const run = currentRun();
  const c = DEMO_CORPUS;
  const [lessonVecs, missVecs, factVecs] = await Promise.all([
    d.embed(c.lessons.map((l) => `[demo] ${l.title}\n${l.rule}\nApplies when: ${l.appliesWhen}`)),
    d.embed([c.miss.missed]),
    d.embed(c.facts.map((f) => `${f.path}: ${f.statement}`)),
  ]);
  const lessonIds: string[] = [];
  let missId: string;
  let facts = 0;
  const skippedFacts: string[] = [];
  try {
    // The miss first: it is what creates the project when there is none, marked as the demo's so removeDemo can take
    // that back too. Called on the store, never detached: the real stores' methods use `this`.
    const at = Date.now() - 86_400_000;
    const missSession = `${prefix}${c.miss.slug}`;
    missId = await k.saveDemoMiss({
      project, id: missSession, ts: new Date(at).toISOString(), feedbackText: c.miss.feedbackText, whatWasDone: c.miss.whatWasDone,
      missed: c.miss.missed, cause: c.miss.cause, causeExplanation: c.miss.causeExplanation, embedding: missVecs[0],
      ...(run && { run }),
    });
    // A day ago, edited just before and fixed just after: the code map shows it as a miss on that file, since fixed.
    await d.codegraph?.recordSessionFiles(missSession, c.miss.files.map((path) => ({
      path, read: true, edited: true, firstEditAt: new Date(at - 60_000).toISOString(), lastEditAt: new Date(at + 60_000).toISOString(),
    })));
    for (const [i, l] of c.lessons.entries()) {
      const id = `${prefix}${l.slug}`;
      await k.upsertLesson({
        id, projectKey: key, title: `[demo] ${l.title}`, rule: l.rule, appliesWhen: l.appliesWhen, scope: 'project', paths: l.paths,
        status: 'approved', source: SOURCE, embedding: lessonVecs[i], ...(run && { run }),
      });
      lessonIds.push(id);
    }
    // A file that has facts (a scan read it) keeps them: saving demo facts would close them.
    for (const [i, f] of c.facts.entries()) {
      if ((await d.facts.listFacts({ projectKey: key, path: f.path, limit: 1 })).length) {
        skippedFacts.push(f.path);
        continue;
      }
      // Hash 'demo' is never a real file's: the next scan of the file reads it and replaces these with what it finds. A
      // file a scan already recorded keeps its hash and summary (the store adds the file only when there is none).
      await d.facts.saveFileFacts(key, { path: f.path, hash: SOURCE, summary: '[demo] seeded by fg demo seed' }, [
        { kind: f.kind, statement: `[demo] ${f.statement}`, path: f.path, lines: f.lines, confidence: 1, why: 'seeded by fg demo seed', embedding: factVecs[i] },
      ], SOURCE);
      facts++;
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const undone = await k.removeDemo(key).then(
      () => 'what it had written was taken back',
      (u) => `taking back what it had written failed too (${u instanceof Error ? u.message : String(u)}): run fg demo remove${key === DEMO_PROJECT ? '' : ` --project ${key}`}`,
    );
    throw new DemoRefused(`demo seed failed in ${key}: ${why}; ${undone}`, 500);
  }
  const selected = d.selected ? await d.selected(key) : null;
  const message = [
    `Seeded the demo corpus into ${key}: ${n(lessonIds.length, 'approved lesson')} tied to files, ${n(1, 'miss', 'misses')} on ${c.miss.files.join(', ')}, ${n(facts, 'fact')}${skippedFacts.length ? ` (none for ${skippedFacts.join(', ')}: a scan's facts are there)` : ''}. Every one is marked demo.`,
    `These lessons are approved by you running fg demo seed: agents working in ${key} are given them. Take them back with fg demo remove${key === DEMO_PROJECT ? '' : ` --project ${key}`}.`,
    ...(found ? [] : [`No folder for ${key} is under the project roots, so agents cannot work in it yet (the lessons are stored by key).`]),
    ...(selected === false ? [`${key} is not selected: run fg projects select --key ${key} so agents get these.`] : []),
  ].join('\n');
  await d.activity?.record({
    kind: 'demo_seeded',
    actor: 'you',
    projectKey: key,
    subject: `demo corpus seeded in ${key}: ${n(lessonIds.length, 'approved lesson')}, 1 miss, ${n(facts, 'fact')}`,
    why: 'you ran fg demo seed; its lessons are approved by that and are marked demo (fg demo remove takes them back)',
    details: { lessons: lessonIds, miss: missId, facts, skippedFacts, ...(run && { run: run.id }) },
    targets: [...lessonIds, missId],
  });
  return { probe: DEMO_PROBE, project: key, lessons: lessonIds.length, misses: 1, facts, skippedFacts, message };
}

/** Remove exactly what the demo seed wrote in the project. */
export async function removeDemo(o: { project?: string; owner?: boolean }, d: DemoDeps): Promise<DemoRemovedResult> {
  const key = target(o);
  if (!d.knowledge.removeDemo) throw new DemoRefused('this store cannot hold a demo corpus (no removeDemo)', 501);
  const r = await d.knowledge.removeDemo(key);
  const message = [
    r.lessons + r.misses + r.facts
      ? `Removed ${n(r.lessons, 'demo lesson')}, ${n(r.misses, 'miss', 'misses')} and ${n(r.facts, 'fact')} from ${key}. Nothing else was touched.`
      : `No demo corpus in ${key}: nothing removed.`,
    ...(r.projectRemoved ? [`The project ${key} itself, which the seed created and nothing else uses, is gone too.`] : []),
  ].join(' ');
  await d.activity?.record({
    kind: 'demo_removed',
    actor: 'you',
    projectKey: key,
    subject: `demo corpus removed from ${key}: ${n(r.lessons, 'lesson')}, ${n(r.misses, 'miss', 'misses')}, ${n(r.facts, 'fact')}`,
    why: 'you ran fg demo remove',
    details: { ...r },
  });
  return { project: key, ...r, message };
}

const Body = z.object({ project: z.string().min(1).max(200).optional() }).strict();

/**
 * POST /api/demo/seed and /api/demo/remove. With the operator token: the demo project always, another project only
 * when OPERATOR_ALLOW has lesson_decide (the lessons are approved). Without it: only from the UI (a browser write
 * carries Origin), like every owner decision; a local client sending none is refused.
 */
export function demoRoutes(app: Hono, d: DemoDeps, auth: { operator?: OperatorConfig }) {
  const handle = (fn: typeof seedDemo | typeof removeDemo) => async (c: import('hono').Context) => {
    const parsed = Body.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const operator = hasOperatorToken(c, auth.operator);
    if (!operator && c.req.header('origin') === undefined) {
      return c.json({ error: 'only you can seed or remove the demo corpus: from the Feedback Graph UI, or with FG_OPERATOR_TOKEN as a Bearer (fg demo seed)' }, 403);
    }
    const owner = operator ? !!auth.operator?.allow.includes('lesson_decide') : true;
    const go = () => fn({ ...parsed.data, owner }, d);
    try {
      return c.json(await (operator ? runAs(operatorName(c.req.header('x-fg-operator')), go) : go()));
    } catch (e) {
      if (e instanceof DemoRefused) return c.json({ error: e.message }, e.status);
      if (e instanceof Error) return c.json({ error: `fg demo: ${e.message}` }, 500);
      throw e;
    }
  };
  app.post('/api/demo/seed', handle(seedDemo));
  app.post('/api/demo/remove', handle(removeDemo));
}
