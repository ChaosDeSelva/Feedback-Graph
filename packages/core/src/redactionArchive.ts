import { authorizeStoreWrite } from './storeWrites.ts';
import { createHash } from 'node:crypto';
/** Local-only archive hook: adapters await it BEFORE mutating stored originals. */
import { REDACTION_VERSION } from './redact.ts';
export type ArchiveSelector = { kind: string; id: string };
/** Shared exact encoding for lifecycle identities; never apply database text normalization to archive identity. */
export const archiveRunFileSelector = (run: string, project: string, path: string): ArchiveSelector => ({ kind: 'run-file', id: JSON.stringify([run, project, path]) });
export type RedactionOriginal = { kind: string; id: string; version: number; value: unknown; scope?: ArchiveSelector[] };
let forget: ((selectors: ArchiveSelector[]) => Promise<unknown>) | undefined;
export const setRedactionArchivePurger = (purger: typeof forget): void => { forget = purger; };
export async function purgeRedactionOriginals(selectors: ArchiveSelector[]): Promise<void> { if (forget && selectors.length) { await authorizeStoreWrite(); await forget(selectors); } }
let archive: ((record: RedactionOriginal) => Promise<void>) | undefined;
export function setRedactionArchive(writer: ((record: RedactionOriginal) => Promise<void>) | undefined): void { archive = writer; }
export async function archiveBeforeRedaction(kind: string, id: string, value: unknown, scope?: ArchiveSelector[]): Promise<void> {
  if (!archive) return;
  await authorizeStoreWrite();
  await archive({ kind, id, value, scope, version: REDACTION_VERSION });
}

/** Archive only incoming values that redaction actually changes; content identity preserves successive edits. */
export async function archiveRedactionInput(kind: string, key: string, original: unknown, redacted: unknown, scope?: ArchiveSelector[]): Promise<void> {
  if (!archive) return;
  const raw = JSON.stringify(original);
  if (raw === JSON.stringify(redacted)) return;
  const hash = createHash('sha256').update(scope?.length ? JSON.stringify([original, scope]) : raw).digest('hex');
  await archiveBeforeRedaction(`${kind}-incoming`, `${key}:${hash}`, original, scope);
}
