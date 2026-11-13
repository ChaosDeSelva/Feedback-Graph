import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { pageByScore, SortQuery, type Scorer } from './scores.ts';
import {
  AliasTakenError, CLAIM_FACT_RELEVANCE, CLAIM_STATUSES, CLAIM_TYPES, claimFingerprint, FACT_KINDS, factEmbeddingText, NotTheRunsError, PERSON_STATUSES, QUESTION_KINDS, QUESTION_STATUSES,
  TargetChangedError,
  type ActivityStore, type Claim, type ClaimPatch, type ClaimScope, type ClaimType, type Conflict, type FactKind, type FactsStore, type IntakeMeta,
  type IntakeRef, type IntakeStore, type Person, type Question, type RelevanceBy, type ShownProjects, type StoredFact,
} from '@fb/core';
import { currentActor, currentRun, mayChange } from './operator.ts';
import { runAsked } from './runs.ts';
import { conflictRoutes, type ConflictDeps } from './conflicts.ts';

/**
 * Knowledge intake's review routes (0.9.0 §3, §8): the claims drawn from what people said, the questions they left
 * open and the people who said them. Every write is an owner route (OWNER_ROUTES: claims_decide, off by default for the
 * operator token). Accepting a claim that is not an opinion files it as a project fact (origin `claim`), the one way
 * what someone said reaches agents; an opinion stays an attributed claim agents are never given until you re-type it.
 * Reads are the owner's too: claims carry quotes from transcripts, so the agent credential (API_TOKEN) is refused.
 */

export type IntakeReviewDeps = {
  intake: Pick<IntakeStore,
    'listClaims' | 'claim' | 'decideClaim' | 'deleteClaims' | 'metas' | 'conflictsFor' | 'people' | 'person' | 'ensureOwner' | 'updatePerson' | 'mergePeople'
    | 'forgetPerson' | 'listQuestions' | 'question' | 'updateQuestion' | 'answerQuestion'>;
  facts: Pick<FactsStore, 'addOwnerFact'>;
  embed: (texts: string[]) => Promise<number[][]>;
  activity: Pick<ActivityStore, 'record'>;
  /** The owner's Person's name the first time an answer needs it (IntakeStore.ensureOwner). */
  ownerName?: string;
  /** The Conflicts routes (conflicts.ts): resolving one is a decision the executor applies. Unset: none. */
  conflicts?: Omit<ConflictDeps, 'activity'>;
};

/** createApp's part: which projects are shown (null: all), and whether the request carries the agent credential. */
export type IntakeReviewContext = { view: () => Promise<Pick<ShownProjects, 'has' | 'keys'> | null>; agentCaller: (c: Context) => boolean; scores: Scorer };

const PAGE = 100;
const MAX_PAGE = 500;
const OWNER_NAME = 'You';

const Id = z.string().min(1).max(500);
const ProjectKey = z.string().min(1).max(200);
const Page = { limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(), offset: z.coerce.number().int().min(0).optional() };
const ClaimsQuery = z.object({
  status: z.enum(CLAIM_STATUSES).optional(), type: z.enum(CLAIM_TYPES).optional(), project: ProjectKey.optional(),
  /** A Person id: what they said. */ person: Id.optional(),
  /** A source (its Doc id). */ source: Id.optional(),
  ...Page, ...SortQuery,
});
const Scope = z.object({ area: z.string().max(200).nullable(), files: z.array(z.string().min(1).max(300)).max(20) }).strict();
/** How accepting files the fact: its kind (a plain fact's; default convention), relevance, and the project a global claim's fact goes under. */
const FactOptions = { kind: z.enum(FACT_KINDS).optional(), relevance: z.number().min(0).max(1).optional(), projectKey: ProjectKey.optional() };
const ClaimPatchBody = z.object({
  status: z.enum(['proposed', 'accepted', 'rejected']).optional(),
  statement: z.string().trim().min(1).max(2000).optional(),
  type: z.enum(CLAIM_TYPES).optional(),
  scope: Scope.optional(),
  about: z.string().trim().min(1).max(300).optional(),
  /** false: keep it as an opinion (re-typed to opinion, never served); true: it must not be an opinion. */
  asFact: z.boolean().optional(),
  /** claimFingerprint of the claim as the page showed it: a claim changed since is not decided over (409). */
  expect: z.string().min(1).max(200).optional(),
  ...FactOptions,
}).strict();
const ClaimDecisions = z.object({
  items: z.array(z.object({ id: Id, status: z.enum(['accepted', 'rejected']) }).strict()).min(1).max(MAX_PAGE).optional(),
  /** Every proposed claim of one source (its Doc id), with `status`. */
  source: Id.optional(),
  status: z.enum(['accepted', 'rejected']).optional(),
}).strict().refine((b) => (b.items === undefined) !== (b.source === undefined), 'send either items or source')
  .refine((b) => b.source === undefined || b.status !== undefined, 'a source needs a status');

