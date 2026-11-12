import { archiveRedactionInput } from '@fb/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  CLAIM_FACT_RELEVANCE, CLAIM_STATUSES, CLAIM_TYPES, CONFLICT_CHOICES, CONFLICT_DISMISS_REASONS, CONFLICT_KINDS, CONFLICT_SIDE_KINDS, EXPORT_FORMAT, FACT_KINDS,
  INTAKE_EXPORT_MAX, LESSON_CHECKS, MAX_TRIGGERS, claimFingerprint, conflictFingerprint, factEmbeddingText, factFingerprint, lessonFingerprint, triggerShapeProblem, redactDeep,
  type ActivityStore, type ConflictSide, type FactKind, type ImportedClaim, type IntakeRef, type IntakeStore, type Lesson as StoredLesson, type PortabilityStore,
  type EmbeddedFact, type FactsStore, type KnowledgeStore, type LessonInput, type LessonStatus, type StoredFact,
} from '@fb/core';

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
  portability?: Pick<PortabilityStore, 'restorePrivateProject'>;
  /** Knowledge intake (INTAKE_ENABLED): the bundle's claims, settled conflicts and people. Unset: counted, not imported. */
  intake?: {
    store: Pick<IntakeStore, 'importClaims' | 'claim' | 'conflict' | 'openConflict' | 'writeSnapshots' | 'resolveAlias' | 'ensureOwner' | 'updatePerson'>;
    facts: Pick<FactsStore, 'addOwnerFact' | 'fact'>;
    lesson: (id: string) => Promise<StoredLesson | null>;
  };
};

export type ImportResult = {
  lessons: { added: number; approved: number; proposed: number; revoked?: number; existing: number; excluded: number; skipped: number };
  facts: { added: number; projects: string[]; skippedProjects: string[] };
  notImported: { misses: number; docs: number; codeFiles: number };
  /**
   * Knowledge intake: claims added (facts: how many of them became facts agents are given), already there, or left out
   * (an excluded project, intake off); settled conflicts made again where both sides are here; people matched by name or added.
   */
  claims: { added: number; facts: number; existing: number; skipped: number };
  conflicts: { added: number; existing: number; skipped: number };
  people: { added: number; matched: number };
};

/** A full export of a big graph is a few MB; this leaves a lot of room and still bounds memory. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const EMBED_BATCH = 64;

const Key = z.string().min(1).max(200).regex(/^\w[\w.-]*$/, 'a project folder name').refine((k) => !k.includes('..'), 'a project folder name');

/** A lesson's triggers as an owner may write them: each one checked by its shape (triggerShapeProblem). */
export const Triggers = z.object({
  paths: z.array(z.string()).max(MAX_TRIGGERS).default([]),
  patterns: z.array(z.string()).max(MAX_TRIGGERS).default([]),
  symbols: z.array(z.string()).max(MAX_TRIGGERS).default([]),
}).strict().superRefine((t, ctx) => {
  for (const [kind, key] of [['path', 'paths'], ['pattern', 'patterns'], ['symbol', 'symbols']] as const) {
    t[key].forEach((v, i) => {
      const why = triggerShapeProblem(kind, v);
      if (why) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, i], message: `${kind} ${JSON.stringify(v.slice(0, 80))}: ${why}` });
    });
  }
}).transform((t) => ({ paths: t.paths.map((v) => v.trim()), patterns: t.patterns.map((v) => v.trim()), symbols: t.symbols.map((v) => v.trim()) }));

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
  checks: z.array(z.object({ name: z.enum(LESSON_CHECKS), why: z.string().max(4000), of: z.string().max(300).optional(), suggestion: z.string().max(1000).optional() })).max(100).nullable().optional(),
  triggers: Triggers.nullable().optional(),
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
  /** A fact an accepted claim became: imported with its claim (the bundle's claims), never as a plain fact. */
  claim: z.unknown().optional(),
});

