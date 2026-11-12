import { readdirSync, readFileSync } from 'node:fs';
import { ACTIVITY_KINDS, CLAIM_LINK_RELS, CLAIM_STATUSES, CLAIM_TYPES, CONFLICT_KINDS, CONFLICT_SIDE_KINDS, CONFLICT_STATUSES, INTAKE_FORMATS, INTAKE_KINDS, PERSON_STATUSES, QUESTION_KINDS, QUESTION_STATUSES, DECISION_MODES, DECISION_NOTE_REASONS, DECISION_STATUSES, DECISION_TARGET_KINDS, DECISION_TARGET_ROLES, DECISION_TIERS, DECISION_TYPES, DECISION_AUTHORS, LOOP_DECISION_TYPES, CAUSES, CHAT_PROVIDERS, CHAT_TURN_STATUSES, FACT_EVIDENCE, FACT_KINDS, FACT_ORIGINS, RUN_PRINCIPALS, SESSION_STATES, SYMBOL_KINDS, TURN_LABELS, type CandidateStatus, type FeedbackSource, type ContextKind, type DocSource, type FeedbackStatus, type LessonScope, type LessonSource, type LessonStatus, type Outcome, type ScanStatus } from '@fb/core';
import { expect, test } from 'vitest';
import { renderMigration } from './migrate.ts';

const dir = new URL('../migrations/', import.meta.url);
const sql = readFileSync(new URL('0001_init.sql', dir), 'utf8');
/** Every migration in order: a later one may redefine a constraint. */
const allSql = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');

