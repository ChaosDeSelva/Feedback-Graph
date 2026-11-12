import { redactSecrets } from '../../redact.ts';
import { factEmbeddingText } from '../../relevance.ts';
import type { DecisionTarget, FactKind, OwnFactOrigin, RelevanceBy, TargetSnapshot } from '../../types.ts';
import { ABSENT, changedError, TargetChangedError, UnsupportedTargetError, type FactSnapshotWrite, type LessonSnapshotFields, type LessonSnapshotWrite, type SupersedeLink } from '../record.ts';
import { snapshotKeys, snapshotOf, snapshotTarget, type DecisionExecStore } from '../snapshot.ts';
import type { DecisionTypeHandler, ExecDeps } from './handler.ts';

/** One target moved from one snapshot to another. */
export type Move = { target: DecisionTarget; from: TargetSnapshot; to: TargetSnapshot };

const lessonText = (f: LessonSnapshotFields) => redactSecrets(`${f.title}\n${f.rule}\nApplies when: ${f.appliesWhen}`);
const words = (f: Record<string, unknown>) => JSON.stringify([f.title, f.rule, f.appliesWhen]);

/** Lessons: one transaction, merges' SUPERSEDES edge with them; new words re-embedded when an embedder is given. */
async function writeLessons(s: DecisionExecStore, moves: Move[], keeper: string | undefined, deps: ExecDeps): Promise<void> {
  const writes: LessonSnapshotWrite[] = [];
  const supersede: SupersedeLink[] = [];
  const unsupersede: SupersedeLink[] = [];
  for (const m of moves) {
    if (m.from.fingerprint === ABSENT || m.to.fingerprint === ABSENT) throw new UnsupportedTargetError(m.target, m.from.fingerprint === ABSENT ? 'create' : 'remove');
    const fields = m.to.fields as LessonSnapshotFields;
    const embedding = deps.embed && words(m.from.fields) !== words(fields) ? (await deps.embed([lessonText(fields)]))[0] : undefined;
    writes.push({ id: m.target.id, fields, expect: m.from.fingerprint, ...(embedding && { embedding }) });
    if (m.target.role === 'merged' && keeper) {
      const was = m.from.fields.status === 'superseded';
      const is = fields.status === 'superseded';
      if (is && !was) supersede.push({ keeper, merged: m.target.id });
      if (was && !is) unsupersede.push({ keeper, merged: m.target.id });
    }
  }
  await s.knowledge.writeLessonSnapshots(writes, { supersede, unsupersede });
}

/** Facts: a fact created by the decision is added under its planned id; the rest move in one transaction. */
async function writeFacts(s: DecisionExecStore, moves: Move[], o: { by: string }, deps: ExecDeps): Promise<void> {
  const writes: FactSnapshotWrite[] = [];
  for (const m of moves) {
    const f = m.to.fields;
    if (m.to.fingerprint !== ABSENT && m.from.fingerprint === ABSENT && !(await s.facts.fact(m.target.id))) {
      if (!deps.embed) throw new UnsupportedTargetError(m.target, 'create without an embedder');
      // origin: a claim accept_claim files is origin claim (embedded from its statement alone); otherwise yours.
      const origin = f.origin as OwnFactOrigin | undefined;
      const [embedding] = await deps.embed([factEmbeddingText({ path: f.path as string, statement: f.statement as string, ...(origin && { origin }) })]);
      const by = (f.relevanceBy ?? o.by) as RelevanceBy;
      await s.facts.addOwnerFact(f.projectKey as string, {
        kind: f.kind as FactKind, statement: f.statement as string, path: f.path as string, lines: (f.lines as string | null) ?? null,
        confidence: 1, why: f.why as string, relevance: f.relevance as number | null, embedding,
      }, by, null, { id: m.target.id, ...(origin && { origin }) });
      continue;
    }
    // Closing keeps the fact's scores as they are; opening or rescoring sets them from the snapshot.
    const src = m.to.fingerprint === ABSENT ? m.from.fields : f;
    writes.push({ id: m.target.id, expect: m.from.fingerprint, fields: { relevance: (src.relevance as number | null) ?? null, relevanceBy: (src.relevanceBy as string | null) ?? null, current: m.to.fingerprint !== ABSENT } });
  }
  await s.facts.writeFactSnapshots(writes);
}

