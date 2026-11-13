import type { ActivityStore, DocsStore, GraphStore } from '@fb/core';

export const GIVEN_UP_CURSOR = 'classify-given-up';

export type RequeueGivenUpDeps = {
  /** The classifier's provider id (`ollama:gemma4`); unset when none could be built, and then nothing is re-queued. */
  classifierId?: string;
  version: string;
  queue: Pick<GraphStore, 'requeueGivenUpTurns'>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
};

/**
 * At worker start: turns the classifier gave up on get their attempts back once the classifier or this version
 * differs from the one that gave up (a new model or prompt may read them), so they never sit stuck for good. Returns
 * how many were re-queued, null when the pair has not changed.
 */
export async function requeueGivenUpOnClassifierChange(d: RequeueGivenUpDeps): Promise<number | null> {
  if (!d.classifierId) return null;
  const stamp = `${d.classifierId}@${d.version}`;
  const last = await d.cursors.getCursor(GIVEN_UP_CURSOR);
  if (last === stamp) return null;
  const requeued = await d.queue.requeueGivenUpTurns();
  if (requeued) {
    await d.activity?.record({
      kind: 'turns_requeued', actor: 'classifier', projectKey: null,
      subject: `re-queued ${requeued} turn${requeued === 1 ? '' : 's'} the classifier had given up on`,
      why: last ? `the classifier changed (${last} to ${stamp})` : `first start with ${stamp} recording its classifier`,
      details: { requeued, from: last, to: stamp },
      targets: [],
    });
    d.log?.('re-queued turns the classifier had given up on', { requeued, from: last, to: stamp });
  }
  await d.cursors.setCursor(GIVEN_UP_CURSOR, stamp);
  return requeued;
}
