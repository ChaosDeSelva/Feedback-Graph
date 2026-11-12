-- The learning loop (0.8.0): its decisions with before/after snapshots, evidence and confidence (Neo4j :Decision),
-- the records they target, the earlier decisions they depend on, notes on them, the misses link_misses links
-- (:REPEATS), the per-lesson outcome counts it folds from Activity (:LessonSignals), and its calibration buckets
-- (:LoopCalibration). Times are the application's clock, as everywhere else.
CREATE TABLE decisions (
  id             text PRIMARY KEY,
  type           text NOT NULL CONSTRAINT decisions_type_check CHECK (type IN (
    'link_misses', 'merge_duplicates', 'rank_weight', 'retire_lesson', 'reject_lesson', 'approve_lesson',
    'reword_lesson', 'narrow_scope', 'record_fact', 'triage_inbox', 'tune_threshold')),
  project_key    text,
  status         text NOT NULL CONSTRAINT decisions_status_check CHECK (status IN (
    'observed', 'proposed', 'applying', 'applied', 'rejected', 'rolled_back', 'overridden', 'expired')),
  tier           text NOT NULL CONSTRAINT decisions_tier_check CHECK (tier IN ('H', 'A', 'P')),
  mode           text NOT NULL CONSTRAINT decisions_mode_check CHECK (mode IN ('observe', 'propose', 'auto')),
  before         jsonb NOT NULL DEFAULT '[]',
  after          jsonb NOT NULL DEFAULT '[]',
  evidence       jsonb NOT NULL DEFAULT '[]',
  features       jsonb NOT NULL DEFAULT '{}',
  score          double precision NOT NULL,
  confidence     jsonb NOT NULL,
  -- confidence's band, as a column so the Decisions list filters on it.
  band           int NOT NULL,
  rationale      text NOT NULL,
  model          text,
  policy_version int NOT NULL,
  superseded_by  text,
  created_at     timestamptz NOT NULL,
  applied_at     timestamptz,
  decided_at     timestamptz,
  decided_by     text,
  rollback       jsonb,
  ratified_at    timestamptz,
  ratified_by    text,
  sync_hold_until timestamptz
);
CREATE INDEX decisions_status ON decisions (status);
CREATE INDEX decisions_type ON decisions (type);
CREATE INDEX decisions_project ON decisions (project_key);
CREATE INDEX decisions_created ON decisions (created_at DESC, id DESC);

-- A decision's targets in their order. target_id is a record id (lesson, fact, miss, Inbox item) or a project key.
CREATE TABLE decision_targets (
  decision_id text NOT NULL REFERENCES decisions (id) ON DELETE CASCADE,
  idx         int NOT NULL,
  kind        text NOT NULL CONSTRAINT decision_targets_kind_check CHECK (kind IN ('lesson', 'fact', 'miss', 'candidate', 'project')),
  target_id   text NOT NULL,
  role        text NOT NULL CONSTRAINT decision_targets_role_check CHECK (role IN ('primary', 'keeper', 'merged', 'created')),
  PRIMARY KEY (decision_id, idx)
);
CREATE INDEX decision_targets_target ON decision_targets (target_id);

-- depends_on: an earlier decision (Decision.dependsOn), undone before this one is.
CREATE TABLE decision_deps (
  decision_id text NOT NULL REFERENCES decisions (id) ON DELETE CASCADE,
  idx         int NOT NULL,
  depends_on  text NOT NULL,
  PRIMARY KEY (decision_id, idx)
);
CREATE INDEX decision_deps_depends_on ON decision_deps (depends_on);

CREATE TABLE decision_notes (
  id          text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES decisions (id) ON DELETE CASCADE,
  ts          timestamptz NOT NULL,
  by          text NOT NULL,
  text        text NOT NULL,
  verdict     text CONSTRAINT decision_notes_verdict_check CHECK (verdict IN ('agree', 'disagree')),
  reason      text CONSTRAINT decision_notes_reason_check CHECK (reason IN ('wrong_evidence', 'too_broad', 'wording', 'not_now', 'other'))
);
CREATE INDEX decision_notes_decision ON decision_notes (decision_id, ts, id);

-- from_miss_id repeats to_miss_id (link_misses).
CREATE TABLE miss_links (
  from_miss_id text NOT NULL REFERENCES misses (id) ON DELETE CASCADE,
  to_miss_id   text NOT NULL REFERENCES misses (id) ON DELETE CASCADE,
  decision_id  text NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (from_miss_id, to_miss_id)
);
CREATE INDEX miss_links_to ON miss_links (to_miss_id);

CREATE TABLE lesson_signals (
  lesson_id        text PRIMARY KEY REFERENCES lessons (id) ON DELETE CASCADE,
  counts           jsonb NOT NULL,
  last_served      timestamptz,
  last_owner_touch timestamptz,
  updated_at       timestamptz NOT NULL
);

-- A Beta(alpha, beta) posterior of "the owner kept it" per decision type, confidence band and policy version.
CREATE TABLE loop_calibration (
  type           text NOT NULL CONSTRAINT loop_calibration_type_check CHECK (type IN (
    'link_misses', 'merge_duplicates', 'rank_weight', 'retire_lesson', 'reject_lesson', 'approve_lesson',
    'reword_lesson', 'narrow_scope', 'record_fact', 'triage_inbox', 'tune_threshold')),
  band           int NOT NULL,
  policy_version int NOT NULL,
  alpha          double precision NOT NULL,
  beta           double precision NOT NULL,
  n              int NOT NULL,
  updated_at     timestamptz NOT NULL,
  PRIMARY KEY (type, band, policy_version)
);

-- The loop's Activity kinds: decision_made, decision_applied, decision_rolled_back, decision_noted,
-- loop_settings_changed, loop_paused.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned',
  'links_suggested', 'link_decided', 'doc_read', 'comments_skipped', 'lessons_checked', 'lesson_to_fact',
  'misses_reclassified', 'items_reopened', 'session_resumed', 'secrets_redacted', 'run_cleaned', 'demo_seeded', 'demo_removed',
  'sessions_rematched', 'decision_made', 'decision_applied', 'decision_rolled_back', 'decision_noted',
  'loop_settings_changed', 'loop_paused'));
