import { missLinkSnapshot, type DecisionsStore } from '@fb/core';
import type { LoopExecutor } from '../executor.ts';

/**
 * A LoopExecutor for link_misses alone, over the DecisionsStore methods memoryStore models: the engine's unit tests
 * use it where the core loopExecutor would need a whole store.
 */
export function decisionsStoreExecutor(decisions: Pick<DecisionsStore, 'markApplying' | 'markApplied' | 'markStatus' | 'get' | 'linkMisses' | 'missLinks'>): LoopExecutor {
  return {
    async apply(d, o) {
      if (d.type !== 'link_misses') throw new Error(`no executor for ${d.type} decisions`);
      if (!(await decisions.markApplying(d.id))) return { status: 'lost' };
      const { from, to } = d.before[0].fields as { from: string; to: string };
      if (!(await decisions.linkMisses({ from, to, decisionId: d.id }))) {
        await decisions.markStatus(d.id, { status: 'overridden', from: ['applying'] });
        return { status: 'changed', reason: 'the link exists already, or a miss is gone' };
      }
      await decisions.markApplied(d.id, [missLinkSnapshot(from, to, true)], { syncHoldUntil: o.syncHoldUntil });
      return { status: 'applied', decision: (await decisions.get(d.id))! };
    },
    async changed(d) {
      const { from, to } = d.before[0].fields as { from: string; to: string };
      return (await decisions.missLinks(from)).some((l) => l.from === from && l.to === to) ? null : `the link from ${from} to ${to} is gone`;
    },
  };
}
