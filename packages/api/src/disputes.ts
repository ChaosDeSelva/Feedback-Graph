import type { Conflict, ConflictSide, IntakeMeta, IntakeStore, Lesson, Project, StoredFact } from '@fb/core';
import { askingRun } from './runs.ts';

/**
 * Knowledge intake's caveats to agents (0.9.0 §6): while a conflict is open, the facts and lessons on either side are
 * served with `[disputed: <conflict id>]`, and a Disputed section says what each side holds without calling either
 * settled. A conflict resolved as both partly is served as a qualification (the owner's note) instead. Only what agents
 * may already see is quoted: a claim the owner has not accepted (or accepted as an opinion) is named, never quoted.
 */

/** submit_notes' input: an agent's notes, stored as a notes source for the owner's review. */
export type AgentNotes = { text: string; title: string; occurredAt: string | null; origin: string };

/** ContextDeps.intake: set only while INTAKE_ENABLED. */
export type IntakeContext = {
  store: Pick<IntakeStore, 'conflictsFor' | 'claim' | 'person' | 'metas'>;
  /** A fact as it is now (closed ones too); null when gone. */
  fact: (id: string) => Promise<(Pick<StoredFact, 'id' | 'statement'> & { current: boolean }) | null>;
  lesson: (id: string) => Promise<Pick<Lesson, 'id' | 'rule' | 'status'> | null>;
  /** submit_notes: store the notes as an intake source of the project (storeIntakeSource). Unset: the tool says intake is off. */
  submit?: (project: Project, notes: AgentNotes) => Promise<{ id: string; utterances: number }>;
  /** what_do_we_know: the look-up's stores (knowledge.ts). Unset: the tool is not offered. */
  knowledge?: import('./knowledge.ts').KnowledgeDeps;
};

/** The conflicts naming each record, open ones and those resolved as both partly. */
export type Disputes = Map<string, Conflict[]>;

const SAID_CHARS = 160;
const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').replace(/`{3,}/g, "'''").replace(/\*\*/g, '').trim();
  return t.length > SAID_CHARS ? `${t.slice(0, SAID_CHARS - 1)}…` : t;
};
const SOURCE_WORD: Record<IntakeMeta['kind'], string> = { transcript: 'call', notes: 'notes', doc: 'doc' };

/** A sandbox run's conflicts are that run's alone, as its records are. */
const runSees = (k: Conflict) => !k.sandbox || (!!k.run && k.run === askingRun());

/** One read (conflictsFor) for every record about to be served. Empty without intake. */
export async function disputesOf(ids: string[], x: IntakeContext | undefined): Promise<Disputes> {
  const out: Disputes = new Map();
  if (!x || !ids.length) return out;
  const found = (await x.store.conflictsFor([...new Set(ids)], { status: ['open', 'resolved'] }))
    .filter((k) => runSees(k) && (k.status === 'open' || (k.resolution?.choice === 'both' && !!k.resolution.note)));
  // A served fact an accepted claim became carries its claim's conflicts.
  const factOf = new Map<string, string>();
  for (const s of found.flatMap((k) => [k.a, k.b]).filter((s) => s.kind === 'claim' && !ids.includes(s.id) && !factOf.has(s.id))) {
    const factId = (await x.store.claim(s.id))?.factId;
    if (factId && ids.includes(factId)) factOf.set(s.id, factId);
  }
  for (const k of found) {
    for (const side of [k.a, k.b]) {
      const id = ids.includes(side.id) ? side.id : factOf.get(side.id);
      if (id) out.set(id, [...(out.get(id) ?? []), k]);
    }
  }
  return out;
}

/** The open conflicts among the disputes, each once, oldest first. */
export const openConflicts = (ds: Disputes): Conflict[] =>
  [...new Map([...ds.values()].flat().filter((k) => k.status === 'open').map((k) => [k.id, k])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

/** What a served line carries: ` [disputed: <id>]` while open, ` (the developer's note: …)` once resolved as both partly. */
export function disputeMark(id: string, ds: Disputes): string {
  const ks = ds.get(id) ?? [];
  const open = ks.filter((k) => k.status === 'open').map((k) => k.id);
  const notes = ks.filter((k) => k.status === 'resolved').map((k) => clip(k.resolution!.note!));
  return `${open.length ? ` [disputed: ${open.join(', ')}]` : ''}${notes.length ? ` (the developer's note: ${notes.join('; ')})` : ''}`;
}

/**
 * One side in words an agent may read: who said it and when for an accepted claim, the statement of a current fact, the
 * rule of an approved lesson; a claim not accepted (or an opinion) is named only. Null when it is gone or closed.
 */
async function sideWords(s: ConflictSide, x: IntakeContext): Promise<string | null> {
  if (s.kind === 'claim') {
    const c = await x.store.claim(s.id);
    if (!c || c.status === 'superseded' || c.status === 'rejected') return null;
    const [meta] = await x.store.metas([c.docId]);
    const where = meta ? SOURCE_WORD[meta.kind] : 'a source';
    if (c.status !== 'accepted' || c.type === 'opinion') return `a statement from ${meta ? `a ${where}` : where} the developer has not accepted`;
    const who = c.speakerId ? await x.store.person(c.speakerId) : null;
    const when = (c.assertedAt ?? meta?.occurredAt ?? null)?.slice(0, 10);
    return `${who ? (who.isOwner ? 'the developer' : who.displayName) : 'someone'} (${[where, when].filter(Boolean).join(', ')}) says "${clip(c.statement)}"`;
  }
  if (s.kind === 'fact') {
    const f = await x.fact(s.id);
    return f?.current ? `fact ${f.id} says "${clip(f.statement)}"` : null;
  }
  const l = await x.lesson(s.id);
  if (!l || l.status === 'superseded' || l.status === 'rejected' || l.status === 'revoked') return null;
  return l.status === 'approved' ? `lesson ${l.id} says "${clip(l.rule)}"` : `lesson ${l.id}, not yet approved`;
}

/** One Disputed item per open conflict whose sides are both still there, in its own lines. */
export async function disputedItems(ks: Conflict[], x: IntakeContext | undefined): Promise<string[][]> {
  if (!x) return [];
  const out: string[][] = [];
  for (const k of ks) {
    const [a, b] = await Promise.all([sideWords(k.a, x), sideWords(k.b, x)]);
    if (a && b) out.push([`- Unresolved (${k.id}): ${a}; ${b}. Do not state either as settled; ask the developer which holds.`]);
  }
  return out;
}

export const DISPUTED_HEAD = '## Disputed (unresolved: the developer has not chosen which is true)';
