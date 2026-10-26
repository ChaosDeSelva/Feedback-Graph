import type { ActivityStore, DocsStore, KnowledgeStore } from '@fb/core';

/**
 * Who decided a lesson (ownerDecided, core/lessonOutcome.ts). Version 1: only the owner's decisions (you, an operator)
 * mark a lesson as yours; before it, every decision did, a machine's too (the post-mortem's no-miss rejection, the
 * session re-match). A rule change migrates its data: at start, once per version, lessons a machine decided that still
 * carry the mark lose it (KnowledgeStore.clearMachineOwnerMarks), and what changed is logged and in Activity.
 */
export const DECIDER_RULE_VERSION = 1;
export const DECIDER_RULE_CURSOR = 'lesson-decider';
const MAX_TARGETS = 200;

export type DeciderRuleDeps = {
  knowledge: Partial<Pick<KnowledgeStore, 'clearMachineOwnerMarks'>>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
};

/** At worker start. Null: it has run for this version, or the store cannot tell. */
export async function migrateDeciderRule(d: DeciderRuleDeps): Promise<{ cleared: number } | null> {
  const stamp = `v${DECIDER_RULE_VERSION}`;
  if (!d.knowledge.clearMachineOwnerMarks) return null;
  const last = await d.cursors.getCursor(DECIDER_RULE_CURSOR);
  if (last === stamp) return null;
  const ids = await d.knowledge.clearMachineOwnerMarks();
  if (ids.length) {
    await d.activity?.record({
      kind: 'lessons_checked', actor: 'lesson-decider', projectKey: null,
      subject: `${ids.length} lesson${ids.length === 1 ? '' : 's'} decided by a machine no longer count as yours`,
      why: "only your decisions (and an operator's) mark a lesson as yours: a post-mortem's no-miss rejection or the session re-match did too before, so a memory file's re-import skipped them; your counts and the writer's examples never included them",
      details: { rule: stamp, cleared: ids.length },
      targets: ids.slice(0, MAX_TARGETS),
    });
    d.log?.('machine decisions no longer marked as yours', { cleared: ids.length, rule: stamp });
  }
  await d.cursors.setCursor(DECIDER_RULE_CURSOR, stamp);
  return { cleared: ids.length };
}