/** The values a named CHECK (column IN (...)) constraint allows, as its latest migration defines it. */
function allowed(constraint: string): string[] {
  const m = [...allSql.matchAll(new RegExp(`CONSTRAINT ${constraint}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`, 'g'))].at(-1);
  if (!m) throw new Error(`no CHECK constraint ${constraint}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

/** Every member of a string union, checked at compile time: a value missing from the list fails typecheck. */
const all = <T extends string>() => <const L extends readonly T[]>(list: [T] extends [L[number]] ? L : never) => [...list].sort();

test('CHECK constraints allow exactly the values the TypeScript types allow (adding one needs a migration)', () => {
  expect(allowed('facts_kind_check')).toEqual([...FACT_KINDS].sort());
  expect(allowed('code_symbols_kind_check')).toEqual([...SYMBOL_KINDS].sort());
  expect(allowed('activity_kind_check')).toEqual([...ACTIVITY_KINDS].sort());
  expect(allowed('misses_cause_check')).toEqual([...CAUSES].sort());
  expect(allowed('lessons_cause_check')).toEqual([...CAUSES].sort());
  expect(allowed('turns_label_check')).toEqual([...TURN_LABELS].sort());
  expect(allowed('sessions_source_check')).toEqual(all<FeedbackSource>()(['claude', 'codex', 'github', 'linear']));
  expect(allowed('sessions_state_check')).toEqual([...SESSION_STATES].sort());
  expect(allowed('candidates_source_check')).toEqual(all<FeedbackSource>()(['claude', 'codex', 'github', 'linear']));
  expect(allowed('candidates_status_check')).toEqual(all<CandidateStatus>()(['pending', 'confirmed', 'rejected']));
  expect(allowed('feedback_status_check')).toEqual(all<FeedbackStatus>()(['open', 'addressed', 'verified', 'approved', 'rejected', 'reopened', 'superseded', 'unknown']));
  expect(allowed('misses_outcome_check')).toEqual(all<Outcome>()(['approved', 'addressed', 'unresolved', 'unknown']));
  expect(allowed('lessons_status_check')).toEqual(all<LessonStatus>()(['proposed', 'approved', 'rejected', 'revoked', 'superseded']));
  expect(allowed('lessons_scope_check')).toEqual(all<LessonScope>()(['task', 'project', 'global']));
  expect(allowed('lessons_source_check')).toEqual(all<LessonSource>()(['postmortem', 'memory', 'manual', 'demo']));
  expect(allowed('context_items_kind_check')).toEqual(all<ContextKind>()(['code', 'doc', 'claude_md', 'agents_md', 'memory', 'session', 'pr', 'ticket', 'upload']));
  expect(allowed('scan_jobs_status_check')).toEqual(all<ScanStatus>()(['queued', 'running', 'done', 'failed']));
  expect(allowed('chat_turns_status_check')).toEqual([...CHAT_TURN_STATUSES].sort());
  expect(allowed('chat_conversations_provider_check')).toEqual([...CHAT_PROVIDERS].sort());
  expect(allowed('run_owners_principal_check')).toEqual([...RUN_PRINCIPALS].sort());
  expect(allowed('docs_source_check')).toEqual(all<DocSource>()(['upload', 'github', 'linear', 'intake']));
  expect(allowed('facts_origin_check')).toEqual([...FACT_ORIGINS].sort());
  expect(allowed('facts_evidence_check')).toEqual([...FACT_EVIDENCE].sort());
  expect(allowed('decisions_type_check')).toEqual([...DECISION_TYPES].sort());
  // The owner's own types (resolve_conflict) are never calibrated.
  expect(allowed('loop_calibration_type_check')).toEqual([...LOOP_DECISION_TYPES].sort());
  expect(allowed('decisions_author_check')).toEqual([...DECISION_AUTHORS].sort());
  expect(allowed('decisions_status_check')).toEqual([...DECISION_STATUSES].sort());
  expect(allowed('decisions_tier_check')).toEqual([...DECISION_TIERS].sort());
  expect(allowed('decisions_mode_check')).toEqual([...DECISION_MODES].sort());
  expect(allowed('decision_targets_kind_check')).toEqual([...DECISION_TARGET_KINDS].sort());
  expect(allowed('decision_targets_role_check')).toEqual([...DECISION_TARGET_ROLES].sort());
  expect(allowed('decision_notes_verdict_check')).toEqual(['agree', 'disagree']);
  expect(allowed('decision_notes_reason_check')).toEqual([...DECISION_NOTE_REASONS].sort());
  expect(allowed('people_status_check')).toEqual([...PERSON_STATUSES].sort());
  expect(allowed('intake_sources_kind_check')).toEqual([...INTAKE_KINDS].sort());
  expect(allowed('intake_sources_format_check')).toEqual([...INTAKE_FORMATS].sort());
  expect(allowed('claims_type_check')).toEqual([...CLAIM_TYPES].sort());
  expect(allowed('claims_status_check')).toEqual([...CLAIM_STATUSES].sort());
  expect(allowed('questions_kind_check')).toEqual([...QUESTION_KINDS].sort());
  expect(allowed('questions_status_check')).toEqual([...QUESTION_STATUSES].sort());
  expect(allowed('conflicts_kind_check')).toEqual([...CONFLICT_KINDS].sort());
  expect(allowed('conflicts_status_check')).toEqual([...CONFLICT_STATUSES].sort());
  expect(allowed('conflict_sides_kind_check')).toEqual([...CONFLICT_SIDE_KINDS].sort());
  expect(allowed('supersessions_from_kind_check')).toEqual([...CONFLICT_SIDE_KINDS].sort());
  expect(allowed('supersessions_to_kind_check')).toEqual([...CONFLICT_SIDE_KINDS].sort());
  expect(allowed('claim_links_to_kind_check')).toEqual([...CONFLICT_SIDE_KINDS].sort());
  expect(allowed('claim_links_rel_check')).toEqual([...CLAIM_LINK_RELS].sort());
});

test('the embedding dimension is filled in from config, and only a sane one is accepted', () => {
  expect(sql).toContain('{{embedding_dimensions}}');
  const out = renderMigration(sql, { embeddingDimensions: 1024 });
  expect(out).not.toContain('{{');
  expect(out).toContain('vector(1024)');
  expect(() => renderMigration(sql, { embeddingDimensions: 0 })).toThrow(/dimension/);
  expect(() => renderMigration(sql, { embeddingDimensions: 1.5 })).toThrow(/dimension/);
  expect(() => renderMigration(sql, { embeddingDimensions: 2001 })).toThrow(/dimension/);
});


test('real-session run migration supplies the feedback attribution columns used by confirmation', () => {
  const migration = readFileSync(new URL('0048_session_run_tags.sql', dir), 'utf8');
  expect(migration).toMatch(/ALTER TABLE feedback ADD COLUMN run text/);
  expect(migration).toMatch(/ALTER TABLE feedback ADD COLUMN sandbox boolean NOT NULL DEFAULT false/);
  expect(migration).toContain('UPDATE feedback f SET run = k.run, sandbox = k.sandbox FROM candidates k');
});
