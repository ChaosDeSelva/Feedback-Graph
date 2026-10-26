import type { ActivityStore, DocsStore, KnowledgeStore, UnsortedMiss } from '@fb/core';
import { isProcessMiss } from '../detect/instruction.ts';

/**
 * The process-miss rule (detect/instruction.ts isProcessMiss) runs once per version over the misses saved before it, so
 * a rule change migrates its data: an old miss about a branch, a merge or a pull request stops being "the last miss
 * here" on every file its session edited, and a process miss the rule no longer calls one (an earlier, broader rule
 * marked "This PR breaks login on token expiry") gets its subject back, so it is on those files again: a miss's files
 * are read from its session (codegraph), never stored on it. Lessons are left as they are.
 */
export type MissSubjectDeps = {
  knowledge: Pick<KnowledgeStore, 'missesWithoutSubject' | 'processMisses' | 'setMissSubject'>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
};

/**
 * Bump when isProcessMiss changes. 1: feedback and lesson both about git, not a comment on a file. 2: and neither
 * names a file or code behaviour, and the lesson has no paths; process misses that fail it are restored. 3: feedback
 * that is wholly an instruction about git ("don't push a PR yet") is one too, whatever its lesson's paths or rule.
 */
export const MISS_SUBJECT_VERSION = 3;
export const MISS_SUBJECT_CURSOR = 'misses-subject';
const PAGE = 500;
const MAX_TARGETS = 50;

async function eachPage(list: (q: { limit: number; afterId?: string | null }) => Promise<UnsortedMiss[]>, fn: (m: UnsortedMiss) => Promise<void>) {
  let after: string | null = null;
  for (;;) {
    const page = await list({ limit: PAGE, afterId: after });
    for (const m of page) await fn(m);
    if (page.length < PAGE) break;
    after = page[page.length - 1].missId;
  }
}

/**
 * At worker start: restores the process misses the rule no longer calls one, then marks the misses it does. Returns
 * how many of each, or null when this version already ran. Restoring runs whatever ran before: the post-mortem marked
 * new misses with the same earlier rule.
 */
export async function sortOldMisses(d: MissSubjectDeps): Promise<{ marked: number; restored: number } | null> {
  const stamp = `v${MISS_SUBJECT_VERSION}`;
  if ((await d.cursors.getCursor(MISS_SUBJECT_CURSOR)) === stamp) return null;
  const restored = new Map<string, string[]>();
  await eachPage((q) => d.knowledge.processMisses(q), async (m) => {
    if (isProcessMiss(m) || !(await d.knowledge.setMissSubject(m.missId, null))) return;
    restored.set(m.projectKey, [...(restored.get(m.projectKey) ?? []), m.missId]);
  });
  const marked = new Map<string, string[]>();
  await eachPage((q) => d.knowledge.missesWithoutSubject(q), async (m) => {
    if (!isProcessMiss(m) || !(await d.knowledge.setMissSubject(m.missId, 'process'))) return;
    marked.set(m.projectKey, [...(marked.get(m.projectKey) ?? []), m.missId]);
  });
  let restoredTotal = 0;
  for (const [projectKey, ids] of restored) {
    restoredTotal += ids.length;
    await d.activity?.record({
      kind: 'misses_reclassified', actor: 'deterministic', projectKey,
      subject: `${ids.length} past miss${ids.length === 1 ? '' : 'es'} marked as about the process ${ids.length === 1 ? 'is' : 'are'} about the code: tied to ${ids.length === 1 ? 'its' : 'their'} files again`,
      why: `the process-miss rule (v${MISS_SUBJECT_VERSION}) no longer counts feedback that names a file or code behaviour, or a lesson with paths`,
      details: { subject: null, count: ids.length, version: MISS_SUBJECT_VERSION },
      targets: ids.slice(0, MAX_TARGETS),
    });
  }
  let markedTotal = 0;
  for (const [projectKey, ids] of marked) {
    markedTotal += ids.length;
    await d.activity?.record({
      kind: 'misses_reclassified', actor: 'deterministic', projectKey,
      subject: `${ids.length} past miss${ids.length === 1 ? '' : 'es'} about branches, merges or pull requests ${ids.length === 1 ? 'is' : 'are'} no longer tied to files`,
      why: `process misses (rule v${MISS_SUBJECT_VERSION}) are about how the work was handled, not the code the session edited; an instruction about git ("don't push a PR yet") is one whatever files its lesson names`,
      details: { subject: 'process', count: ids.length, version: MISS_SUBJECT_VERSION },
      targets: ids.slice(0, MAX_TARGETS),
    });
  }
  if (markedTotal || restoredTotal) d.log?.('process-miss rule applied to past misses', { marked: markedTotal, restored: restoredTotal });
  await d.cursors.setCursor(MISS_SUBJECT_CURSOR, stamp);
  return { marked: markedTotal, restored: restoredTotal };
}
