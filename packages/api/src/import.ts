import type { Hono } from 'hono';
import { z } from 'zod';
import { EXPORT_FORMAT, FACT_KINDS, LESSON_CHECKS, redactDeep, type ActivityStore, type EmbeddedFact, type FactsStore, type KnowledgeStore, type LessonInput, type LessonStatus } from '@fb/core';

/**
 * POST /api/import: an export bundle (GET /api/export) back into a store, on this or another machine, either backend.
 * What is imported is what agents can use without the transcripts behind it: lessons, and the facts of a project
 * that has none yet. Misses, document metadata and the code map are counted but not imported (their evidence,
 * text and source are not in the bundle; the code map is rebuilt from the code).
 */
export type ImportDeps = {
  knowledge: Pick<KnowledgeStore, 'lessonDetail' | 'upsertLesson'>;
  facts: Pick<FactsStore, 'currentSources' | 'replaceProjectFacts'>;
  /** The current embedding model: nothing in a bundle carries vectors. */
  embed(texts: string[]): Promise<number[][]>;
  activity?: Pick<ActivityStore, 'record'>;
  /** EXCLUDE_PROJECTS: never imported either. */
  excluded: string[];
};

export type ImportResult = {
  lessons: { added: number; approved: number; proposed: number; revoked?: number; existing: number; excluded: number; skipped: number };
  facts: { added: number; projects: string[]; skippedProjects: string[] };
  notImported: { misses: number; docs: number; codeFiles: number };
};

/** A full export of a big graph is a few MB; this leaves a lot of room and still bounds memory. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const EMBED_BATCH = 64;

const Key = z.string().min(1).max(200).regex(/^\w[\w.-]*$/, 'a project folder name').refine((k) => !k.includes('..'), 'a project folder name');

// Unknown fields are dropped (zod's default): a newer export may add fields without bumping schemaVersion.
const Lesson = z.object({
  id: z.string().min(1).max(300).regex(/^[\w:.@/-]+$/, 'a lesson id').refine((k) => !k.includes('..'), 'a lesson id'),
  projectKey: Key.nullable(),
  title: z.string().min(1).max(300),
  rule: z.string().min(1).max(4000),
  appliesWhen: z.string().max(1000).default(''),
  scope: z.enum(['task', 'project', 'global']),
  paths: z.array(z.string().max(300)).max(50).default([]),
  status: z.enum(['proposed', 'approved', 'rejected', 'revoked', 'superseded']),
  source: z.enum(['postmortem', 'memory', 'manual', 'demo']).default('postmortem'),
  checks: z.array(z.object({ name: z.enum(LESSON_CHECKS), why: z.string().max(4000), of: z.string().max(300).optional() })).max(100).nullable().optional(),
});

const Fact = z.object({
  projectKey: Key,
  path: z.string().max(1000),
  lines: z.string().max(100).nullable().default(null),
  kind: z.enum(FACT_KINDS),
  statement: z.string().min(1).max(4000),
  why: z.string().max(2000).default(''),
  confidence: z.number().min(0).max(1),
  source: z.string().max(200).default('unknown'),
});

const Bundle = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.literal(SCHEMA_VERSION),
  toolVersion: z.string().max(50).default('unknown'),
  exportedAt: z.string().max(50).default(''),
  projectKey: Key.nullable().default(null),
  lessons: z.array(Lesson).max(20_000).default([]),
  facts: z.array(Fact).max(200_000).default([]),
  misses: z.array(z.unknown()).default([]),
  docs: z.array(z.unknown()).default([]),
  codeFiles: z.array(z.unknown()).default([]),
});
export type ImportBundle = z.infer<typeof Bundle>;
export const parseBundle = (json: unknown) => Bundle.safeParse(json);
/** For the OpenAPI document (openapi.ts). */
export const importSchemas = { Bundle };

async function embedAll(texts: string[], embed: ImportDeps['embed']): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...(await embed(texts.slice(i, i + EMBED_BATCH))));
  return out;
}

const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;

