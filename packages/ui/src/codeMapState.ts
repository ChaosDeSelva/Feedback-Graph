import type { CodeMapMeta, SystemStatus } from './api.ts';
import { ago } from './ui/display.tsx';

export type MapStatus = NonNullable<SystemStatus['codeMaps']>[number];

/**
 * The one description of a project's code map state, used by the Code map card (and worded like the worker's Activity
 * entry): /api/status says whether a rebuild is running now (its worker is alive) or was cut short; the map's own meta
 * says when it last failed and why. null: the map is current.
 */
export function codeMapState(meta: CodeMapMeta, status: MapStatus | null | undefined, now = Date.now()): { tone: 'info' | 'bad'; line: string; next: string | null } | null {
  // No build time: the first build never finished, so there is no older map to keep using.
  const built = meta.builtAt && `The map built ${ago(meta.builtAt, now)}`;
  const kept = (until: string) => (built ? `${built} stays in use ${until}.` : 'There is no map until a build finishes.');
  if (status?.rebuilding) return { tone: 'info', line: built ? `Rebuilding now. ${kept('until the new one is written')}` : 'Building the first map now.', next: null };
  if (meta.lastFailureAt) {
    return {
      tone: 'bad',
      line: `The last ${built ? 'rebuild' : 'build'} failed ${ago(meta.lastFailureAt, now)}: ${meta.lastFailure ?? 'see Activity for details'}. ${kept('until a rebuild succeeds')}`,
      next: rebuildFailureStep(meta.lastFailure ?? null),
    };
  }
  if (status?.interrupted || (!status && meta.fingerprint === null && !meta.writingAt)) {
    return { tone: 'bad', line: `The last ${built ? 'rebuild' : 'build'} stopped part way (the worker stopped while writing it). ${built ? `${built} stays in use; the` : 'The'} worker rebuilds it from scratch at its next pass.`, next: 'Rebuild map retries it now.' };
  }
  return null;
}

/** What to do about a failed rebuild, from its error: the store's own messages (Neo4j's especially) name no fix. */
export function rebuildFailureStep(error: string | null): string {
  const e = error ?? '';
  if (/MemoryPoolOutOfMemory|transaction(?:al)? memory|memory pool/i.test(e)) {
    return 'Neo4j ran out of transaction memory: raise NEO4J_TRANSACTION_MAX (and NEO4J_TRANSACTION_TOTAL_MAX and NEO4J_TRANSACTION_DATABASE_MAX with it) in .env, run docker compose up -d, then Rebuild map. docs/operations.md lists the memory settings.';
  }
  if (/ServiceUnavailable|SessionExpired|ECONNREFUSED|ECONNRESET|connection (?:refused|reset)|could not perform discovery/i.test(e)) {
    return 'The graph store was unreachable: run ./scripts/doctor.sh (docker compose ps shows whether neo4j is up), then Rebuild map.';
  }
  if (/TransientError|Deadlock|timed? ?out|deadline/i.test(e)) return 'A temporary store error: Rebuild map to retry now.';
  return 'Rebuild map to retry now; if it fails again, run ./scripts/doctor.sh and read docker compose logs worker.';
}
