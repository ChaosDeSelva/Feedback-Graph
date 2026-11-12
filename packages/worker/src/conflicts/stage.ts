import {
  CONFLICT_NEIGHBOURS, claimFingerprint, factFingerprint, factOrigin, lessonFingerprint,
  type ActivityKind, type Claim, type ConflictSide, type ConflictSideInfo, type Lesson, type DocsStore, type LlmProvider, type StoredFact, type Store,
} from '@fb/core';
import { detectFor, emptyTally, type ConflictSink, type DetectDeps, type DetectTally, type Neighbour } from './detect.ts';

/**
 * Contradiction detection on the store (0.9.0 §5.6): the sides read from claims, facts and lessons; their neighbours
 * from the vector indexes; what is found stored through IntakeStore (openConflict, addQuestion, addLinks). It runs on
 * the Activity entries that change what is known (a claim accepted, a source read, a lesson approved or edited, a
 * decision applied) and in a capped sweep that pages through current facts and approved lessons.
 */

export type ConflictStageDeps = {
  store: Pick<Store, 'intake' | 'facts' | 'knowledge' | 'links' | 'activity'> & { docs: Pick<DocsStore, 'getCursor' | 'setCursor'> };
  embed(texts: string[]): Promise<number[][]>;
  /** CONFLICT_LLM, each call taken from CONFLICT_LLM_CALLS_PER_DAY (budgetedLlm); null: pre-filters only. */
  llm: LlmProvider | null;
  /** The selected projects' keys: where a global side's facts are looked for, and what the sweep pages through. */
  projects: () => Promise<string[]>;
  log?: (msg: string, extra?: object) => void;
};

/** The Activity entries after which their targets are checked, and where the triggers have read to. */
export const CONFLICT_TRIGGER_KINDS: ActivityKind[] = ['claim_decided', 'source_read', 'lesson_decided', 'lesson_to_fact', 'decision_applied', 'decision_rolled_back'];
export const CONFLICT_TRIGGER_CURSOR = 'conflict-trigger';
export const CONFLICT_SWEEP_CURSOR = 'conflict-sweep';
/** Activity entries a trigger round reads, and sides a sweep round checks: each side can cost up to five judge calls. */
const TRIGGER_PAGE = 20;
export const SWEEP_SIDES = 40;

const FACT_TYPES = new Set(['decision', 'plan']);
const isPath = (p: string) => !!p && p !== '.' && !p.startsWith('source:');

// ── Sides ──────────────────────────────────────────────────────────────

/** owner: the claim's speaker is the owner's Person, or it has no speaker and comes from notes (the owner's). */
export function claimSide(c: Claim, owner: boolean): ConflictSideInfo {
  return {
    ref: { kind: 'claim', id: c.id }, projectKey: c.projectKey, text: c.statement, citable: [c.quote, c.statement], about: c.about || null, area: c.scope.area,
    files: c.scope.files, assertedAt: c.assertedAt ?? c.createdAt, speaker: c.speakerId, owner, type: c.type, due: c.due, docId: c.docId,
    fingerprint: claimFingerprint(c),
  };
}

export function factSide(f: StoredFact, projectKey: string): ConflictSideInfo {
  return {
    ref: { kind: 'fact', id: f.id }, projectKey, text: f.statement, citable: [f.statement], about: null, area: null, files: isPath(f.path) ? [f.path] : [],
    assertedAt: f.createdAt, speaker: null, owner: factOrigin(f) === 'you', type: FACT_TYPES.has(f.kind) ? (f.kind as 'decision' | 'plan') : null, due: null,
    docId: null, fingerprint: factFingerprint({ ...f, current: true }),
  };
}

export function lessonSide(l: Lesson): ConflictSideInfo {
  return {
    ref: { kind: 'lesson', id: l.id }, projectKey: l.projectKey, text: l.rule, citable: [l.rule, l.title], about: l.title, area: null, files: l.paths,
    assertedAt: l.decidedAt ?? l.createdAt, speaker: null, owner: false, type: null, due: null, docId: null, fingerprint: lessonFingerprint(l),
  };
}

/** A fact made from an accepted claim is that claim's side, not one of its own. */
const factIsSide = (f: StoredFact) => factOrigin(f) !== 'claim';

