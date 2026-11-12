import { createHash } from 'node:crypto';
import {
  absentSnapshot, EVERYDAY_FROM, factSnapshot, LOOP_ACTOR, lessonFingerprint, lessonSnapshot, lessonToFact,
  type Activity, type Decision, type EvidenceRef, type Lesson, type StoredFact,
} from '@fb/core';
import { MODEL_FACT_WHY, statesAFact } from '../../postmortem/lessonCheck.ts';
import { callOf, holdsStill, SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { lessonNeverTarget, ownerTouchedRecently } from './guards.ts';

/** Lessons listed each round. */
const LESSON_PAGE = 200;
/** How far back the owner's notes and edits are compared with a new one. */
const NOTES_PAGE = 200;
const EDITS_PAGE = 500;
/** Two statements say the same thing at this word overlap (Jaccard over their content words) or more. */
export const SAME_STATEMENT = 0.6;
/** Owner statements saying the same thing, from different notes or lessons, that make a standing fact. */
export const STANDING_FLOOR = 2;
/** A statement needs this many content words to be compared at all. */
const MIN_WORDS = 3;
const SENTENCE = { min: 12, max: 300 } as const;
const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'from', 'that', 'this', 'these', 'those', 'its', 'not', 'but', 'has', 'have', 'had', 'our',
  'you', 'your', 'they', 'their', 'there', 'than', 'then', 'into', 'onto', 'all', 'any', 'only', 'just', 'also', 'always', 'never', 'which', 'what',
]);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** A fact id the decision plans (UUID-shaped, like the stores' own), from what it rests on: the same call is the same id. */
export const plannedFactId = (key: string) => {
  const h = sha(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** The content words of a statement, for comparing two. */
export function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_./@-]+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter((w) => w.length >= 3 && !STOP.has(w)));
}
export function overlap(a: Set<string>, b: Set<string>): number {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both || 1);
}

/** What the owner said: a sentence of one of their notes or edited lessons that states how the code is. */
export type OwnerStatement = { text: string; projectKey: string; source: string; entry: Activity; role: 'owner note' | 'owner edit'; words: Set<string> };

const sentences = (text: string) => text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= SENTENCE.min && s.length <= SENTENCE.max);
/**
 * A note's sentences are each judged; a rule or "applies when" the owner edited only as a whole: a rule that says what
 * to do ("Use the money helpers. Orders are stored in cents.") is a rule, though one of its sentences states a fact.
 */
const statements = (text: string, o: Omit<OwnerStatement, 'text' | 'words'>): OwnerStatement[] =>
  o.role === 'owner edit' && !statesAFact(text)
    ? []
    : sentences(text).filter(statesAFact).map((t) => ({ ...o, text: t, words: words(t) })).filter((s) => s.words.size >= MIN_WORDS);

/** An Activity entry the owner made (not an operator, not the loop). */
const byOwner = (e: Activity) => e.actor === 'you';
const isNote = (e: Activity) => e.kind === 'decision_noted' && byOwner(e) && typeof e.details.decisionId === 'string';
const isEdit = (e: Activity) => e.kind === 'lesson_decided' && byOwner(e) && !!e.projectKey && typeof e.details.changed === 'object' && e.details.changed !== null;

/** The owner's statements in these entries: their own notes on decisions (read from the store), and the words they gave edited lessons. */
async function ownerStatements(ctx: LoopTypeContext, entries: readonly Activity[]): Promise<OwnerStatement[]> {
  const out: OwnerStatement[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (isNote(e) && e.projectKey) {
      for (const n of await ctx.store.decisions.notes(e.details.decisionId as string)) {
        if (n.by !== 'you' || seen.has(n.id)) continue;
        seen.add(n.id);
        out.push(...statements(n.text, { projectKey: e.projectKey, source: n.id, entry: e, role: 'owner note' }));
      }
    } else if (isEdit(e)) {
      const changed = e.details.changed as Record<string, { to?: unknown }>;
      const said = ['rule', 'appliesWhen'].map((k) => changed[k]?.to).filter((t): t is string => typeof t === 'string');
      for (const t of said) out.push(...statements(t, { projectKey: e.projectKey!, source: e.targets[0], entry: e, role: 'owner edit' }));
    }
  }
  return out;
}

/**
 * record_fact (tier A): something agents should know as a project fact rather than follow as a lesson.
 * - A lesson flagged looks-like-a-fact (proposed or approved) whose rule still states how the code is: converted as the
 *   Lessons page converts one (lessonToFact), the lesson rejected with "converted to a fact".
 * - A standing fact: the owner said the same thing about the code at least STANDING_FLOOR times, in notes on the loop's
 *   decisions or in lessons they edited (a sentence that states a fact, word overlap ≥ SAME_STATEMENT), counted only
 *   when a new one arrives this round. Always proposed only: they are the owner's words, for the owner to confirm.
 * The fact is the loop's (origin loop, relevance by LOOP_ACTOR at EVERYDAY_FROM): no scan closes or replaces it.
 */