const QuestionsQuery = z.object({
  status: z.enum(QUESTION_STATUSES).optional(), kind: z.enum(QUESTION_KINDS).optional(), project: ProjectKey.optional(),
  source: Id.optional(), assignee: Id.optional(), ...Page, ...SortQuery,
});
const QuestionPatchBody = z.object({ assignee: Id.nullable().optional(), status: z.enum(['open', 'dismissed']).optional() }).strict()
  .refine((b) => b.assignee !== undefined || b.status !== undefined, 'send an assignee or a status');
const AnswerBody = z.object({ text: z.string().trim().min(1).max(4000), type: z.enum(CLAIM_TYPES).default('fact'), ...FactOptions }).strict();

const PeopleQuery = z.object({ status: z.enum(PERSON_STATUSES).optional() });
const Alias = z.string().trim().min(1).max(200);
const PersonPatchBody = z.object({
  displayName: z.string().trim().min(1).max(200).optional(), status: z.enum(['proposed', 'confirmed']).optional(),
  addAliases: z.array(Alias).max(50).optional(), removeAliases: z.array(Alias).max(50).optional(),
}).strict();
const MergeBody = z.object({ keepId: Id, mergedId: Id }).strict();
/** Forgetting cannot be undone: the person's id, sent again. */
const ForgetBody = z.object({ confirm: Id }).strict();

/** For the OpenAPI document (openapi.ts). */
export const intakeReviewSchemas = { ClaimsQuery, ClaimPatchBody, ClaimDecisions, QuestionsQuery, QuestionPatchBody, AnswerBody, PeopleQuery, PersonPatchBody, MergeBody, ForgetBody };

/** A claim as listed: with the open conflicts naming it (the other side of each). */
export type ListedClaim = Claim & { conflicts: { id: string; with: IntakeRef }[] };

/** A refusal with its status, thrown by the shared decision paths and answered as { error }. */
class Refusal extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) { super(message); this.status = status; }
}

const SOURCE_WORD: Record<IntakeMeta['kind'], string> = { transcript: 'call', notes: 'notes', doc: 'doc' };
/** The fact kind a claim's type files as: a plain fact the kind chosen (default convention), the rest their own. */
const factKindOf = (type: Exclude<ClaimType, 'opinion'>, chosen: FactKind | undefined): FactKind => chosen ?? (type === 'fact' ? 'convention' : type);
/** Where a claim's fact is filed: its first scoped file, else its source. */
const factPathOf = (c: Pick<Claim, 'scope' | 'docId'>) => c.scope.files[0] ?? `source:${c.docId}`;

