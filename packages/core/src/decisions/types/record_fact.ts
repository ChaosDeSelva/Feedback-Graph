import type { Decision, DecisionTarget, FactKind, RelevanceBy } from '../../types.ts';
import { ABSENT, factStateFingerprint, UnsupportedTargetError } from '../record.ts';
import { snapshotOf } from '../snapshot.ts';
import { genericHandler } from './generic.ts';
import type { DecisionTypeHandler, HandlerContext } from './handler.ts';

/** Add the fact `t` as `d.after` has it, the loop's (origin loop: no scan closes or replaces it), under its planned id. */
async function addLoopFact(c: HandlerContext, d: Decision, t: DecisionTarget): Promise<void> {
  if (!c.deps.embed) throw new UnsupportedTargetError(t, 'create without an embedder');
  const f = snapshotOf(d.after, t).fields;
  const [embedding] = await c.deps.embed([`${f.path}: ${f.statement}`]);
  await c.store.facts.addOwnerFact(f.projectKey as string, {
    kind: f.kind as FactKind, statement: f.statement as string, path: f.path as string, lines: (f.lines as string | null) ?? null,
    confidence: 1, why: f.why as string, relevance: f.relevance as number | null, embedding,
  }, (f.relevanceBy ?? c.by) as RelevanceBy, null, { id: t.id, origin: 'loop' });
}

/**
 * record_fact: a fact the decision creates (ABSENT before, never stored) is added as the loop's (origin loop, relevance
 * by `loop:<v>`), then everything else is the generic write: the converted lesson rejected, compare-and-set. When that
 * fails the new fact is closed again. A redo finds the fact stored (closed by the rollback) and the generic write
 * reopens it. Rolling back is the generic one: the fact closed (current false, validTo), the lesson restored.
 */
export const recordFact: DecisionTypeHandler = {
  async apply(c, d) {
    const made: DecisionTarget[] = [];
    for (const t of d.targets.filter((x) => x.kind === 'fact')) {
      if (snapshotOf(d.before, t).fingerprint !== ABSENT || (await c.store.facts.fact(t.id))) continue;
      await addLoopFact(c, d, t);
      made.push(t);
    }
    // The facts just added are as `after` says: the generic write moves the rest.
    const isMade = (x: Pick<DecisionTarget, 'kind' | 'id'>) => made.some((t) => t.kind === x.kind && t.id === x.id);
    const before = [...d.before.filter((b) => !isMade(b)), ...made.map((t) => snapshotOf(d.after, t))];
    try {
      await genericHandler.apply(c, { ...d, before });
    } catch (error) {
      for (const t of made) {
        const now = await c.store.facts.fact(t.id);
        await c.store.facts.writeFactSnapshots([{ id: t.id, expect: factStateFingerprint(now), fields: { relevance: now!.relevance, relevanceBy: now!.relevanceBy, current: false } }]);
      }
      throw error;
    }
  },
  rollback: genericHandler.rollback,
};
