/**
 * Knowledge intake records as both stores keep them: ids, fingerprints, alias normalisation and the redaction every
 * text gets at the door. Pure: no store, no model.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../decisions/record.ts';
import { redactDeep, redactIntakeText, redactSecrets } from '../redact.ts';
import type { Claim, ClaimDraft, Conflict, ConflictInput, IntakeRef, Question, QuestionDraft } from '../types.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const pad = (n: number) => String(n).padStart(4, '0');

/**
 * A window's claims and questions are numbered within the upload (`version`), so saving the same window again names
 * the same records, and a new upload of the document names new ones beside those already decided.
 */
const windowKey = (docId: string, version: string, window: number, n: number) => `${docId}@${sha256(version).slice(0, 8)}#${pad(window)}.${pad(n)}`;
export const claimIdOf = (docId: string, version: string, window: number, n: number) => `claim:${windowKey(docId, version, window, n)}`;
export const questionIdOf = (docId: string, version: string, window: number, n: number) => `question:${windowKey(docId, version, window, n)}`;
/** A question added on its own (a contradiction inside one source): named by its source and text. */
export const addedQuestionIdOf = (docId: string, text: string) => `question:${docId}#x.${sha256(text).slice(0, 16)}`;
/** The owner's answer to a question: one per question, so answering again replaces it. */
export const answerSourceOf = (questionId: string) => `answer:${questionId}`;
export const answerClaimIdOf = (questionId: string) => `claim:${answerSourceOf(questionId)}`;
/** One conflict per pair, whichever side is `a`: finding the pair again finds it. */
export const conflictIdOf = (a: IntakeRef, b: IntakeRef) => `conflict:${sha256([`${a.kind}:${a.id}`, `${b.kind}:${b.id}`].sort().join('|')).slice(0, 32)}`;

/** What a forgotten Person is shown as. */
export const FORGOTTEN_NAME = 'former participant';
/** What a claim_decided Activity entry says once its claim is deleted: its statement leaves with it. */
export const REMOVED_CLAIM = 'a claim since removed';

/**
 * A name as aliases are matched: case, diacritics, punctuation and spacing ignored, "Last, First" read as "First Last".
 * Empty when nothing is left.
 */
export function aliasNorm(name: string): string {
  let s = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  const parts = s.split(',');
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) s = `${parts[1]} ${parts[0]}`;
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The claim fields a decision changes and a rollback restores: one changed since the snapshot fails its `expect`. */
export const CLAIM_FINGERPRINT_FIELDS = ['status', 'statement', 'type', 'scope', 'factId'] as const;
/** The conflict fields the same way. */
export const CONFLICT_FINGERPRINT_FIELDS = ['status', 'resolution'] as const;
/** The question fields a decision changes (assign_question, close_question) and a rollback restores. */
export const QUESTION_FINGERPRINT_FIELDS = ['status', 'assignee', 'answerClaimId'] as const;
const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
export const claimFingerprint = (c: Pick<Claim, 'id' | (typeof CLAIM_FINGERPRINT_FIELDS)[number]>): string =>
  sha256(canonicalJson(['claim', c.id, pick(c, CLAIM_FINGERPRINT_FIELDS)]));
export const questionFingerprint = (q: Pick<Question, 'id' | (typeof QUESTION_FINGERPRINT_FIELDS)[number]>): string =>
  sha256(canonicalJson(['question', q.id, pick(q, QUESTION_FINGERPRINT_FIELDS)]));
export const conflictFingerprint = (c: Pick<Conflict, 'id' | (typeof CONFLICT_FINGERPRINT_FIELDS)[number]>): string =>
  sha256(canonicalJson(['conflict', c.id, pick(c, CONFLICT_FINGERPRINT_FIELDS)]));

/** The claim fields a snapshot write sets (IntakeStore.writeSnapshots). */
export type ClaimSnapshotFields = Pick<Claim, 'status' | 'statement' | 'type' | 'scope' | 'decidedBy' | 'decidedAt' | 'factId'>;
/** The conflict fields a snapshot write sets. */
export type ConflictSnapshotFields = Pick<Conflict, 'status' | 'resolution' | 'resolvedBy' | 'resolvedAt' | 'decisionId'>;
/** One claim or conflict set to `fields` while its fingerprint still reads `expect`. */
export type IntakeSnapshotWrite =
  | { kind: 'claim'; id: string; fields: ClaimSnapshotFields; expect: string }
  | { kind: 'conflict'; id: string; fields: ConflictSnapshotFields; expect: string };