const Ref = z.object({ kind: z.enum(CONFLICT_SIDE_KINDS), id: z.string().min(1).max(500) });
const IntakeClaim = z.object({
  id: z.string().min(1).max(500).regex(/^claim:/, 'a claim id'),
  projectKey: Key.nullable(),
  docId: z.string().min(1).max(500),
  type: z.enum(CLAIM_TYPES),
  statement: z.string().min(1).max(4000),
  quote: z.string().max(4000).optional(),
  speakerId: z.string().max(500).nullable().default(null),
  speaker: z.string().max(200).nullable().default(null),
  assertedAt: z.string().max(50).nullable().default(null),
  confidence: z.number().min(0).max(1).default(1),
  scope: z.object({ area: z.string().max(200).nullable(), files: z.array(z.string().max(300)).max(20) }).default({ area: null, files: [] }),
  about: z.string().max(300).default(''),
  due: z.string().max(100).nullable().default(null),
  status: z.enum(CLAIM_STATUSES),
  decidedAt: z.string().max(50).nullable().default(null),
});
const IntakeConflict = z.object({
  id: z.string().min(1).max(500), kind: z.enum(CONFLICT_KINDS), status: z.enum(['resolved', 'dismissed']), projectKey: Key.nullable(), a: Ref, b: Ref,
  resolution: z.object({ choice: z.enum(CONFLICT_CHOICES), note: z.string().max(2000).nullable(), reason: z.enum(CONFLICT_DISMISS_REASONS).nullable() }),
  resolvedAt: z.string().max(50).nullable().default(null),
});
const IntakePerson = z.object({ id: z.string().min(1).max(500), displayName: z.string().min(1).max(200), isOwner: z.boolean().default(false) });

const Bundle = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.literal(SCHEMA_VERSION),
  toolVersion: z.string().max(50).default('unknown'),
  exportedAt: z.string().max(50).default(''),
  projectKey: Key.nullable().default(null),
  projects: z.array(z.object({ key: Key, remote: z.string().max(2000).nullable(), demoCreated: z.literal(true).optional() })).max(2000).default([]),
  lessons: z.array(Lesson).max(20_000).default([]),
  facts: z.array(Fact).max(200_000).default([]),
  misses: z.array(z.unknown()).default([]),
  docs: z.array(z.unknown()).default([]),
  codeFiles: z.array(z.unknown()).default([]),
  claims: z.array(IntakeClaim).max(INTAKE_EXPORT_MAX).default([]),
  conflicts: z.array(IntakeConflict).max(INTAKE_EXPORT_MAX).default([]),
  people: z.array(IntakePerson).max(INTAKE_EXPORT_MAX).default([]),
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
  const privates = b.projects.filter((p) => p.demoCreated && !never.has(p.key));
  const restore = d.portability?.restorePrivateProject?.bind(d.portability);
  if (privates.length && !restore) throw new Error('this importer cannot preserve private-project provenance; upgrade before importing the bundle');
  await archiveRedactionInput('import', raw.projectKey ?? 'bundle', raw, b);
  const r: ImportResult = {
    lessons: { added: 0, approved: 0, proposed: 0, existing: 0, excluded: 0, skipped: 0 },
    facts: { added: 0, projects: [], skippedProjects: [] },
    notImported: { misses: b.misses.length, docs: b.docs.length, codeFiles: b.codeFiles.length },
    claims: { added: 0, facts: 0, existing: 0, skipped: 0 },
    conflicts: { added: 0, existing: 0, skipped: 0 },
    people: { added: 0, matched: 0 },
  };

  for (const project of privates) await restore!({ key: project.key, remote: project.remote });

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
      ...(l.triggers != null && { triggers: l.triggers }),
    };
    await d.knowledge.upsertLesson(input);
    added.push(l.id);
    if (l.next === 'revoked') r.lessons.revoked = (r.lessons.revoked ?? 0) + 1;
    else r.lessons[l.next === 'approved' ? 'approved' : 'proposed']++;
  }
  r.lessons.added = added.length;

  const byProject = new Map<string, z.infer<typeof Fact>[]>();
  for (const f of b.facts) if (!never.has(f.projectKey) && f.claim === undefined) byProject.set(f.projectKey, [...(byProject.get(f.projectKey) ?? []), f]);
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

  const claimIds = d.intake ? await importIntake(b, never, d.intake, d.embed, r) : [];
  if (!d.intake) r.claims.skipped = b.claims.length;
  if (!d.intake) r.conflicts.skipped = b.conflicts.length;

  const keys = new Set([...fresh.map((l) => l.projectKey), ...r.facts.projects]);
  await d.activity?.record({
    kind: 'bundle_imported',
    actor: 'you',
    projectKey: b.projectKey ?? (keys.size === 1 ? [...keys][0] : null),
    subject: `imported ${n(r.lessons.added, 'lesson')} (${r.lessons.approved} approved, ${r.lessons.proposed} proposed${r.lessons.revoked ? `, ${r.lessons.revoked} revoked` : ''}) and ${n(r.facts.added, 'fact')}${r.claims.added ? `, ${n(r.claims.added, 'claim')}` : ''}${r.conflicts.added ? `, ${n(r.conflicts.added, 'settled conflict')}` : ''} from a bundle exported ${b.exportedAt.slice(0, 10) || 'at an unknown time'}`,
    why: o.keepApproved
      ? 'you imported a bundle and kept its approved lessons approved, so agents are given them now'
      : 'you imported a bundle; live lessons are proposed and reach agents only once approved; revoked lessons stay withdrawn',
    details: { ...r, keepApproved: o.keepApproved, toolVersion: b.toolVersion, exportedAt: b.exportedAt, bundleProject: b.projectKey },
    targets: [...added, ...claimIds],
  });
  return r;
}

