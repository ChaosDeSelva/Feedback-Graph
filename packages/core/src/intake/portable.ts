/**
 * Knowledge intake in an export bundle (0.9.1, design §7): the claims you decided (accepted, or superseded by a
 * conflict you settled), the conflicts you settled or dismissed, and the people who said those claims. Never a source's
 * text, a question or an open conflict, and a claim's quote only when asked for (GET /api/export?quotes=1). Read
 * through IntakeStore, so both backends export the same.
 */
import type { IntakeStore } from '../store.ts';
import type { Claim, Conflict, ConflictChoice, ConflictDismissReason, ConflictKind, IntakeRef, Person } from '../types.ts';
import { FORGOTTEN_NAME } from './records.ts';

/** A claim as exported: what was said, by whom (a person id of `people`), when; its quote only with quotes=1. */
export type ExportedClaim = Pick<Claim, 'id' | 'projectKey' | 'docId' | 'type' | 'statement' | 'speakerId' | 'assertedAt' | 'confidence' | 'scope' | 'about' | 'due' | 'status' | 'decidedAt'>
  & { speaker: string | null; quote?: string };
/** A settled conflict: its sides (the winner and the loser for a or b), how it was settled and when. */
export type ExportedConflict = {
  id: string; kind: ConflictKind; status: 'resolved' | 'dismissed'; projectKey: string | null; a: IntakeRef; b: IntakeRef;
  resolution: { choice: ConflictChoice; note: string | null; reason: ConflictDismissReason | null }; resolvedAt: string | null;
};
/** Someone who said an exported claim: a display name only, never aliases. */
export type ExportedPerson = Pick<Person, 'id' | 'displayName' | 'isOwner'>;
export type IntakeExport = { claims: ExportedClaim[]; conflicts: ExportedConflict[]; people: ExportedPerson[] };

const PAGE = 1000;
/** A bundle's ceiling per kind (the importer's too). */
export const INTAKE_EXPORT_MAX = 50_000;

async function paged<T>(read: (offset: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; out.length < INTAKE_EXPORT_MAX; offset += PAGE) {
    const page = await read(offset);
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out.slice(0, INTAKE_EXPORT_MAX);
}

/** The intake part of an export of these projects (null: every project) and the global records. No run's or sandbox's. */
export async function intakeExport(s: Pick<IntakeStore, 'listClaims' | 'listConflicts' | 'person'>, o: { projectKeys: string[] | null; quotes: boolean }): Promise<IntakeExport> {
  const scope = o.projectKeys ? { projectKeys: o.projectKeys } : {};
  const claims = (await paged((offset) => s.listClaims({ status: ['accepted', 'superseded'], ...scope, limit: PAGE, offset }))).filter((c) => !c.run && !c.sandbox);
  const conflicts = (await paged((offset) => s.listConflicts({ status: ['resolved', 'dismissed'], ...scope, limit: PAGE, offset }))).filter((k): k is Conflict & { resolution: NonNullable<Conflict['resolution']> } => !k.run && !k.sandbox && !!k.resolution);
  const people = new Map<string, ExportedPerson | null>();
  for (const id of new Set(claims.map((c) => c.speakerId).filter((x): x is string => !!x))) {
    const p = await s.person(id);
    people.set(id, p && p.status !== 'forgotten' && p.displayName !== FORGOTTEN_NAME ? { id: p.id, displayName: p.displayName, isOwner: p.isOwner } : null);
  }
  return {
    claims: claims.map((c) => {
      const who = c.speakerId ? people.get(c.speakerId) ?? null : null;
      return {
        id: c.id, projectKey: c.projectKey, docId: c.docId, type: c.type, statement: c.statement, speakerId: who?.id ?? null, speaker: who?.displayName ?? null,
        assertedAt: c.assertedAt, confidence: c.confidence, scope: c.scope, about: c.about, due: c.due, status: c.status, decidedAt: c.decidedAt,
        ...(o.quotes && { quote: c.quote }),
      };
    }),
    conflicts: conflicts.map((k) => ({
      id: k.id, kind: k.kind, status: k.status as 'resolved' | 'dismissed', projectKey: k.projectKey, a: { kind: k.a.kind, id: k.a.id }, b: { kind: k.b.kind, id: k.b.id },
      resolution: { choice: k.resolution.choice, note: k.resolution.note, reason: k.resolution.reason }, resolvedAt: k.resolvedAt,
    })),
    people: [...people.values()].filter((p): p is ExportedPerson => !!p).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
