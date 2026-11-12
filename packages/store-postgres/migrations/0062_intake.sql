-- Knowledge intake (0.9.0): what people said, the claims and questions drawn from it, who said them, and conflicts
-- between what agents may be told (Neo4j: graph/intake.ts). Times the tool makes are timestamptz; times that came from
-- outside (a meeting date, when a claim was said, a due date) are kept as the text they were given.

-- A source is a Doc with source 'intake'.
ALTER TABLE docs DROP CONSTRAINT docs_source_check;
ALTER TABLE docs ADD CONSTRAINT docs_source_check CHECK (source IN ('upload', 'github', 'linear', 'intake'));

-- An accepted claim becomes a Fact (origin 'claim'), filed under its project like yours, so no scan closes it. New
-- kinds for what people decided, planned and committed to.
ALTER TABLE facts DROP CONSTRAINT facts_kind_check;
ALTER TABLE facts ADD CONSTRAINT facts_kind_check CHECK (kind IN (
  'architecture', 'convention', 'api', 'invariant', 'gotcha', 'config', 'dependency', 'command', 'data_model',
  'security', 'decision', 'plan', 'commitment'));
ALTER TABLE facts DROP CONSTRAINT facts_origin_check;
ALTER TABLE facts ADD CONSTRAINT facts_origin_check CHECK (origin IN ('model', 'manifest', 'document', 'you', 'loop', 'claim'));
ALTER TABLE facts DROP CONSTRAINT facts_about_one;
ALTER TABLE facts ADD CONSTRAINT facts_about_one CHECK (
  (code_file_id IS NULL) <> (doc_id IS NULL) OR (origin IN ('you', 'loop', 'claim') AND code_file_id IS NULL AND doc_id IS NULL));

-- Activity kinds: source_added, source_read, claim_decided, question_changed, conflict_found, conflict_resolved,
-- person_changed.
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
  'conflict_resolved', 'person_changed'));

-- (:Person). One owner (is_owner). (:Person)-[:ALIAS]->(:PersonAlias {norm}): an alias names one person.
CREATE TABLE people (
  id           text PRIMARY KEY,
  display_name text NOT NULL,
  is_owner     boolean NOT NULL DEFAULT false,
  status       text NOT NULL CONSTRAINT people_status_check CHECK (status IN ('proposed', 'confirmed', 'forgotten')),
  created_at   timestamptz NOT NULL
);
CREATE UNIQUE INDEX people_one_owner ON people (is_owner) WHERE is_owner;
CREATE TABLE person_aliases (
  alias_norm text PRIMARY KEY,
  person_id  text NOT NULL REFERENCES people (id) ON DELETE CASCADE
);
CREATE INDEX person_aliases_person ON person_aliases (person_id);