export function intakeReviewRoutes(app: Hono, d: IntakeReviewDeps, ctx: IntakeReviewContext) {
  const { intake } = d;
  const refused = (c: Context, e: unknown) => {
    if (e instanceof Refusal) return c.json({ error: e.message }, e.status);
    if (e instanceof TargetChangedError) return c.json({ error: `${e.targetId} changed since you opened it: reload it and decide again` }, 409);
    if (e instanceof AliasTakenError) return c.json({ error: e.message, personId: e.personId }, 409);
    throw e;
  };
  const visible = async (key: string | null) => {
    const v = await ctx.view();
    return key === null || !v || v.has(key);
  };
  /** A record a sandbox run made is that run's alone: lists scope by run, and a read by id must too. */
  const runSees = (r: { run: string | null; sandbox: boolean }) => !r.sandbox || (!!r.run && r.run === currentRun()?.id);
  const keysFor = async (project?: string): Promise<string[] | undefined> => {
    const v = await ctx.view();
    if (!v) return project ? [project] : undefined;
    return project ? (v.has(project) ? [project] : []) : v.keys;
  };
  const shownClaim = async (id: string) => {
    const claim = await intake.claim(id);
    return claim && runSees(claim) && (await visible(claim.projectKey)) ? claim : null;
  };
  const shownQuestion = async (id: string) => {
    const q = await intake.question(id);
    return q && runSees(q) && (await visible(q.projectKey)) ? q : null;
  };
  const withConflicts = async (claims: Claim[]): Promise<ListedClaim[]> => {
    const open = claims.length ? await intake.conflictsFor(claims.map((x) => x.id)) : [];
    const sides = (id: string) => open.flatMap((k: Conflict) => (k.a.id === id ? [{ id: k.id, with: { kind: k.b.kind, id: k.b.id } }] : k.b.id === id ? [{ id: k.id, with: { kind: k.a.kind, id: k.a.id } }] : []));
    return claims.map((x) => ({ ...x, conflicts: sides(x.id) }));
  };
  const person = async (id: string | null) => (id ? intake.person(id) : null);
  if (d.conflicts) conflictRoutes(app, { ...d.conflicts, activity: d.activity }, ctx);

  // Transcript quotes and the names of who said them are the owner's: an agent reads only what was accepted, through
  // the facts agents are given (0.9.0 principles).
  app.use('/api/claims/*', ownerReads);
  app.use('/api/claims', ownerReads);
  app.use('/api/questions/*', ownerReads);
  app.use('/api/questions', ownerReads);
  app.use('/api/people/*', ownerReads);
  app.use('/api/people', ownerReads);
  async function ownerReads(c: Context, next: () => Promise<void>) {
    if (ctx.agentCaller(c)) return c.json({ error: 'claims, questions and people are the owner\'s to read: agents get only accepted knowledge, as facts (use the browser, FG_OWNER_TOKEN or FG_OPERATOR_TOKEN)' }, 403);
    await next();
  }

  // ── Claims ──────────────────────────────────────────────────────────────

  app.get('/api/claims', async (c) => {
    const q = ClaimsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const projectKeys = await keysFor(q.data.project);
    // A project not shown has nothing to list (the store would still add the global ones).
    if (q.data.project && projectKeys?.length === 0) return c.json([]);
    const limit = q.data.limit ?? PAGE;
    const offset = q.data.offset ?? 0;
    const read = (n: number, from: number) => intake.listClaims({
      ...(q.data.status && { status: [q.data.status] }), ...(q.data.type && { type: [q.data.type] }), ...(projectKeys && { projectKeys }),
      ...(q.data.person && { speakerId: q.data.person }), ...(q.data.source && { docId: q.data.source }), limit: n, offset: from, run: runAsked().run ?? null,
    });
    if (q.data.sort === 'score') {
      const { page, next } = await pageByScore(async (n) => ctx.scores.claims(await withConflicts(await read(n, 0))), limit, offset);
      if (next !== null) c.header('x-next-offset', String(next));
      return c.json(page);
    }
    const rows = await read(limit + 1, offset);
    if (rows.length > limit) c.header('x-next-offset', String(offset + limit));
    return c.json(await ctx.scores.claims(await withConflicts(rows.slice(0, limit))));
  });

  app.get('/api/claims/:id', async (c) => {
    const claim = await shownClaim(c.req.param('id'));
    if (!claim) return c.json({ error: 'not found' }, 404);
    const [listed] = await withConflicts([claim]);
    const [source] = await intake.metas([claim.docId]);
    return c.json({ claim: (await ctx.scores.claims([listed]))[0], fingerprint: claimFingerprint(claim), speaker: await person(claim.speakerId), source: source ?? null });
  });

  type Decision = z.infer<typeof ClaimPatchBody>;
  /** Why an accepted claim's fact says where it came from: "Ana, 2026-11-10 call". */
  const whyOf = async (claim: Claim) => {
    const who = (await person(claim.speakerId))?.displayName ?? 'someone';
    if (claim.docId.startsWith('answer:')) return `${who}, answering a question`;
    const [meta] = await intake.metas([claim.docId]);
    const when = (claim.assertedAt ?? meta?.occurredAt ?? null)?.slice(0, 10);
    return [who, [when, meta ? SOURCE_WORD[meta.kind] : 'source'].filter(Boolean).join(' ')].join(', ');
  };

  /**
   * Review one claim: edit, re-type, accept or reject it. Accepting one that is not an opinion files its fact (origin
   * claim) after the claim is saved; the fact's id is then recorded on the claim. A claim already given to agents as a
   * fact, or superseded, is changed only by a conflict's resolution or a rollback (0.9.0 §6).
   */
  async function decide(id: string, b: Decision, by: string): Promise<{ claim: Claim; fact: StoredFact | null }> {
    const claim = await shownClaim(id);
    if (!claim) throw new Refusal(404, 'not found');
    if (!mayChange(claim)) throw new Refusal(409, new NotTheRunsError(`the claim ${id}`, currentRun()!.id).message);
    if (b.expect !== undefined && b.expect !== claimFingerprint(claim)) throw new Refusal(409, `${id} changed since you opened it: reload it and decide again`);
    if (claim.status === 'superseded') throw new Refusal(409, 'this claim lost a conflict: it changes only by rolling that resolution back');
    if (claim.factId) throw new Refusal(409, `this claim is already the fact ${claim.factId} agents are given: it changes by resolving a conflict or rolling back, not here`);
    if (b.asFact === false && b.type !== undefined && b.type !== 'opinion') throw new Refusal(400, 'asFact false keeps it as an opinion: leave out type, or send type opinion');
    const type: ClaimType = b.asFact === false ? 'opinion' : b.type ?? claim.type;
    const status = b.status ?? claim.status;
    if (b.asFact === true && type === 'opinion') throw new Refusal(400, 'an opinion is never given to agents: re-type it (type fact, decision, plan or commitment) to accept it as a fact');
    const makesFact = status === 'accepted' && type !== 'opinion';
    if (b.projectKey !== undefined && claim.projectKey !== null && b.projectKey !== claim.projectKey) throw new Refusal(400, `this claim belongs to ${claim.projectKey}: its fact is filed there`);
    const projectKey = claim.projectKey ?? b.projectKey ?? null;
    if (makesFact && projectKey === null) throw new Refusal(409, 'this claim is global, so there is no project to file its fact under: send projectKey');
    if (makesFact && !(await visible(projectKey))) throw new Refusal(404, 'not found: this project is not selected (choose it in Settings to see it)');
    const statement = b.statement ?? claim.statement;
    const scope: ClaimScope = b.scope ?? claim.scope;
    const reworded = b.statement !== undefined && b.statement !== claim.statement;
    // Embedded before anything is written: with the embedding model down nothing changes, rather than a claim accepted with no fact.
    const texts = [...(reworded ? [statement] : []), ...(makesFact ? [factEmbeddingText({ path: factPathOf({ scope, docId: claim.docId }), statement, origin: 'claim' })] : [])];
    const vectors = texts.length ? await d.embed(texts) : [];
    const patch: ClaimPatch = {
      ...(status !== claim.status && { status }), ...(type !== claim.type && { type }), ...(reworded && { statement, embedding: vectors[0] }),
      ...(b.scope && { scope }), ...(b.about !== undefined && { about: b.about }),
    };
    let saved = Object.keys(patch).length ? await intake.decideClaim(id, patch, { by, expect: claimFingerprint(claim) }) : claim;
    if (!saved) throw new Refusal(404, 'not found');
    let fact: StoredFact | null = null;
    if (makesFact) {
      fact = await d.facts.addOwnerFact(projectKey!, {
        kind: factKindOf(type as Exclude<ClaimType, 'opinion'>, b.kind), statement, path: factPathOf(saved), lines: null, confidence: 1,
        why: await whyOf(saved), relevance: b.relevance ?? CLAIM_FACT_RELEVANCE, embedding: vectors.at(-1)!,
      }, by as RelevanceBy, currentRun(), { origin: 'claim' });
      saved = (await intake.decideClaim(id, { factId: fact.id }, { by })) ?? saved;
    }
    const changed = Object.keys(patch).filter((k) => k !== 'embedding');
    await d.activity.record({
      kind: 'claim_decided', actor: 'you', projectKey: saved.projectKey,
      subject: `${status === claim.status ? 'edited' : status} ${type} claim "${statement.slice(0, 120)}"`.slice(0, 300),
      why: fact ? `you accepted it, so agents are now given it as a ${fact.kind} fact` : status === 'accepted' && type === 'opinion'
        ? 'you accepted it as an opinion: it stays attributed to who said it, and agents are not given it'
        : status === 'rejected' ? 'you rejected it; agents will not see it' : 'you edited it',
      details: { status, type, changed, factId: fact?.id ?? null, ...(projectKey !== claim.projectKey && { filedUnder: projectKey }) },
      targets: [id, ...(fact ? [fact.id] : [])],
    });
    return { claim: saved, fact };
  }

  app.patch('/api/claims/:id', async (c) => {
    const body = ClaimPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    try {
      return c.json(await decide(c.req.param('id'), body.data, currentActor()));
    } catch (e) {
      return refused(c, e);
    }
  });

  // One leftover claim removed for good (its source gone, say). A claim agents are given (accepted) or one a conflict
  // superseded is refused: reject it, or roll that resolution back, first. The Activity entry, and the earlier entries
  // about the claim (deleteClaims), name it without its text.
  app.delete('/api/claims/:id', async (c) => {
    const id = c.req.param('id');
    const claim = await shownClaim(id);
    if (!claim) return c.json({ error: 'not found' }, 404);
    if (!mayChange(claim)) return c.json({ error: new NotTheRunsError(`the claim ${id}`, currentRun()!.id).message }, 409);
    if (claim.status === 'accepted') return c.json({ error: 'this claim is accepted: reject it first, so agents stop being given it, then delete it' }, 409);
    if (claim.status === 'superseded') return c.json({ error: 'this claim lost a conflict: roll that resolution back first' }, 409);
    if (!(await intake.deleteClaims([id]))) return c.json({ error: 'not found' }, 404);
    await d.activity.record({
      kind: 'claim_decided', actor: 'you', projectKey: claim.projectKey, subject: `deleted a ${claim.status} ${claim.type} claim`,
      why: 'you deleted it: its statement and quote are gone, and earlier entries about it no longer quote it',
      details: { status: 'deleted', was: claim.status, type: claim.type, docId: claim.docId }, targets: [id],
    });
    return c.body(null, 204);
  });

  // Each claim is decided and recorded on its own, as if one at a time; one refused does not stop the rest. With
  // `source`, every proposed claim of that source (bulk accept by source). An opinion accepted here stays an opinion.
  app.post('/api/claims/decisions', async (c) => {
    const body = ClaimDecisions.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const items = body.data.items ?? (await intake.listClaims({ docId: body.data.source!, status: ['proposed'], limit: MAX_PAGE, run: runAsked().run ?? null }))
      .map((x) => ({ id: x.id, status: body.data.status! }));
    const by = currentActor();
    const results: { id: string; ok: boolean; status?: string; factId?: string | null; error?: string }[] = [];
    for (const item of items) {
      try {
        const { claim, fact } = await decide(item.id, { status: item.status }, by);
        results.push({ id: item.id, ok: true, status: claim.status, factId: fact?.id ?? null });
      } catch (e) {
        if (!(e instanceof Refusal) && !(e instanceof TargetChangedError)) throw e;
        results.push({ id: item.id, ok: false, error: e instanceof Refusal ? e.message : `${item.id} changed since it was listed` });
      }
    }
    return c.json({ results });
  });

  // ── Questions ───────────────────────────────────────────────────────────

  app.get('/api/questions', async (c) => {
    const q = QuestionsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const projectKeys = await keysFor(q.data.project);
    // A project not shown has nothing to list (the store would still add the global ones).
    if (q.data.project && projectKeys?.length === 0) return c.json([]);
    const limit = q.data.limit ?? PAGE;
    const offset = q.data.offset ?? 0;
    const read = (n: number, from: number) => intake.listQuestions({
      ...(q.data.status && { status: [q.data.status] }), ...(q.data.kind && { kind: [q.data.kind] }), ...(projectKeys && { projectKeys }),
      ...(q.data.source && { docId: q.data.source }), ...(q.data.assignee && { assignee: q.data.assignee }), limit: n, offset: from, run: runAsked().run ?? null,
    });
    if (q.data.sort === 'score') {
      const { page, next } = await pageByScore(async (n) => ctx.scores.questions(await read(n, 0)), limit, offset);
      if (next !== null) c.header('x-next-offset', String(next));
      return c.json(page);
    }
    const rows = await read(limit + 1, offset);
    if (rows.length > limit) c.header('x-next-offset', String(offset + limit));
    return c.json(await ctx.scores.questions(rows.slice(0, limit)));
  });

  app.get('/api/questions/:id', async (c) => {
    const q = await shownQuestion(c.req.param('id'));
    if (!q) return c.json({ error: 'not found' }, 404);
    const [source] = await intake.metas([q.docId]);
    return c.json({ question: (await ctx.scores.questions([q]))[0], askedBy: await person(q.askedBy), assignee: await person(q.assignee), answer: q.answerClaimId ? await intake.claim(q.answerClaimId) : null, source: source ?? null });
  });

  const questionActivity = (q: Question, subject: string, why: string, details: Record<string, unknown>, targets: string[] = []) =>
    d.activity.record({ kind: 'question_changed', actor: 'you', projectKey: q.projectKey, subject: subject.slice(0, 300), why, details, targets: [q.id, ...targets] });

  // Assigning a question marks it assigned; unassigning one reopens it; dismissing it closes it unanswered.
  app.patch('/api/questions/:id', async (c) => {
    const body = QuestionPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const q = await shownQuestion(c.req.param('id'));
    if (!q) return c.json({ error: 'not found' }, 404);
    if (!mayChange(q)) return c.json({ error: new NotTheRunsError(`the question ${q.id}`, currentRun()!.id).message }, 409);
    if (q.status === 'answered') return c.json({ error: 'this question is answered: its answer is a claim, decided on the Claims tab' }, 409);
    const { assignee } = body.data;
    const who = assignee ? await intake.person(assignee) : null;
    if (assignee && (!who || who.status === 'forgotten')) return c.json({ error: `no such person: ${assignee}` }, 404);
    // Open or reassigned: assigned while it has someone, open while it has nobody.
    const status: Question['status'] = body.data.status === 'dismissed' ? 'dismissed' : (assignee === undefined ? q.assignee : assignee) ? 'assigned' : 'open';
    const updated = await intake.updateQuestion(q.id, { status, ...(assignee !== undefined && { assignee }) }, currentActor());
    if (!updated) return c.json({ error: 'not found' }, 404);
    await questionActivity(updated, `${updated.status} question "${q.text.slice(0, 120)}"${who ? ` (to ${who.displayName})` : ''}`,
      updated.status === 'dismissed' ? 'you dismissed it' : who ? `you assigned it to ${who.displayName}` : 'you reopened it', { status: updated.status, assignee: updated.assignee });
    return c.json(updated);
  });

  // Your answer is an accepted claim said by you (your Person); one that is not an opinion is also filed as a fact.
  app.post('/api/questions/:id/answer', async (c) => {
    const body = AnswerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const q = await shownQuestion(c.req.param('id'));
    if (!q) return c.json({ error: 'not found' }, 404);
    if (!mayChange(q)) return c.json({ error: new NotTheRunsError(`the question ${q.id}`, currentRun()!.id).message }, 409);
    if (q.status === 'answered') return c.json({ error: 'this question is already answered' }, 409);
    const { text, type } = body.data;
    if (body.data.projectKey !== undefined && q.projectKey !== null && body.data.projectKey !== q.projectKey) return c.json({ error: `this question belongs to ${q.projectKey}: its answer is filed there` }, 400);
    const projectKey = q.projectKey ?? body.data.projectKey ?? null;
    const makesFact = type !== 'opinion';
    if (makesFact && projectKey === null) return c.json({ error: 'this question is global, so there is no project to file the answer\'s fact under: send projectKey, or answer it as an opinion' }, 409);
    if (makesFact && !(await visible(projectKey))) return c.json({ error: 'not found: this project is not selected (choose it in Settings to see it)' }, 404);
    const by = currentActor();
    const [embedding] = await d.embed([text]);
    const owner = await intake.ensureOwner(d.ownerName ?? OWNER_NAME);
    const answered = await intake.answerQuestion(q.id, { statement: text, type, speakerId: owner.id, scope: { area: null, files: [] }, about: q.text.slice(0, 300), embedding }, by);
    if (!answered) return c.json({ error: 'not found' }, 404);
    let fact: StoredFact | null = null;
    let { claim } = answered;
    if (makesFact) {
      const path = factPathOf(claim);
      const [vector] = await d.embed([factEmbeddingText({ path, statement: text, origin: 'claim' })]);
      fact = await d.facts.addOwnerFact(projectKey!, {
        kind: factKindOf(type, body.data.kind), statement: text, path, lines: null, confidence: 1, why: await whyOf(claim),
        relevance: body.data.relevance ?? CLAIM_FACT_RELEVANCE, embedding: vector,
      }, by as RelevanceBy, currentRun(), { origin: 'claim' });
      claim = (await intake.decideClaim(claim.id, { factId: fact.id }, { by })) ?? claim;
    }
    await questionActivity(answered.question, `answered question "${q.text.slice(0, 120)}"`,
      fact ? `you answered it, so agents are now given the answer as a ${fact.kind} fact` : 'you answered it as an opinion: agents are not given it',
      { status: 'answered', claimId: claim.id, factId: fact?.id ?? null }, [claim.id, ...(fact ? [fact.id] : [])]);
    return c.json({ question: answered.question, claim, fact }, 201);
  });

  // ── People ──────────────────────────────────────────────────────────────

  app.get('/api/people', async (c) => {
    const q = PeopleQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    return c.json(await intake.people(q.data.status ? { status: [q.data.status] } : undefined));
  });

  const personActivity = (subject: string, why: string, details: Record<string, unknown>, targets: string[]) =>
    d.activity.record({ kind: 'person_changed', actor: 'you', projectKey: null, subject: subject.slice(0, 300), why, details, targets });

  app.patch('/api/people/:id', async (c) => {
    const body = PersonPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const before = await intake.person(c.req.param('id'));
    if (!before) return c.json({ error: 'not found' }, 404);
    if (before.status === 'forgotten') return c.json({ error: 'this person was forgotten: nothing about them can change' }, 409);
    try {
      const after = await intake.updatePerson(before.id, body.data);
      if (!after) return c.json({ error: 'not found' }, 404);
      await personActivity(`${body.data.status === 'confirmed' && before.status !== 'confirmed' ? 'confirmed' : 'changed'} person "${after.displayName}"`,
        'you changed who this is: speaker labels and names matching their aliases now resolve to them', { ...body.data, before: { displayName: before.displayName, status: before.status } }, [after.id]);
      return c.json(after);
    } catch (e) {
      return refused(c, e);
    }
  });

  app.post('/api/people/merge', async (c) => {
    const body = MergeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const { keepId, mergedId } = body.data;
    if (keepId === mergedId) return c.json({ error: 'a person cannot be merged into themselves' }, 400);
    const [keep, merged] = await Promise.all([intake.person(keepId), intake.person(mergedId)]);
    if (!keep || !merged) return c.json({ error: 'not found' }, 404);
    if (merged.isOwner) return c.json({ error: 'you cannot be merged into someone else: merge them into you instead' }, 409);
    if (keep.status === 'forgotten' || merged.status === 'forgotten') return c.json({ error: 'a forgotten person cannot be merged' }, 409);
    const after = await intake.mergePeople(keepId, mergedId);
    if (!after) return c.json({ error: 'not found' }, 404);
    await personActivity(`merged "${merged.displayName}" into "${after.displayName}"`, 'you said they are the same person: their aliases, claims and questions are now one person\'s',
      { keepId, mergedId, mergedName: merged.displayName }, [keepId, mergedId]);
    return c.json(after);
  });

  app.post('/api/people/:id/forget', async (c) => {
    const body = ForgetBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const id = c.req.param('id');
    if (body.data.confirm !== id) return c.json({ error: 'confirm must be the person\'s id: forgetting cannot be undone' }, 400);
    const p: Person | null = await intake.person(id);
    if (!p) return c.json({ error: 'not found' }, 404);
    if (p.isOwner) return c.json({ error: 'you cannot forget yourself' }, 409);
    const out = await intake.forgetPerson(id);
    if (!out) return c.json({ error: 'not found' }, 404);
    // The name is what is being forgotten: the entry says only that someone was.
    await personActivity('forgot a person', 'you asked for them to be forgotten: their name and aliases are gone, and their claims you had not accepted were removed',
      { claimsRemoved: out.claimsRemoved }, [id]);
    return c.json(out);
  });
}