/** IntakeStore.decideClaim's change: only the keys given. A status change records who decided and when. */
export type ClaimPatch = Partial<Pick<Claim, 'status' | 'statement' | 'type' | 'scope' | 'about' | 'factId'>> & { embedding?: number[] | null };
/** IntakeStore.updateQuestion's change: only the keys given (assignee null unassigns; answerClaimId: the claim answering it). */
export type QuestionPatch = Partial<Pick<Question, 'status' | 'assignee' | 'answerClaimId'>>;
/** IntakeStore.updatePerson's change. */
export type PersonPatch = { displayName?: string; status?: 'proposed' | 'confirmed'; addAliases?: string[]; removeAliases?: string[] };

/**
 * A claim from an export bundle (IntakeStore.importClaims): kept under its id, with its status, its source's id (the
 * source itself is never exported, so it is not there) and who decided it.
 */
export type ImportedClaim = Pick<Claim, 'id' | 'projectKey' | 'docId' | 'type' | 'statement' | 'quote' | 'speakerId' | 'assertedAt' | 'confidence' | 'scope' | 'about' | 'due' | 'status' | 'decidedAt' | 'factId'>
  & { embedding: number[] | null; decidedBy: string };

/** The owner's answer to a question, stored as an accepted claim. */
export type AnswerInput = Pick<Claim, 'statement' | 'type' | 'speakerId' | 'scope' | 'about'> & { embedding: number[] | null };

/** IntakeStore.listClaims. projectKeys: these projects' claims and global ones. run: sandbox claims only to their run. */
export type ClaimFilter = {
  ids?: string[]; status?: Claim['status'][]; type?: Claim['type'][]; projectKeys?: string[]; docId?: string; speakerId?: string;
  run?: string | null; limit?: number; offset?: number;
};
export type QuestionFilter = {
  ids?: string[]; status?: Question['status'][]; kind?: Question['kind'][]; projectKeys?: string[]; docId?: string; assignee?: string;
  run?: string | null; limit?: number; offset?: number;
};
export type ConflictFilter = {
  ids?: string[]; status?: Conflict['status'][]; kind?: Conflict['kind'][]; projectKeys?: string[]; run?: string | null; limit?: number; offset?: number;
};
/** IntakeStore.searchClaims. status: default accepted only. */
export type ClaimSearch = {
  embedding: number[]; k: number; projectKeys?: string[]; status?: Claim['status'][]; type?: Claim['type'][]; speakerId?: string; run?: string | null;
};
export type ClaimHit = { claim: Claim; score: number };

/** A window's save (IntakeStore.saveWindow). version: the upload's (DocToRead.version), so a replaced one is refused. */
export type WindowSave = { window: number; version: string; total?: number | null; claims: ClaimDraft[]; questions: QuestionDraft[] };
/** What a run left in intake (IntakeStore.runItems). */
export type IntakeRunItem = { kind: 'claim' | 'question' | 'conflict'; id: string; projectKey: string | null; sandbox: boolean };
export type IntakeRemoved = { claim: number; question: number; conflict: number };

/** An alias belongs to another person: merge them instead. */
export class AliasTakenError extends Error {
  readonly alias: string;
  readonly personId: string;
  constructor(alias: string, personId: string) {
    super(`the alias "${alias}" belongs to ${personId}: merge the two people instead`);
    this.name = 'AliasTakenError';
    this.alias = alias;
    this.personId = personId;
  }
}

/** Texts from a source are what people said: credentials and contact details redacted (redactIntakeText) before either store keeps them. */
export const cleanClaimDraft = (d: ClaimDraft): ClaimDraft => ({
  ...d, statement: redactIntakeText(d.statement), quote: redactIntakeText(d.quote), about: redactIntakeText(d.about),
  due: d.due === null ? null : redactIntakeText(d.due),
  scope: { area: d.scope.area === null ? null : redactIntakeText(d.scope.area), files: d.scope.files.map(redactSecrets) },
});
export const cleanQuestionDraft = (q: QuestionDraft): QuestionDraft => ({ ...q, text: redactIntakeText(q.text), quote: q.quote === null ? null : redactIntakeText(q.quote) });
export const cleanConflictInput = (c: ConflictInput): ConflictInput => ({
  ...c,
  signals: redactDeep(c.signals),
  judge: c.judge && { ...c.judge, aQuote: redactIntakeText(c.judge.aQuote), bQuote: redactIntakeText(c.judge.bQuote), explanation: redactIntakeText(c.judge.explanation) },
});
export const cleanResolution = (r: Conflict['resolution']): Conflict['resolution'] => r && { ...r, note: r.note === null ? null : redactIntakeText(r.note) };

/** What IntakeStore.redactStoredIntake changed: sources (a title or chunk), claims and questions written. */
export type IntakeRedacted = { sources: number; claims: number; questions: number };