/**
 * Inbox items have no compare-and-set write: each is compared just before it is written. Triage is never applied on
 * its own (tier P), so the window is the owner's own click.
 */
async function expectNow(s: DecisionExecStore, m: Move): Promise<void> {
  const now = await snapshotTarget(s, m.target);
  if (now.fingerprint !== m.from.fingerprint) throw changedError(m.target.id, m.from.fingerprint, now);
}

async function writeCandidate(s: DecisionExecStore, m: Move, o: { by: string }): Promise<void> {
  await expectNow(s, m);
  const to = m.to.fields as { status: string; note: string | null; decidedBy: string | null };
  if (to.status === 'pending') {
    const c = (await s.graph.candidateDetail(m.target.id))!.candidate;
    // Reopening is possible only before any post-mortem work: after that the item is the post-mortem's.
    if (!(await s.graph.undoDecision?.(c.id, c.decidedAt!))) throw new TargetChangedError(c.id, m.from.fingerprint, m.from.fingerprint);
    return;
  }
  await s.graph.decide(m.target.id, to.status as 'confirmed' | 'rejected', to.note, to.decidedBy ?? o.by);
}

/** One kind's moves. */
async function writeKind(s: DecisionExecStore, kind: DecisionTarget['kind'], moves: Move[], o: { by: string; keeper?: string }, deps: ExecDeps) {
  if (kind === 'lesson') return writeLessons(s, moves, o.keeper, deps);
  if (kind === 'fact') return writeFacts(s, moves, o, deps);
  for (const m of moves) {
    if (kind !== 'candidate') throw new UnsupportedTargetError(m.target, 'write');
    await writeCandidate(s, m, o);
  }
}

/** Facts first (a record_fact's new fact), then Inbox items, lessons last. */
const ORDER: DecisionTarget['kind'][] = ['fact', 'miss', 'candidate', 'project', 'lesson'];

/**
 * Move every target the snapshots name from `from` to `to`, all or nothing: each kind is written with its `from`
 * fingerprint as `expect`, and when a later kind fails the kinds already written are moved back (expecting `to`)
 * before the error is rethrown. Targets whose two snapshots are the same are left alone. A target's role comes from
 * the decision's targets (a merge's keeper and merged).
 */
export async function moveTargets(s: DecisionExecStore, targets: DecisionTarget[], from: TargetSnapshot[], to: TargetSnapshot[], o: { by: string }, deps: ExecDeps = {}): Promise<void> {
  const named = snapshotKeys([...from, ...to]).map((k) => targets.find((t) => t.kind === k.kind && t.id === k.id) ?? { ...k, role: 'primary' as const });
  const moves = named.map((target) => ({ target, from: snapshotOf(from, target), to: snapshotOf(to, target) })).filter((m) => m.from.fingerprint !== m.to.fingerprint);
  // A merge's keeper may itself be unchanged (the duplicate's paths already its own): the edge is still the keeper's.
  const w = { by: o.by, keeper: targets.find((t) => t.role === 'keeper')?.id };
  const done: Move[][] = [];
  for (const kind of ORDER) {
    const group = moves.filter((m) => m.target.kind === kind);
    if (!group.length) continue;
    try {
      await writeKind(s, kind, group, w, deps);
    } catch (error) {
      for (const back of done.reverse()) await writeKind(s, back[0].target.kind, back.map((m) => ({ ...m, from: m.to, to: m.from })), w, deps);
      throw error;
    }
    done.push(group);
  }
}

/**
 * The built-in handler, for every type without its own: lessons' fingerprinted fields (approve, reject, retire, narrow,
 * reword; a merge's keeper and merged with its SUPERSEDES edge), facts' relevance and a record_fact's new fact, and
 * Inbox items (triage). Targets are the kinds and ids `before` and `after` name.
 */
export const genericHandler: DecisionTypeHandler = {
  apply: (c, d) => moveTargets(c.store, d.targets, d.before, d.after, c, c.deps),
  rollback: (c, d, from) => moveTargets(c.store, d.targets, from, d.before, c, c.deps),
};