export const recordFact: LoopType = {
  type: 'record_fact',
  weights: { bias: -0.5, factLike: 1.5, modelSaid: 0.5, standing: 1, approved: -0.3, served: -0.3 },
  groups: { evidence: ['factLike', 'modelSaid', 'standing'], scope: ['approved', 'served'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    let scanned = 0;
    for (const l of await ctx.store.knowledge.listLessons({ flag: 'looks-like-a-fact', limit: LESSON_PAGE })) {
      if (l.status !== 'proposed' && l.status !== 'approved') continue;
      scanned++;
      const c = await fromLesson(ctx, l);
      if (typeof c === 'string') skip(skipped, c);
      else candidates.push(c);
    }
    const fresh = await ownerStatements(ctx, ctx.entries);
    if (fresh.length) {
      const [notes, edits] = await Promise.all([
        ctx.store.activity.list({ kind: 'decision_noted', limit: NOTES_PAGE }),
        ctx.store.activity.list({ kind: 'lesson_decided', limit: EDITS_PAGE }),
      ]);
      const all = await ownerStatements(ctx, [...ctx.entries, ...notes, ...edits]);
      const made = new Set<string>();
      for (const s of fresh) {
        scanned++;
        const c = await standing(ctx, s, all, made);
        if (typeof c === 'string') skip(skipped, c);
        else candidates.push(c);
      }
    }
    return { candidates, scanned, skipped };
  },

  /**
   * A standing fact is found only when a new statement arrives, and a lesson's conversion is not made twice: an observed
   * call is measured again by its floors (a conversion: the lesson still flagged and stating a fact; a standing fact:
   * in scope and not yet a fact), keeping its call.
   */
  async recheck(ctx: LoopTypeContext, observed: readonly Decision[]): Promise<(LoopCandidate | string)[]> {
    const out: (LoopCandidate | string)[] = [];
    for (const d of observed) {
      const lessonId = d.targets.find((t) => t.kind === 'lesson')?.id;
      const l = lessonId ? (await ctx.store.knowledge.lessonDetail(lessonId))?.lesson : null;
      if (lessonId) {
        const flagged = l && (l.status === 'proposed' || l.status === 'approved') && l.checks?.some((c) => c.name === 'looks-like-a-fact');
        out.push(holdsStill(flagged ? await fromLesson(ctx, l, d) : null));
      } else {
        out.push(await standingStill(ctx, d));
      }
    }
    return out;
  },
};

/** An observed standing fact, its call kept while its project is in scope and no fact says the same yet. */
async function standingStill(ctx: LoopTypeContext, d: Decision): Promise<LoopCandidate | string> {
  const statement = String(d.after[0].fields.statement);
  if (!ctx.inScope(d.projectKey)) return SKIP.outOfScope;
  if (await alreadyAFact(ctx, d.projectKey!, words(statement))) return 'already_a_fact';
  return callOf(d, `a standing fact from your words: "${statement.slice(0, 80)}"`, { proposeOnly: STANDING_PROPOSE_ONLY });
}

const STANDING_PROPOSE_ONLY = 'a standing fact is your words: you confirm it';

/** A fact of the loop's or yours in this project says the same. */
async function alreadyAFact(ctx: LoopTypeContext, projectKey: string, said: Set<string>): Promise<boolean> {
  const kept: StoredFact[] = [
    ...await ctx.store.facts.listFacts({ projectKey, origin: 'loop' }),
    ...await ctx.store.facts.listFacts({ projectKey, origin: 'you' }),
  ];
  return kept.some((f) => overlap(words(f.statement), said) >= SAME_STATEMENT);
}

/** The decision converting lesson `l`, or why there is none. again: the observed decision a recheck measures again, its call kept. */
async function fromLesson(ctx: LoopTypeContext, l: Lesson, again?: Decision): Promise<LoopCandidate | string> {
  if (lessonNeverTarget(l)) return SKIP.neverTarget;
  if (!ctx.inScope(l.projectKey ?? l.origin ?? null)) return SKIP.outOfScope;
  if (!statesAFact(l.rule)) return SKIP.belowFloor;
  const fp = lessonFingerprint(l);
  if (again) {
    const touched = ownerTouchedRecently(await ctx.signals(l.id), ctx.now);
    return callOf(again, `lesson "${l.title.slice(0, 60)}" becomes a fact`, touched ? { proposeOnly: 'you decided or edited this lesson in the last 14 days' } : {});
  }
  if ((await ctx.store.decisions.forTarget(l.id)).some((d: Decision) => d.type === 'record_fact' && d.before.some((b) => b.id === l.id && b.fingerprint === fp))) return SKIP.alreadyDecided;
  const detail = await ctx.store.knowledge.lessonDetail(l.id);
  const draft = lessonToFact(l, detail?.miss?.missed ?? null);
  if (!draft) return SKIP.belowFloor;
  const signals = await ctx.signals(l.id);
  const id = plannedFactId(`lesson|${l.id}|${fp}`);
  const decidedAt = new Date(ctx.now).toISOString();
  // Listed by its looks-like-a-fact check, so it has checks.
  const modelSaid = l.checks!.some((c) => c.name === 'looks-like-a-fact' && c.why === MODEL_FACT_WHY);
  return {
    projectKey: draft.projectKey,
    targets: [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'fact', id, role: 'created' }],
    before: [lessonSnapshot(l), absentSnapshot({ kind: 'fact', id })],
    after: [
      lessonSnapshot({ ...l, status: 'rejected', decidedAt, decidedBy: LOOP_ACTOR, decisionNote: 'converted to a fact' }),
      factSnapshot({ id, ...draft, relevanceBy: LOOP_ACTOR, current: true }),
    ],
    evidence: [{ kind: 'check', id: `${l.id}#looks-like-a-fact`, role: 'check looks-like-a-fact', weight: 1, observedAt: l.createdAt }],
    features: {
      factLike: 1, modelSaid: modelSaid ? 1 : 0, standing: 0, approved: l.status === 'approved' ? 1 : 0,
      served: Math.min(signals?.counts.served ?? 0, 20) / 20,
    },
    subject: `lesson "${l.title.slice(0, 60)}" becomes a ${draft.kind} fact`,
    rationale: `The ${l.status} lesson "${l.title}" states how the code is rather than what to do${modelSaid ? ' (the post-mortem model said so too)' : ''}. As a project fact, filed under ${draft.path}, agents get it with the project facts and no scan replaces it; the lesson is rejected as converted, as the Lessons page's "convert to a fact" does.`,
    ...(ownerTouchedRecently(signals, ctx.now) && { proposeOnly: 'you decided or edited this lesson in the last 14 days' }),
  };
}

