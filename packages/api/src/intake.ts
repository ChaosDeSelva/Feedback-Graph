import {
  archiveRedactionInput, authorizeStoreWrite, chunkSourceText, docIdOf, embeddingInput, INTAKE_FORMATS, INTAKE_KINDS, intakeFormat,
  normalizeSourceText, NotTheRunsError, parseIntake, redactIntakeText, redactSecrets, sourceRemovalDecision, TargetChangedError,
  type ActivityStore, type Decision, type DecisionExecStore, type DecisionExecutor, type DocsStore, type DocSummary, type IntakeMeta, type IntakeStore, type Project, type ShownProjects,
} from '@fb/core';
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { currentActor, currentRun, mayChangeAny } from './operator.ts';
import { askingRun } from './runs.ts';

/**
 * Knowledge intake (INTAKE_ENABLED): a source is what people said (a call transcript, notes), stored as a Doc with
 * source 'intake' plus its details (IntakeStore.upsertMeta) and read by the worker into claims for the owner to review.
 * Its text is redacted (credentials, contact details) before anything is stored, and never reaches an agent: these
 * routes are owner-only, reads included (OWNER_ROUTES), and the doc searches agents get leave intake out
 * (AGENT_HIDDEN_DOC_SOURCES).
 */
export type IntakeRouteDeps = {
  store: Pick<IntakeStore, 'upsertMeta' | 'metas' | 'removeSource' | 'resolveAlias' | 'listClaims'>;
  /** INTAKE_ARCHIVE: the original text goes to the encrypted redaction archive, as uploads do (default). False: kept nowhere. */
  archive: boolean;
  /** Removing a source with everything from it (keep=none): its claims' facts closed as a remove_source decision. */
  decide: { store: DecisionExecStore; exec: Pick<DecisionExecutor, 'apply'> };
};

type Deps = IntakeRouteDeps & {
  docs: Pick<DocsStore, 'upsertDoc' | 'listDocs' | 'deleteDoc'> & Partial<Pick<DocsStore, 'requeueDocRead'>>;
  docText: DocsStore['docText'];
  embed: (texts: string[]) => Promise<number[][]>;
  projectDirs: () => Promise<Project[]>;
  activity?: Pick<ActivityStore, 'record'>;
  view: () => Promise<ShownProjects | null>;
  log?: (msg: string, extra?: object) => void;
};

/** Chunks per embedding call; a source of more is answered 202 and embedded in the background (as a document upload). */
const EMBED_BATCH = 64;
/** How long a failed background embedding is said on the source. */
const FAILED_KEPT_MS = 60 * 60_000;
const MAX_TEXT = 2_000_000;
const MAX_PEOPLE = 100;
const SOURCES_PAGE = 100;

/** A meeting date (2026-11-10) or a time (2026-11-10T09:30:00Z), as given. */
const OccurredAt = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/, 'a date (YYYY-MM-DD) or an ISO time')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'a real date');

const IntakeUpload = z.object({
  projectKey: z.string().min(1).max(200),
  kind: z.enum(INTAKE_KINDS).optional(),
  /** Unset: read from the text (a caption file by its content), then from `name`. */
  format: z.enum(INTAKE_FORMATS).optional(),
  title: z.string().min(1).max(300),
  /** The file it came from: names the source, so sending the same file again replaces it. A paste is named by its text. */
  name: z.string().min(1).max(200).regex(/^[\w][\w .()-]*$/, 'a plain file name').optional(),
  text: z.string().min(1).max(MAX_TEXT),
  occurredAt: OccurredAt.nullable().optional(),
  participants: z.array(z.string().min(1).max(200)).max(MAX_PEOPLE).optional(),
  origin: z.string().min(1).max(500).nullable().optional(),
  /** Never synced, even with SYNC_CLAIMS. Default: true for a transcript, false otherwise. */
  private: z.boolean().optional(),
}).strict();

