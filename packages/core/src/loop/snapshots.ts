import { createHash } from 'node:crypto';
import { canonicalJson } from '../decisions/record.ts';
import type { ProjectThresholds, TargetSnapshot } from '../types.ts';

/**
 * A link_misses target: the (:Miss)-[:REPEATS]->(:Miss) link from the repeat to the miss it repeats, present or not.
 * The snapshot's id is the repeat's (the decision's primary target); the fingerprint covers both ends and the state, so
 * a rollback can tell the link it made from one made or removed since.
 */
export function missLinkSnapshot(from: string, to: string, linked: boolean): TargetSnapshot {
  const fields = { from, to, linked };
  return { kind: 'miss', id: from, fields, fingerprint: createHash('sha256').update(canonicalJson(['miss-link', fields])).digest('hex') };
}

/**
 * A tune_threshold target: a project's own floors (null: the default). The fingerprint covers the project and both
 * floors, so a write or rollback refuses floors changed since.
 */
export function thresholdsSnapshot(projectKey: string, t: ProjectThresholds): TargetSnapshot {
  const fields = { similarityFloor: t.similarityFloor, factRankFloor: t.factRankFloor };
  return { kind: 'project', id: projectKey, fields, fingerprint: createHash('sha256').update(canonicalJson(['project-thresholds', projectKey, fields])).digest('hex') };
}