/** The standing fact a new owner statement makes with the earlier ones saying the same, or why there is none. */
async function standing(ctx: LoopTypeContext, s: OwnerStatement, all: OwnerStatement[], made: Set<string>): Promise<LoopCandidate | string> {
  if (!ctx.inScope(s.projectKey)) return SKIP.outOfScope;
  const same = all.filter((o) => o.projectKey === s.projectKey && o.source !== s.source && overlap(o.words, s.words) >= SAME_STATEMENT);
  const sources = [...new Map([s, ...same].map((o) => [o.source, o])).values()];
  if (sources.length < STANDING_FLOOR) return SKIP.belowFloor;
  const key = [...s.words].sort().join(' ');
  const id = plannedFactId(`standing|${s.projectKey}|${key}`);
  if (made.has(id)) return SKIP.alreadyDecided;
  made.add(id);
  if ((await ctx.store.decisions.forTarget(id)).length) return SKIP.alreadyDecided;
  if (await alreadyAFact(ctx, s.projectKey, s.words)) return 'already_a_fact';
  const why = `You said this ${sources.length} times: ${sources.map((o) => (o.role === 'owner note' ? 'in a note on a loop decision' : `editing ${o.source}`)).join('; ')}`;
  const evidence: EvidenceRef[] = sources.map((o) => ({ kind: 'activity', id: o.entry.id, role: o.role, weight: 1, observedAt: o.entry.ts }));
  return {
    projectKey: s.projectKey,
    targets: [{ kind: 'fact', id, role: 'created' }],
    before: [absentSnapshot({ kind: 'fact', id })],
    after: [factSnapshot({ id, projectKey: s.projectKey, kind: 'convention', statement: s.text, path: '.', lines: null, why, relevance: EVERYDAY_FROM, relevanceBy: LOOP_ACTOR, current: true })],
    evidence,
    features: { factLike: 1, modelSaid: 0, standing: Math.min(sources.length, 4) / 4, approved: 0, served: 0 },
    subject: `a standing fact from your words: "${s.text.slice(0, 80)}"`,
    rationale: `${why}. It states how the code is, so as a project fact agents get it with the project facts and no scan replaces it.`,
    proposeOnly: STANDING_PROPOSE_ONLY,
  };
}