/** One round's reads that do not change within it: confirmed links, the owner, which sources are notes. */
class RoundState {
  private links: Promise<Set<string>> | null = null;
  private owner: Promise<string | null> | null = null;
  private notes = new Map<string, Promise<boolean>>();
  linkSet: Set<string> = new Set();
  private d: ConflictStageDeps;

  constructor(d: ConflictStageDeps) {
    this.d = d;
  }

  async ready() {
    this.links ??= this.d.store.links.listLinks({}).then((ls) => new Set(ls.filter((l) => l.status === 'confirmed').flatMap((l) => [`${l.a}|${l.b}`, `${l.b}|${l.a}`])));
    this.linkSet = await this.links;
  }

  linkedTo(key: string): string[] {
    return [...this.linkSet].filter((p) => p.startsWith(`${key}|`)).map((p) => p.slice(key.length + 1));
  }

  async claimOwner(c: Claim): Promise<boolean> {
    this.owner ??= this.d.store.intake.people({ status: ['confirmed'] }).then((ps) => ps.find((p) => p.isOwner)?.id ?? null);
    const owner = await this.owner;
    if (c.speakerId) return c.speakerId === owner;
    if (!this.notes.has(c.docId)) this.notes.set(c.docId, this.d.store.intake.metas([c.docId]).then(([m]) => m?.kind === 'notes'));
    return this.notes.get(c.docId)!;
  }
}

/** The store's score is Neo4j's cosine similarity, (1 + cos) / 2: back to the cosine the thresholds are in. */
const cosineOf = (score: number) => 2 * score - 1;

function storeNeighbours(d: ConflictStageDeps, r: RoundState): (side: ConflictSideInfo) => Promise<Neighbour[]> {
  return async (side) => {
    const [embedding] = await d.embed([side.text]);
    const own = side.projectKey ? [side.projectKey, ...r.linkedTo(side.projectKey)] : null;
    const { intake, facts, knowledge } = d.store;
    const [accepted, proposed, lessons, factHits] = await Promise.all([
      intake.searchClaims({ embedding, k: CONFLICT_NEIGHBOURS, status: ['accepted'], ...(own && { projectKeys: own }) }),
      // Proposed claims only from the side's own source: a contradiction there is a Question for its speakers.
      side.ref.kind === 'claim' ? intake.searchClaims({ embedding, k: CONFLICT_NEIGHBOURS, status: ['proposed'], ...(own && { projectKeys: own }) }) : Promise.resolve([]),
      knowledge.searchLessons({ embedding, projectKey: side.projectKey, k: CONFLICT_NEIGHBOURS, status: 'approved' }),
      Promise.all((own ?? (await d.projects())).map((projectKey) => facts.searchFacts({ embedding, projectKey, k: CONFLICT_NEIGHBOURS }).then((hs) => hs.map((h) => ({ ...h, projectKey }))))),
    ]);
    const claimsOut = await Promise.all([...accepted, ...proposed.filter((h) => h.claim.docId === side.docId)].map(async (h) => ({ side: claimSide(h.claim, await r.claimOwner(h.claim)), cosine: cosineOf(h.score) })));
    return [
      ...claimsOut,
      ...lessons.map((h) => ({ side: lessonSide(h.lesson), cosine: cosineOf(h.score) })),
      ...factHits.flat().filter((h) => factIsSide(h.fact)).map((h) => ({ side: factSide(h.fact, h.projectKey), cosine: cosineOf(h.score) })),
    ];
  };
}

const sideOf = (s: ConflictSideInfo): ConflictSide => ({ kind: s.ref.kind, id: s.ref.id, fingerprint: s.fingerprint, assertedAt: s.assertedAt });
const short = (s: string) => (s.length > 90 ? `${s.slice(0, 89)}…` : s);

