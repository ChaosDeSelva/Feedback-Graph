import { readdirSync, readFileSync } from 'node:fs';
import { ACTIVITY_KINDS, CAUSES, CHAT_PROVIDERS, CHAT_TURN_STATUSES, FACT_EVIDENCE, FACT_KINDS, FACT_ORIGINS, RUN_PRINCIPALS, SESSION_STATES, SYMBOL_KINDS, TURN_LABELS, type CandidateStatus, type FeedbackSource, type ContextKind, type DocSource, type FeedbackStatus, type LessonScope, type LessonSource, type LessonStatus, type Outcome, type ScanStatus } from '@fb/core';
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
  expect(allowed('lessons_status_check')).toEqual(all<LessonStatus>()(['proposed', 'approved', 'rejected', 'superseded']));
  expect(allowed('lessons_scope_check')).toEqual(all<LessonScope>()(['task', 'project', 'global']));
  expect(allowed('lessons_source_check')).toEqual(all<LessonSource>()(['postmortem', 'memory', 'manual', 'demo']));
  expect(allowed('context_items_kind_check')).toEqual(all<ContextKind>()(['code', 'doc', 'claude_md', 'agents_md', 'memory', 'session', 'pr', 'ticket', 'upload']));
  expect(allowed('scan_jobs_status_check')).toEqual(all<ScanStatus>()(['queued', 'running', 'done', 'failed']));
  expect(allowed('chat_turns_status_check')).toEqual([...CHAT_TURN_STATUSES].sort());
  expect(allowed('chat_conversations_provider_check')).toEqual([...CHAT_PROVIDERS].sort());
  expect(allowed('run_owners_principal_check')).toEqual([...RUN_PRINCIPALS].sort());
  expect(allowed('docs_source_check')).toEqual(all<DocSource>()(['upload', 'github', 'linear']));
  expect(allowed('facts_origin_check')).toEqual([...FACT_ORIGINS].sort());
  expect(allowed('facts_evidence_check')).toEqual([...FACT_EVIDENCE].sort());
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