/** The fact kind an accepted claim files as, as the review route files it (a plain fact as a convention). */
const KIND_OF: Record<string, FactKind> = { fact: 'convention', decision: 'decision', plan: 'plan', commitment: 'commitment' };

/**
 * The bundle's knowledge intake, idempotently and with its statuses: its people matched by name (or added, confirmed;
 * the bundle's owner is yours), its claims added under their ids as they were decided (an accepted one that is not an
 * opinion files its fact, as accepting it here would), and its settled conflicts made again, settled as they were,
 * where both sides are here. A claim or conflict already here is left as it is. Returns the claim ids added.
 */
async function importIntake(b: ImportBundle, never: Set<string>, x: NonNullable<ImportDeps['intake']>, embed: ImportDeps['embed'], r: ImportResult): Promise<string[]> {
  const people = new Map<string, string>();
  for (const p of b.people) {
    if (p.isOwner) {
      people.set(p.id, (await x.store.ensureOwner(p.displayName)).id);
      r.people.matched++;
      continue;
    }
    const found = await x.store.resolveAlias(p.displayName, { create: true });
    if (!found) continue;
    if (found.created) await x.store.updatePerson(found.person.id, { status: 'confirmed' });
    people.set(p.id, found.person.id);
    r.people[found.created ? 'added' : 'matched']++;
  }
  const fresh: ImportBundle['claims'] = [];
  const seen = new Set<string>();
  for (const c of b.claims) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if ((c.projectKey && never.has(c.projectKey)) || c.status === 'proposed' || c.status === 'rejected') r.claims.skipped++;
    else if (await x.store.claim(c.id)) r.claims.existing++;
    else fresh.push(c);
  }
  const path = (c: ImportBundle['claims'][number]) => c.scope.files[0] ?? `source:${c.docId}`;
  const makesFact = (c: ImportBundle['claims'][number]) => c.status === 'accepted' && c.type !== 'opinion' && c.projectKey !== null;
  const vectors = await embedAll(fresh.map((c) => c.statement), embed);
  const withFact = fresh.filter(makesFact);
  const factVectors = await embedAll(withFact.map((c) => factEmbeddingText({ path: path(c), statement: c.statement, origin: 'claim' })), embed);
  const claims: ImportedClaim[] = [];
  for (const [i, c] of fresh.entries()) {
    let factId: string | null = null;
    if (makesFact(c)) {
      const when = (c.assertedAt ?? c.decidedAt ?? '').slice(0, 10);
      const fact = await x.facts.addOwnerFact(c.projectKey!, {
        kind: KIND_OF[c.type], statement: c.statement, path: path(c), lines: null, confidence: 1, why: `${c.speaker ?? 'someone'}${when ? `, ${when}` : ''} (imported)`,
        relevance: CLAIM_FACT_RELEVANCE, embedding: factVectors[withFact.indexOf(c)],
      }, 'you', null, { origin: 'claim' });
      factId = fact.id;
      r.claims.facts++;
    }
    claims.push({
      id: c.id, projectKey: c.projectKey, docId: c.docId, type: c.type, statement: c.statement, quote: c.quote ?? c.statement,
      speakerId: c.speakerId ? people.get(c.speakerId) ?? null : null, assertedAt: c.assertedAt, confidence: c.confidence, scope: c.scope, about: c.about,
      due: c.due, status: c.status, decidedAt: c.decidedAt, factId, embedding: vectors[i], decidedBy: 'import',
    });
  }
  const added = await x.store.importClaims(claims);
  r.claims.added = added.length;
  r.claims.existing += claims.length - added.length;

  // A side's fingerprint as it is here: a conflict whose sides are not both here is left out (detection finds it again).
  const sideOf = async (ref: IntakeRef): Promise<ConflictSide | null> => {
    if (ref.kind === 'claim') {
      const c = await x.store.claim(ref.id);
      return c && { ...ref, fingerprint: claimFingerprint(c), assertedAt: c.assertedAt };
    }
    if (ref.kind === 'fact') {
      const f: (StoredFact & { current: boolean }) | null = await x.facts.fact(ref.id);
      return f && { ...ref, fingerprint: factFingerprint(f), assertedAt: f.createdAt };
    }
    const l = await x.lesson(ref.id);
    return l && { ...ref, fingerprint: lessonFingerprint(l), assertedAt: l.decidedAt ?? l.createdAt };
  };
  for (const k of b.conflicts) {
    if ((k.projectKey && never.has(k.projectKey)) || (k.resolution.choice === 'none' && !k.resolution.reason) || (k.resolution.choice === 'both' && !k.resolution.note)) { r.conflicts.skipped++; continue; }
    if (await x.store.conflict(k.id)) { r.conflicts.existing++; continue; }
    const [a, bSide] = await Promise.all([sideOf(k.a), sideOf(k.b)]);
    if (!a || !bSide) { r.conflicts.skipped++; continue; }
    const { conflict, created } = await x.store.openConflict({ kind: k.kind, projectKey: k.projectKey, a, b: bSide, signals: [], judge: null });
    if (!created || conflict.status !== 'open') { r.conflicts.existing++; continue; }
    const winner = k.resolution.choice === 'a' ? a : k.resolution.choice === 'b' ? bSide : null;
    const loser = k.resolution.choice === 'a' ? bSide : k.resolution.choice === 'b' ? a : null;
    await x.store.writeSnapshots([{
      kind: 'conflict', id: conflict.id, expect: conflictFingerprint(conflict),
      fields: { status: k.status, resolution: { ...k.resolution, createdFactId: null }, resolvedBy: 'import', resolvedAt: k.resolvedAt, decisionId: null },
    }], winner && loser ? { supersede: [{ from: { kind: loser.kind, id: loser.id }, to: { kind: winner.kind, id: winner.id }, conflictId: conflict.id }] } : {});
    r.conflicts.added++;
  }
  return added;
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