-- A source's details (Neo4j: properties of its Doc). windows_version: the upload (docs.added_at, as ISO text) the
-- saved windows belong to. (:Person)-[:ATTENDED]->(:Doc) is source_people.
CREATE TABLE intake_sources (
  doc_id          text PRIMARY KEY REFERENCES docs (id) ON DELETE CASCADE,
  kind            text NOT NULL CONSTRAINT intake_sources_kind_check CHECK (kind IN ('transcript', 'notes', 'doc')),
  format          text NOT NULL CONSTRAINT intake_sources_format_check CHECK (format IN ('txt', 'md', 'vtt', 'srt')),
  occurred_at     text,
  origin          text,
  private         boolean NOT NULL DEFAULT true,
  windows_done    integer NOT NULL DEFAULT 0,
  windows_total   integer,
  windows_version text
);
CREATE TABLE source_people (
  doc_id    text NOT NULL REFERENCES intake_sources (doc_id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  PRIMARY KEY (doc_id, person_id)
);
CREATE INDEX source_people_person ON source_people (person_id);

-- (:Claim). doc_id: its source, or 'answer:<question id>' (no reference: an accepted claim outlives its source's
-- text). version: the upload its window was read from. speaker_id: (:Person)-[:SAID]->(:Claim), a person id kept as
-- given (merging and forgetting people rewrite it).
CREATE TABLE claims (
  id          text PRIMARY KEY,
  project_key text,
  doc_id      text NOT NULL,
  "window"    integer,
  version     text,
  utt         integer,
  span_start  integer,
  span_end    integer,
  type        text NOT NULL CONSTRAINT claims_type_check CHECK (type IN ('fact', 'decision', 'opinion', 'plan', 'commitment')),
  statement   text NOT NULL,
  quote       text NOT NULL,
  speaker_id  text,
  asserted_at text,
  confidence  double precision NOT NULL,
  scope       jsonb NOT NULL DEFAULT '{"area": null, "files": []}',
  about       text NOT NULL DEFAULT '',
  due         text,
  flags       text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL CONSTRAINT claims_status_check CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  decided_by  text,
  decided_at  timestamptz,
  fact_id     text,
  created_at  timestamptz NOT NULL,
  run         text,
  sandbox     boolean NOT NULL DEFAULT false,
  embedding   vector,
  reembed_pending boolean NOT NULL DEFAULT false
);
CREATE INDEX claims_project_status ON claims (project_key, status);
CREATE INDEX claims_doc ON claims (doc_id, "window");
CREATE INDEX claims_speaker ON claims (speaker_id);
CREATE INDEX claims_created ON claims (created_at DESC, id);
CREATE INDEX claims_run ON claims (run) WHERE run IS NOT NULL;
-- Export and sync find the claim behind each claim fact (portability.ts).
CREATE INDEX claims_fact ON claims (fact_id) WHERE fact_id IS NOT NULL;
CREATE INDEX claims_embedding ON claims
  USING hnsw ((embedding::vector({{embedding_dimensions}})) vector_cosine_ops)
  WHERE vector_dims(embedding) = {{embedding_dimensions}};

-- (:Question). asked_by, assignee: (:Question)-[:ASKED_BY|ASSIGNED_TO]->(:Person). answer_claim_id: -[:ANSWERED_BY]->.
CREATE TABLE questions (
  id              text PRIMARY KEY,
  project_key     text,
  doc_id          text NOT NULL,
  "window"        integer,
  version         text,
  text            text NOT NULL,
  kind            text NOT NULL CONSTRAINT questions_kind_check CHECK (kind IN ('unanswered', 'contradictory', 'needs_owner')),
  quote           text,
  asked_by        text,
  assignee        text,
  status          text NOT NULL CONSTRAINT questions_status_check CHECK (status IN ('open', 'assigned', 'answered', 'dismissed')),
  answer_claim_id text,
  decided_by      text,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL,
  run             text,
  sandbox         boolean NOT NULL DEFAULT false
);
CREATE INDEX questions_status ON questions (status);
CREATE INDEX questions_doc ON questions (doc_id, "window");
CREATE INDEX questions_run ON questions (run) WHERE run IS NOT NULL;

-- (:Conflict)-[:SIDE {role}]->(:Claim|Fact|Lesson): one per pair (conflictIdOf). A side's fingerprint is the one it had
-- when found, so a dismissed pair is suppressed until a side changes.
CREATE TABLE conflicts (
  id          text PRIMARY KEY,
  kind        text NOT NULL CONSTRAINT conflicts_kind_check CHECK (kind IN ('disagreement', 'supersession')),
  status      text NOT NULL CONSTRAINT conflicts_status_check CHECK (status IN ('open', 'resolved', 'dismissed')),
  project_key text,
  signals     jsonb NOT NULL DEFAULT '[]',
  judge       jsonb,
  resolution  jsonb,
  decision_id text,
  created_at  timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  run         text,
  sandbox     boolean NOT NULL DEFAULT false
);
CREATE INDEX conflicts_status ON conflicts (status);
CREATE INDEX conflicts_project ON conflicts (project_key);
CREATE INDEX conflicts_run ON conflicts (run) WHERE run IS NOT NULL;
CREATE TABLE conflict_sides (
  conflict_id text NOT NULL REFERENCES conflicts (id) ON DELETE CASCADE,
  role        text NOT NULL CONSTRAINT conflict_sides_role_check CHECK (role IN ('a', 'b')),
  kind        text NOT NULL CONSTRAINT conflict_sides_kind_check CHECK (kind IN ('claim', 'fact', 'lesson')),
  ref_id      text NOT NULL,
  fingerprint text NOT NULL,
  asserted_at text,
  PRIMARY KEY (conflict_id, role)
);
CREATE INDEX conflict_sides_ref ON conflict_sides (ref_id);

-- (from)-[:SUPERSEDED_BY {conflict_id}]->(to): the loser of a resolved conflict, to the winner.
CREATE TABLE supersessions (
  from_kind   text NOT NULL CONSTRAINT supersessions_from_kind_check CHECK (from_kind IN ('claim', 'fact', 'lesson')),
  from_id     text NOT NULL,
  to_kind     text NOT NULL CONSTRAINT supersessions_to_kind_check CHECK (to_kind IN ('claim', 'fact', 'lesson')),
  to_id       text NOT NULL,
  conflict_id text NOT NULL,
  PRIMARY KEY (from_id, to_id, conflict_id)
);
CREATE INDEX supersessions_to ON supersessions (to_id);

-- (:Claim)-[:REFINES|CORROBORATES]->(:Claim|Fact|Lesson).
CREATE TABLE claim_links (
  from_id    text NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  to_kind    text NOT NULL CONSTRAINT claim_links_to_kind_check CHECK (to_kind IN ('claim', 'fact', 'lesson')),
  to_id      text NOT NULL,
  rel        text NOT NULL CONSTRAINT claim_links_rel_check CHECK (rel IN ('refines', 'corroborates')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (from_id, to_id, rel)
);
CREATE INDEX claim_links_to ON claim_links (to_id);

-- The owner settling a conflict (resolve_conflict) or removing a source with what was drawn from it (remove_source) is a
-- decision, on claims and conflicts as well as facts and lessons,
-- and its author is the owner: never calibrated, budgeted or counted as the loop's.
ALTER TABLE decisions DROP CONSTRAINT decisions_type_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_type_check CHECK (type IN (
  'link_misses', 'merge_duplicates', 'rank_weight', 'retire_lesson', 'reject_lesson', 'approve_lesson',
  'reword_lesson', 'narrow_scope', 'record_fact', 'triage_inbox', 'tune_threshold', 'resolve_conflict', 'remove_source'));
ALTER TABLE decisions ADD COLUMN author text NOT NULL DEFAULT 'loop' CONSTRAINT decisions_author_check CHECK (author IN ('loop', 'owner'));
ALTER TABLE decision_targets DROP CONSTRAINT decision_targets_kind_check;
ALTER TABLE decision_targets ADD CONSTRAINT decision_targets_kind_check CHECK (kind IN ('lesson', 'fact', 'miss', 'candidate', 'project', 'claim', 'conflict'));