const SourcesQuery = z.object({
  project: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * facts (default): the text, chunks, details, unaccepted claims and all questions go; accepted claims and the facts
 * made from them stay. none: everything from it, its facts too.
 */
const DeleteQuery = z.object({ keep: z.enum(['facts', 'none']).optional() });

export const intakeSchemas = { IntakeUpload, SourcesQuery, DeleteQuery };

/** A source as listed: the document, its details (null while it is being stored), and a background embedding's state. */
export type IntakeSource = DocSummary & { intake: IntakeMeta | null };

/** doc[@<run>]:<project>:intake:<ref>; null for any other id. */
function sourceIdParts(id: string): { projectKey: string; ref: string } | null {
  const parts = id.split(':');
  return parts.length >= 4 && parts[2] === 'intake' && parts[1] ? { projectKey: parts[1], ref: parts.slice(3).join(':') } : null;
}

/** A name as a person is matched by: one that redaction changes (an e-mail address, a phone number) is no name. */
const personName = (s: string) => {
  const name = s.trim();
  return name && redactIntakeText(name) === name ? name : null;
};

/** A source ready to store: redacted, parsed and chunked, with its id and who was there (prepareIntakeSource). */
export type PreparedSource = {
  project: Project; id: string; ref: string; title: string; original: string; text: string; format: IntakeMeta['format']; kind: IntakeMeta['kind'];
  utterances: ReturnType<typeof parseIntake>; chunks: string[]; names: string[]; occurredAt: string | null; origin: string | null; private: boolean;
};
export type IntakeSourceInput = z.infer<typeof IntakeUpload>;

/**
 * A source as it will be stored: credentials and contact details redacted before anything is stored or parsed (the
 * worker reads back exactly this), its format, utterances and chunks, its id in the asking run, and the people named
 * (the participants, then each speaker label). An error when nothing is said in it.
 */
export function prepareIntakeSource(project: Project, b: IntakeSourceInput): PreparedSource | { error: string } {
  const original = normalizeSourceText(b.text);
  const text = redactIntakeText(original).trim();
  const format = b.format ?? intakeFormat(b.name ?? null, text);
  const utterances = parseIntake(text, format);
  if (!text || !utterances.length) return { error: 'the source has nothing said in it' };
  const kind = b.kind ?? 'transcript';
  const ref = redactSecrets(b.name ?? `paste-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`);
  const names = [...new Set([...(b.participants ?? []), ...utterances.flatMap((u) => (u.speaker ? [u.speaker] : []))].flatMap((n) => personName(n) ?? []))].slice(0, MAX_PEOPLE);
  return {
    project, id: docIdOf({ projectKey: project.key, source: 'intake', ref }, currentRun()), ref, title: redactIntakeText(b.title), original, text, format, kind,
    utterances, chunks: chunkSourceText(text), names, occurredAt: b.occurredAt ?? null, origin: b.origin ?? null, private: b.private ?? kind === 'transcript',
  };
}

/** What storing a source writes to. */
export type IntakeSourceWriter = Pick<Deps, 'store' | 'archive' | 'docs' | 'embed' | 'activity'>;

/**
 * Store a prepared source: the original to the redaction archive (unless INTAKE_ARCHIVE=off), its chunks embedded and
 * stored as an intake Doc queued to be read, its people resolved (a new name is a proposed person), its details, and a
 * source_added Activity entry by `by.actor`. Returns the Doc id.
 */
export async function storeIntakeSource(d: IntakeSourceWriter, p: PreparedSource, by: { actor: string; why: string }): Promise<string> {
  const { project, id, ref, title, text, chunks, kind, format, utterances } = p;
  await authorizeStoreWrite();
  if (d.archive) {
    await archiveRedactionInput('intake', id, p.original, text, [
      { kind: 'project', id: project.key }, { kind: 'doc', id }, ...(currentRun() ? [{ kind: 'run' as const, id: currentRun()!.id }] : []),
    ]);
  }
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) vectors.push(...(await d.embed(chunks.slice(i, i + EMBED_BATCH).map((t) => embeddingInput(t)))));
  const previous = (await d.docs.listDocs(project.key, { source: 'intake', ref, limit: 2, run: askingRun() })).find((x) => x.id === id);
  const run = currentRun();
  const stored = await d.docs.upsertDoc(
    { projectKey: project.key, source: 'intake', ref, title, url: null },
    chunks.map((t, i) => ({ text: t, embedding: vectors[i] })),
    { read: true, addedBy: currentActor(), ...(run ? { run, ...(mayChangeAny() && { byOwner: true }) } : {}) },
  );
  const people: string[] = [];
  for (const name of p.names) {
    const r = await d.store.resolveAlias(name, { create: true });
    if (r && !people.includes(r.person.id)) people.push(r.person.id);
  }
  await d.store.upsertMeta({ docId: stored, kind, format, occurredAt: p.occurredAt, origin: p.origin, private: p.private, participants: people });
  await d.activity?.record({
    kind: 'source_added', actor: by.actor, projectKey: project.key,
    subject: `${previous ? `replaced "${previous.title}" with` : 'added'} the ${kind} "${title}" (${utterances.length} utterance${utterances.length === 1 ? '' : 's'})`,
    why: by.why, details: { format, chars: text.length, utterances: utterances.length, participants: people.length, private: p.private, ...(p.origin && { origin: p.origin }) }, targets: [stored],
  });
  return stored;
}

export function intakeRoutes(app: Hono, d: Deps) {
  const shows = async (key: string) => {
    const v = await d.view();
    return !v || v.has(key);
  };

  /** Large sources being embedded in the background, and those that failed (kept FAILED_KEPT_MS), by doc id. */
  type Pending = { status: 'pending' | 'failed'; error?: string; chunks: number; at: number; source: IntakeSource; run: string | null };
  const pending = new Map<string, Pending>();
  const pendingOf = (id: string) => {
    const p = pending.get(id);
    if (p?.status === 'failed' && Date.now() - p.at > FAILED_KEPT_MS) pending.delete(id);
    const kept = pending.get(id);
    return kept && kept.run === askingRun() ? kept : undefined;
  };
  const withEmbed = (s: IntakeSource): IntakeSource & { embed?: object } => {
    const p = pendingOf(s.id);
    return p ? { ...s, embed: { status: p.status, ...(p.error && { error: p.error }), chunks: p.chunks } } : s;
  };

  app.post('/api/intake', async (c) => {
    const body = IntakeUpload.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const b = body.data;
    const project = (await d.projectDirs()).find((p) => p.key === b.projectKey);
    if (!project || !(await shows(project.key))) return c.json({ error: 'no such project' }, 404);
    const prepared = prepareIntakeSource(project, b);
    if ('error' in prepared) return c.json({ error: prepared.error }, 400);
    const { id, chunks, format, utterances, title } = prepared;
    const add = () => storeIntakeSource(d, prepared, { actor: 'you', why: 'you added it to be read into claims for your review; its text is never served to agents' });

    const answer = { id, chunks: chunks.length, format, utterances: utterances.length };
    if (chunks.length > EMBED_BATCH) {
      const source: IntakeSource = {
        id, projectKey: project.key, source: 'intake', ref: prepared.ref, title, url: null, addedAt: new Date().toISOString(), addedBy: currentActor(),
        chunks: 0, kind: 'text', mediaType: null, read: null, intake: null,
      };
      const started: Pending = { status: 'pending', chunks: chunks.length, at: Date.now(), source, run: askingRun() };
      pending.set(id, started);
      void add().then(() => {
        if (pending.get(id) === started) pending.delete(id);
      }, async (err) => {
        const reason = err instanceof NotTheRunsError ? err.message : redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
        if (pending.get(id) === started) pending.set(id, { ...started, status: 'failed', error: reason, at: Date.now() });
        d.log?.('intake failed', { project: project.key, error: reason });
        await d.activity?.record({
          kind: 'source_added', actor: 'you', projectKey: project.key, subject: `could not add "${title}": ${reason}`,
          why: 'the source was accepted, but embedding or storing its text failed; send it again', details: { failed: true }, targets: [id],
        }).catch(() => {});
      });
      return c.json({ ...answer, pending: true }, 202);
    }
    try {
      return c.json({ ...answer, id: await add() }, 201);
    } catch (err) {
      if (err instanceof NotTheRunsError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  /** The project's sources (newest first) with their details, those being stored in the background first. */
  const sourcesOf = async (key: string, limit: number): Promise<IntakeSource[]> => {
    const docs = await d.docs.listDocs(key, { source: 'intake', limit, run: askingRun() });
    const metas = new Map((await d.store.metas(docs.map((x) => x.id))).map((m) => [m.docId, m]));
    const stored = new Set(docs.map((x) => x.id));
    const waiting = [...pending.keys()].flatMap((id) => {
      const p = pendingOf(id);
      return p && p.source.projectKey === key && !stored.has(id) ? [p.source] : [];
    });
    return [...waiting, ...docs.map((x) => ({ ...x, intake: metas.get(x.id) ?? null }))];
  };

  app.get('/api/intake/sources', async (c) => {
    const q = SourcesQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const limit = q.data.limit ?? SOURCES_PAGE;
    const v = await d.view();
    const keys = q.data.project ? (await shows(q.data.project) ? [q.data.project] : []) : v ? v.keys : (await d.projectDirs()).map((p) => p.key);
    const all = (await Promise.all(keys.map((k) => sourcesOf(k, limit)))).flat();
    all.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
    return c.json(all.slice(0, limit).map(withEmbed));
  });

  /** A shown source by id: stored (with its details), or being stored; null for anything else. */
  const find = async (id: string): Promise<IntakeSource | null> => {
    const parts = sourceIdParts(id);
    if (!parts || !(await shows(parts.projectKey))) return null;
    const doc = (await d.docs.listDocs(parts.projectKey, { source: 'intake', ref: parts.ref, limit: 5, run: askingRun() })).find((x) => x.id === id);
    if (!doc) return pendingOf(id)?.source ?? null;
    const [meta] = await d.store.metas([id]);
    return { ...doc, intake: meta ?? null };
  };

  // The text as the worker reads it, its utterances, and where each claim drawn from it is.
  app.get('/api/intake/sources/:id', async (c) => {
    const id = c.req.param('id');
    const s = await find(id);
    if (!s) return c.json({ error: 'not found' }, 404);
    const text = s.chunks ? await d.docText(id) : null;
    const claims = text === null ? [] : await d.store.listClaims({ docId: id, run: askingRun(), limit: 1000 });
    return c.json({
      ...withEmbed(s),
      text,
      utterances: text === null || !s.intake ? [] : parseIntake(text, s.intake.format),
      claims: claims.map((x) => ({ id: x.id, type: x.type, status: x.status, span: x.span })),
    });
  });

  const requeue = d.docs.requeueDocRead?.bind(d.docs);
  if (requeue) {
    app.post('/api/intake/sources/:id/reread', async (c) => {
      const id = c.req.param('id');
      const s = await find(id);
      if (!s || !(await requeue(id))) return c.json({ error: 'not found, or not waiting to be read again' }, 404);
      await d.activity?.record({
        kind: 'source_read', actor: 'you', projectKey: s.projectKey,
        subject: `asked for "${s.title}" to be read again`, why: 'its reading failed; the worker reads it again on its next cycle', details: {}, targets: [id],
      });
      return c.body(null, 204);
    });
  }

  app.delete('/api/intake/sources/:id', async (c) => {
    const q = DeleteQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const keep = q.data.keep ?? 'facts';
    const id = c.req.param('id');
    const s = await find(id);
    if (!s) return c.json({ error: 'not found' }, 404);
    let decision: Decision | null = null;
    if (keep === 'none') {
      // The facts the claims you accepted from it became are closed as one decision by you, before anything is deleted,
      // so a refusal changes nothing and a rollback re-opens them (the source and its claims stay gone).
      const kept = (await d.store.listClaims({ docId: id, status: ['accepted'], run: askingRun(), limit: 1000 })).filter((x) => x.factId);
      if (kept.length) {
        if (!mayChangeAny()) return c.json({ error: 'a labelled run removes a source with keep=facts: closing facts is your decision' }, 409);
        try {
          const input = await sourceRemovalDecision(d.decide.store, { docId: id, projectKey: s.projectKey, title: s.title }, kept, { by: currentActor() });
          const { decision: proposed } = await d.decide.store.decisions.propose(input);
          decision = await d.decide.exec.apply(proposed, { by: currentActor() });
        } catch (e) {
          if (e instanceof TargetChangedError) return c.json({ error: `${e.targetId} changed meanwhile, so nothing was removed: reload and try again` }, 409);
          throw e;
        }
      }
    }
    // The document first: in a run, only one the run added (runOnly), so nothing else is touched when it is refused.
    if (!(await d.docs.deleteDoc(id, mayChangeAny() ? {} : { run: currentRun()!.id }))) {
      return c.json({ error: currentRun() ? 'not found among the sources this run added' : 'not found' }, 404);
    }
    // Its participants are read before the document goes, since their attendance goes with it.
    const removed = await d.store.removeSource(id, keep === 'none' ? { everything: true, people: s.intake?.participants ?? [] } : {});
    await d.activity?.record({
      kind: 'doc_removed', actor: 'you', projectKey: s.projectKey,
      subject: `removed the source "${s.title}" (${removed.claim} ${keep === 'none' ? '' : 'unaccepted '}claim${removed.claim === 1 ? '' : 's'}, ${removed.question} question${removed.question === 1 ? '' : 's'}${removed.people ? `, ${removed.people} ${removed.people === 1 ? 'person' : 'people'} only it named` : ''})`,
      why: keep === 'facts' ? 'you removed it; claims you accepted stay, as the facts they became' : 'you removed it and everything drawn from it',
      details: { keep, ...removed, ...(decision && { decisionId: decision.id, factsClosed: decision.targets.length }) },
      targets: [id, ...(decision ? [decision.id] : [])],
    });
    return c.json({ removed: { ...removed, keep, facts: decision ? decision.targets.length : 0 }, decision });
  });
}
