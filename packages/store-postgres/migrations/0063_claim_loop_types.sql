-- 0.9.1: knowledge intake's learning-loop types: claims merged, linked and accepted, a conflict's resolution
-- suggested, a question assigned or closed; and questions as decision targets.
ALTER TABLE decisions DROP CONSTRAINT decisions_type_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_type_check CHECK (type IN (
  'link_misses', 'merge_duplicates', 'rank_weight', 'retire_lesson', 'reject_lesson', 'approve_lesson',
  'reword_lesson', 'narrow_scope', 'record_fact', 'triage_inbox', 'tune_threshold', 'merge_claims', 'link_claims',
  'accept_claim', 'propose_resolution', 'assign_question', 'close_question', 'update_paths', 'resolve_conflict', 'remove_source'));
ALTER TABLE loop_calibration DROP CONSTRAINT loop_calibration_type_check;
ALTER TABLE loop_calibration ADD CONSTRAINT loop_calibration_type_check CHECK (type IN (
  'link_misses', 'merge_duplicates', 'rank_weight', 'retire_lesson', 'reject_lesson', 'approve_lesson',
  'reword_lesson', 'narrow_scope', 'record_fact', 'triage_inbox', 'tune_threshold', 'merge_claims', 'link_claims',
  'accept_claim', 'propose_resolution', 'assign_question', 'close_question', 'update_paths'));
ALTER TABLE decision_targets DROP CONSTRAINT decision_targets_kind_check;
ALTER TABLE decision_targets ADD CONSTRAINT decision_targets_kind_check CHECK (kind IN ('lesson', 'fact', 'miss', 'candidate', 'project', 'claim', 'conflict', 'question'));

-- Settings' Cloud sync card records what it changed (cloud_settings_changed).
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged', 'feedback_decided',
  'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served', 'predone_check', 'doc_added',
  'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected', 'projects_cleaned', 'code_mapped',
  'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized', 'roots_saved', 'integration_changed',
  'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned', 'links_suggested', 'link_decided',
  'doc_read', 'comments_skipped', 'lessons_checked', 'lesson_to_fact', 'misses_reclassified', 'items_reopened',
  'session_resumed', 'secrets_redacted', 'run_cleaned', 'demo_seeded', 'demo_removed', 'sessions_rematched',
  'decision_made', 'decision_applied', 'decision_rolled_back', 'decision_noted', 'loop_settings_changed',
  'loop_paused', 'source_added', 'source_read', 'claim_decided', 'question_changed', 'conflict_found',
  'conflict_resolved', 'person_changed', 'cloud_settings_changed'));

-- Pairs you said are not the same (a merge rolled back, or marked distinct): the learning loop never proposes merging
-- them again. a < b; only you lift one.
CREATE TABLE distinct_pairs (
  a           text NOT NULL,
  b           text NOT NULL,
  by          text NOT NULL,
  at          timestamptz NOT NULL,
  reason      text NOT NULL,
  decision_id text,
  PRIMARY KEY (a, b)
);
CREATE INDEX distinct_pairs_b ON distinct_pairs (b);

-- An Inbox item's text embedded (the flagged turn's, or an agent's report): a reworded or later report of the same miss
-- joins it (core dedupe.ts). Items flagged before 0.9.1 have none and match by words only.
ALTER TABLE candidates ADD COLUMN dedupe_embedding vector;