function storeSink(d: ConflictStageDeps): ConflictSink {
  const { intake, activity } = d.store;
  return {
    async conflict(c) {
      const { conflict, created } = await intake.openConflict({
        kind: c.kind, projectKey: c.a.projectKey ?? c.b.projectKey, a: sideOf(c.a), b: sideOf(c.b), signals: c.signals, judge: { ...c.judge, model: d.llm?.id ?? null },
      });
      if (created) {
        await activity.record({
          kind: 'conflict_found', actor: d.llm?.id ?? 'deterministic', projectKey: conflict.projectKey,
          subject: `${c.kind === 'supersession' ? 'probably superseded' : 'conflict'}: "${short(c.a.text)}" vs "${short(c.b.text)}"`,
          why: `${c.judge.explanation || 'the two cannot both be true'}; the judge cited both (“${short(c.judge.aQuote)}” / “${short(c.judge.bQuote)}”). Settle it on the Intake page's Conflicts tab`,
          details: { kind: c.kind, a: c.a.ref, b: c.b.ref, signals: c.signals.map((s) => s.why), confidence: c.judge.confidence },
          targets: [conflict.id, c.a.ref.id, c.b.ref.id],
        });
      }
      return created;
    },
    async question(a, b, judge) {
      await intake.addQuestion({
        docId: a.docId!, projectKey: a.projectKey, kind: 'contradictory', quote: a.citable[0] ?? null, askedBy: null,
        text: `Which is right: "${short(a.text)}" or "${short(b.text)}"? ${judge.explanation}`.trim().slice(0, 500),
      });
    },
    async link(a, b, relation) {
      const rel = relation === 'same' ? 'corroborates' : 'refines';
      const [from, to] = a.ref.kind === 'claim' ? [a, b] : b.ref.kind === 'claim' ? [b, a] : [null, null];
      if (from && to) await intake.addLinks([{ from: from.ref.id, to: to.ref, rel }]);
    },
  };
}

function detectDeps(d: ConflictStageDeps, r: RoundState): DetectDeps {
  return {
    neighbours: storeNeighbours(d, r),
    linked: (x, y) => r.linkSet.has(`${x}|${y}`),
    llm: d.llm,
    memo: { get: (k) => d.store.docs.getCursor(k), set: (k, v) => d.store.docs.setCursor(k, v) },
    sink: storeSink(d),
  };
}

/**
 * The sides these records are, as detection checks them: an accepted claim (or a proposed one, when its source was
 * just read: `proposed`), a current fact not made from a claim, an approved lesson. Anything else is skipped.
 */
async function sidesOf(d: ConflictStageDeps, r: RoundState, ids: string[], o: { proposed: boolean }): Promise<ConflictSideInfo[]> {
  const out: ConflictSideInfo[] = [];
  const { intake, facts, knowledge } = d.store;
  const claimOk = (c: Claim) => !c.sandbox && !c.run && (c.status === 'accepted' || (o.proposed && c.status === 'proposed'));
  for (const id of new Set(ids)) {
    if (id.startsWith('claim:')) {
      const c = await intake.claim(id);
      if (c && claimOk(c)) out.push(claimSide(c, await r.claimOwner(c)));
      continue;
    }
    const metas = await intake.metas([id]);
    if (metas.length) {
      for (const c of await intake.listClaims({ docId: id, status: ['proposed', 'accepted'], limit: 500 })) if (claimOk(c)) out.push(claimSide(c, await r.claimOwner(c)));
      continue;
    }
    const f = await facts.fact(id);
    if (f) {
      if (f.current && factIsSide(f)) out.push(factSide(f, f.projectKey));
      continue;
    }
    const [l] = await knowledge.listLessons({ ids: [id], limit: 1 });
    if (l?.status === 'approved') out.push(lessonSide(l));
  }
  return out;
}

async function checkAll(d: ConflictStageDeps, r: RoundState, sides: ConflictSideInfo[], t: DetectTally) {
  const deps = detectDeps(d, r);
  for (const s of sides) {
    await detectFor(s, deps, t);
    if (t.spent) return;
  }
}

/**
 * One round of the triggers: the Activity entries since the cursor that change what is known, each target checked.
 * The first round starts at the end of the log (what came before is the sweep's). A round the day's judge calls ran
 * out in does not move the cursor: the next goes over it again, its judged pairs memoised.
 */