/** Import a validated bundle. Idempotent: lessons are matched by id and never overwritten; facts go only into a project with none. */
export async function importBundle(raw: ImportBundle, o: { keepApproved: boolean }, d: ImportDeps): Promise<ImportResult> {
  // Redact again: the bundle may come from an older version, another machine, or have been edited by hand.
  const b = redactDeep(raw);
  const never = new Set(d.excluded);
  const r: ImportResult = {
    lessons: { added: 0, approved: 0, proposed: 0, existing: 0, excluded: 0, skipped: 0 },
    facts: { added: 0, projects: [], skippedProjects: [] },
    notImported: { misses: b.misses.length, docs: b.docs.length, codeFiles: b.codeFiles.length },
  };

  const fresh: (z.infer<typeof Lesson> & { next: LessonStatus })[] = [];
  const seen = new Set<string>();
  for (const l of b.lessons) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    // A project or task lesson without its project would be served to every project: fail closed.
    if (l.status === 'rejected' || l.status === 'superseded' || (l.scope !== 'global' && !l.projectKey)) r.lessons.skipped++;
    else if (l.projectKey && never.has(l.projectKey)) r.lessons.excluded++;
    else if (await d.knowledge.lessonDetail(l.id)) r.lessons.existing++;
    else fresh.push({ ...l, next: l.status === 'revoked' ? 'revoked' : o.keepApproved && l.status === 'approved' ? 'approved' : 'proposed' });
  }
  const lessonVectors = await embedAll(fresh.map((l) => `${l.title}\n${l.rule}\nApplies when: ${l.appliesWhen}`), d.embed);
  const added: string[] = [];
  for (const [i, l] of fresh.entries()) {
    const input: LessonInput = {
      id: l.id, projectKey: l.scope === 'global' ? null : l.projectKey, title: l.title, rule: l.rule, appliesWhen: l.appliesWhen,
      scope: l.scope, paths: l.paths, status: l.next, source: l.source, embedding: lessonVectors[i],
      ...(l.checks != null && { checks: l.checks }),
    };
    await d.knowledge.upsertLesson(input);
    added.push(l.id);
    if (l.next === 'revoked') r.lessons.revoked = (r.lessons.revoked ?? 0) + 1;
    else r.lessons[l.next === 'approved' ? 'approved' : 'proposed']++;
  }
  r.lessons.added = added.length;

  const byProject = new Map<string, z.infer<typeof Fact>[]>();
  for (const f of b.facts) if (!never.has(f.projectKey)) byProject.set(f.projectKey, [...(byProject.get(f.projectKey) ?? []), f]);
  for (const [key, facts] of [...byProject].sort(([a], [b2]) => a.localeCompare(b2))) {
    // A project that already has facts keeps them: an import never replaces what a scan here found.
    if ((await d.facts.currentSources(key)).length) {
      r.facts.skippedProjects.push(key);
      continue;
    }
    const vectors = await embedAll(facts.map((f) => `${f.path}: ${f.statement}`), d.embed);
    const embedded: EmbeddedFact[] = facts.map((f, i) => ({ kind: f.kind, statement: f.statement, path: f.path, lines: f.lines, confidence: f.confidence, why: f.why, embedding: vectors[i] }));
    // A different source than any scan's: the first scan here rescans every file and replaces these.
    const sources = [...new Set(facts.map((f) => f.source))];
    await d.facts.replaceProjectFacts(key, embedded, sources.length === 1 ? `import:${sources[0]}` : 'import', []);
    r.facts.added += facts.length;
    r.facts.projects.push(key);
  }

  const keys = new Set([...fresh.map((l) => l.projectKey), ...r.facts.projects]);
  await d.activity?.record({
    kind: 'bundle_imported',
    actor: 'you',
    projectKey: b.projectKey ?? (keys.size === 1 ? [...keys][0] : null),
    subject: `imported ${n(r.lessons.added, 'lesson')} (${r.lessons.approved} approved, ${r.lessons.proposed} proposed${r.lessons.revoked ? `, ${r.lessons.revoked} revoked` : ''}) and ${n(r.facts.added, 'fact')} from a bundle exported ${b.exportedAt.slice(0, 10) || 'at an unknown time'}`,
    why: o.keepApproved
      ? 'you imported a bundle and kept its approved lessons approved, so agents are given them now'
      : 'you imported a bundle; live lessons are proposed and reach agents only once you approve them; revoked lessons stay withdrawn',
    details: { ...r, keepApproved: o.keepApproved, toolVersion: b.toolVersion, exportedAt: b.exportedAt, bundleProject: b.projectKey },
    targets: added,
  });
  return r;
}

export function importRoutes(app: Hono, d: ImportDeps) {
  app.post('/api/import', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_IMPORT_BYTES) return c.json({ error: `the bundle is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB` }, 413);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) return c.json({ error: `the bundle is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB` }, 413);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return c.json({ error: 'not a JSON export bundle' }, 400);
    }
    const head = json as { format?: unknown; schemaVersion?: unknown } | null;
    if (head?.format !== EXPORT_FORMAT) return c.json({ error: `not a Feedback Graph export bundle (format must be "${EXPORT_FORMAT}")` }, 400);
    if (head.schemaVersion !== SCHEMA_VERSION) {
      return c.json({ error: `this bundle has schemaVersion ${JSON.stringify(head.schemaVersion)}; this version reads schemaVersion ${SCHEMA_VERSION}. Upgrade to import it.` }, 400);
    }
    const parsed = parseBundle(json);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const keepApproved = ['1', 'true'].includes(c.req.query('keepApproved') ?? '');
    return c.json(await importBundle(parsed.data, { keepApproved }, d));
  });
}
