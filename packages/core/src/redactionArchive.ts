import { createHash } from 'node:crypto';
/** Local-only archive hook: adapters await it BEFORE mutating stored originals. */
import { REDACTION_VERSION } from './redact.ts';
export type RedactionOriginal = { kind: string; id: string; version: number; value: unknown };
let archive: ((record: RedactionOriginal) => Promise<void>) | undefined;
export function setRedactionArchive(writer: ((record: RedactionOriginal) => Promise<void>) | undefined): void { archive = writer; }
export async function archiveBeforeRedaction(kind: string, id: string, value: unknown): Promise<void> {
  await archive?.({ kind, id, value, version: REDACTION_VERSION });
}

/** Archive only incoming values that redaction actually changes; content identity preserves successive edits. */
export async function archiveRedactionInput(kind: string, key: string, original: unknown, redacted: unknown): Promise<void> {
  if (!archive) return;
  const raw = JSON.stringify(original);
  if (raw === JSON.stringify(redacted)) return;
  const hash = createHash('sha256').update(raw).digest('hex');
  await archiveBeforeRedaction(`${kind}-incoming`, `${key}:${hash}`, original);
}