export async function conflictTriggerRound(d: ConflictStageDeps): Promise<DetectTally> {
  const t = emptyTally();
  const cursors = d.store.docs;
  const after = await cursors.getCursor(CONFLICT_TRIGGER_CURSOR);
  if (after === null) {
    const { next } = await d.store.activity.since({ limit: 1, last: true });
    await cursors.setCursor(CONFLICT_TRIGGER_CURSOR, next ?? '');
    return t;
  }
  const page = await d.store.activity.since({ after: after || null, kinds: CONFLICT_TRIGGER_KINDS, limit: TRIGGER_PAGE, unlabelled: true });
  if (!page.entries.length) return t;
  const r = new RoundState(d);
  await r.ready();
  // A claim decided or a source read is checked as a claim; a source read also checks its proposed claims (§5.6a).
  const sides = await sidesOf(d, r, page.entries.filter((e) => e.kind === 'source_read').flatMap((e) => e.targets), { proposed: true });
  sides.push(...(await sidesOf(d, r, page.entries.filter((e) => e.kind !== 'source_read').flatMap((e) => e.targets), { proposed: false })));
  await checkAll(d, r, sides, t);
  if (!t.spent && page.next) await cursors.setCursor(CONFLICT_TRIGGER_CURSOR, page.next);
  return t;
}

/** Where the sweep is: the project (by index into the selected ones) and offset into its facts, then the lessons after an id. */
type SweepAt = { phase: 'facts' | 'lessons'; project: number; offset: number; afterId: string | null };
const START: SweepAt = { phase: 'facts', project: 0, offset: 0, afterId: null };

function parseSweep(raw: string | null): SweepAt {
  try {
    const o = JSON.parse(raw ?? 'null') as Partial<SweepAt> | null;
    if (!o || (o.phase !== 'facts' && o.phase !== 'lessons')) return START;
    return { phase: o.phase, project: Number(o.project) || 0, offset: Number(o.offset) || 0, afterId: typeof o.afterId === 'string' ? o.afterId : null };
  } catch {
    return START;
  }
}

/**
 * One round of the sweep: up to `cap` sides from where the last stopped (current facts project by project, then
 * approved lessons by id), back to the start after the last. Pairs judged before are memoised, so a pass over
 * unchanged knowledge costs no judge calls; a round the day's calls ran out in stays where it was.
 */
export async function conflictSweepRound(d: ConflictStageDeps, cap = SWEEP_SIDES): Promise<DetectTally & { wrapped: boolean }> {
  const t = emptyTally();
  const cursors = d.store.docs;
  let at = parseSweep(await cursors.getCursor(CONFLICT_SWEEP_CURSOR));
  const r = new RoundState(d);
  await r.ready();
  const projects = await d.projects();
  let wrapped = false;
  let left = cap;
  while (left > 0 && !wrapped) {
    let sides: ConflictSideInfo[];
    let next: SweepAt;
    if (at.phase === 'facts' && at.project < projects.length) {
      const key = projects[at.project];
      const page = await d.store.facts.listFacts({ projectKey: key, limit: left, offset: at.offset });
      sides = page.filter(factIsSide).map((f) => factSide(f, key));
      next = page.length < left ? { ...at, project: at.project + 1, offset: 0 } : { ...at, offset: at.offset + page.length };
      left -= Math.max(1, page.length);
    } else {
      const page = await d.store.knowledge.listLessons({ status: 'approved', limit: left, ...(at.afterId && { afterId: at.afterId }) });
      sides = page.map(lessonSide);
      wrapped = page.length < left;
      next = wrapped ? START : { phase: 'lessons', project: 0, offset: 0, afterId: page.at(-1)!.id };
      left -= Math.max(1, page.length);
    }
    if (at.phase === 'facts' && at.project >= projects.length) next = { ...START, phase: 'lessons' };
    await checkAll(d, r, sides, t);
    if (t.spent) break;
    at = next;
    await cursors.setCursor(CONFLICT_SWEEP_CURSOR, JSON.stringify(at));
  }
  return { ...t, wrapped };
}

/** A round's counts as the worker logs them; nothing when nothing was looked at. */
export function logTally(d: Pick<ConflictStageDeps, 'log'>, what: string, t: DetectTally) {
  if (t.sides) d.log?.(what, { ...t });
}
