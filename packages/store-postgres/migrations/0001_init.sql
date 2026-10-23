-- The whole Feedback Graph schema for Postgres + pgvector: every node and relationship the Neo4j store
-- (packages/core/src/graph) uses, one table per node label and one per many-to-many relationship.
--
-- Conventions
-- * Ids are text and equal to the Neo4j ids ('lesson:<feedbackId>', 'doc:<project>:<source>:<ref>', ...).
-- * Times are timestamptz. Timestamps that came from outside and are handed back verbatim (turn and commit times,
--   whose offsets and precision vary) also keep their original text in ts_text; read ts_text, order by ts.
-- * project_key is plain text with no foreign key: Neo4j holds records filed under a key that has no Project node
--   (old data, memory lessons), and deleting a project is a set of DELETE ... WHERE project_key = $1.
-- * Foreign keys (ON DELETE CASCADE) only for containment and relationship tables, where both ends always exist.
-- * jsonb only for free-form documents: activity details, the worker heartbeat, the candidate-folder snapshot,
--   and turn tool calls.
-- * Enum-like columns carry CHECK constraints equal to the TypeScript unions (schema.test.ts keeps them in step):
--   a new value needs a new migration.
-- * Embeddings are `vector` without a fixed length, because a store can hold vectors of an older model of another
--   size (searches skip those). The HNSW cosine index covers vectors of the configured length,
--   {{embedding_dimensions}}; a search uses it by filtering vector_dims(embedding) = <dims> and ordering by
--   (embedding::vector(<dims>)) <=> $query.
-- * reembed_pending marks rows a re-embed has still to redo, so a crashed run resumes where it stopped.

CREATE EXTENSION IF NOT EXISTS vector;

-- (:Project) key = top-level folder name. aliases: other folder keys holding a clone of the same remote.
CREATE TABLE projects (
  key       text PRIMARY KEY,
  name      text,
  repo_path text,
  remote    text,
  aliases   text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX projects_remote ON projects (remote);
CREATE INDEX projects_aliases ON projects USING gin (aliases);

-- (:Session)-[:IN]->(:Project). source null: stored before Codex support, read as 'claude'.
CREATE TABLE sessions (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  source      text CONSTRAINT sessions_source_check CHECK (source IN ('claude', 'codex')),
  source_file text,
  cwd         text,
  git_branch  text,
  started_at  timestamptz,
  ended_at    timestamptz,
  manual      boolean NOT NULL DEFAULT false
);
CREATE INDEX sessions_project ON sessions (project_key);

-- (:Session)-[:HAS_TURN]->(:Turn). idx is the turn's index in its session (0 opens it). text and
-- preceding_assistant_text become null when retention prunes them (pruned_at set).
CREATE TABLE turns (
  uuid                     text PRIMARY KEY,
  session_id               text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  project_key              text NOT NULL,
  ts                       timestamptz NOT NULL,
  ts_text                  text NOT NULL,
  idx                      integer NOT NULL,
  text                     text,
  preceding_assistant_text text,
  tool_calls               jsonb NOT NULL DEFAULT '[]',
  label                    text CONSTRAINT turns_label_check CHECK (label IN ('pushback', 'correction', 'approval', 'neutral')),
  confidence               double precision,
  summary                  text,
  signals                  text[],
  classify_attempts        integer NOT NULL DEFAULT 0,
  pruned_at                timestamptz
);
CREATE INDEX turns_session_idx ON turns (session_id, idx);
CREATE INDEX turns_project ON turns (project_key);
CREATE INDEX turns_unclassified ON turns (ts DESC) WHERE label IS NULL AND idx > 0;

-- (:Commit), shared by every session that saw it: no project of its own.
CREATE TABLE commits (
  sha     text PRIMARY KEY,
  ts      timestamptz NOT NULL,
  ts_text text NOT NULL,
  subject text
);

-- (:Session)-[:DURING]->(:Commit)
CREATE TABLE session_commits (
  session_id text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  sha        text NOT NULL REFERENCES commits (sha) ON DELETE CASCADE,
  PRIMARY KEY (session_id, sha)
);
CREATE INDEX session_commits_sha ON session_commits (sha);

-- (:Candidate)-[:FLAGS]->(:Turn). id = the flagged turn's uuid. ts copies the turn's time.
CREATE TABLE candidates (
  id          text PRIMARY KEY,
  turn_uuid   text NOT NULL REFERENCES turns (uuid) ON DELETE CASCADE,
  session_id  text NOT NULL,
  project_key text NOT NULL,
  ts          timestamptz,
  source      text CONSTRAINT candidates_source_check CHECK (source IN ('claude', 'codex')),
  status      text NOT NULL CONSTRAINT candidates_status_check CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at  timestamptz NOT NULL,
  decided_at  timestamptz,
  note        text,
  manual      boolean NOT NULL DEFAULT false
);
CREATE INDEX candidates_status ON candidates (status);
CREATE INDEX candidates_project ON candidates (project_key);
CREATE INDEX candidates_turn ON candidates (turn_uuid);

-- (:Task), one per session: id 'task:<sessionId>'. (:Session)-[:WORKED_ON]->(:Task) is session_id.
CREATE TABLE tasks (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  session_id  text REFERENCES sessions (id) ON DELETE CASCADE,
  title       text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX tasks_project ON tasks (project_key);

-- (:Feedback)-[:FROM_TURN]->(:Turn); (:Feedback)-[:CRITICIZES]->(:Task) is task_id. id = the candidate's id.
-- attempts / last_error / retry_at: the post-mortem's failures and when it is due again.
CREATE TABLE feedback (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  turn_uuid   text NOT NULL REFERENCES turns (uuid) ON DELETE CASCADE,
  task_id     text REFERENCES tasks (id) ON DELETE SET NULL,
  status      text NOT NULL CONSTRAINT feedback_status_check
                CHECK (status IN ('open', 'addressed', 'verified', 'approved', 'rejected', 'reopened', 'superseded', 'unknown')),
  text        text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  retry_at    timestamptz
);
CREATE INDEX feedback_project ON feedback (project_key);
CREATE INDEX feedback_turn ON feedback (turn_uuid);

-- (:Commit)-[:ADDRESSES]->(:Feedback): commits of the session made after the feedback.
CREATE TABLE commit_feedback (
  sha         text NOT NULL REFERENCES commits (sha) ON DELETE CASCADE,
  feedback_id text NOT NULL REFERENCES feedback (id) ON DELETE CASCADE,
  PRIMARY KEY (sha, feedback_id)
);
CREATE INDEX commit_feedback_feedback ON commit_feedback (feedback_id);

-- (:Cause), shared across projects: key is one of the CAUSES. Created on first use, never deleted with a project.
CREATE TABLE causes (
  key text PRIMARY KEY
);

-- (:Miss)-[:EXPLAINS]->(:Feedback) is feedback_id; (:Miss)-[:CAUSED_BY]->(:Cause) is cause. id 'miss:<feedbackId>'.
CREATE TABLE misses (
  id                text PRIMARY KEY,
  project_key       text NOT NULL,
  feedback_id       text NOT NULL REFERENCES feedback (id) ON DELETE CASCADE,
  missed            text NOT NULL,
  cause             text REFERENCES causes (key) CONSTRAINT misses_cause_check
                      CHECK (cause IN ('context_missing', 'context_available_ignored', 'requirement_unstated', 'verification_gap', 'implementation_error')),
  cause_explanation text,
  outcome           text CONSTRAINT misses_outcome_check CHECK (outcome IN ('approved', 'addressed', 'unresolved', 'unknown')),
  created_at        timestamptz NOT NULL,
  embedding         vector,
  reembed_pending   boolean NOT NULL DEFAULT false
);
CREATE INDEX misses_project ON misses (project_key);
CREATE INDEX misses_feedback ON misses (feedback_id);
CREATE INDEX misses_embedding ON misses
  USING hnsw ((embedding::vector({{embedding_dimensions}})) vector_cosine_ops)
  WHERE vector_dims(embedding) = {{embedding_dimensions}};

-- (:Lesson). project_key null: global (served to every project). origin_project_key: the project it came from,
-- kept when it goes global. (:Lesson)-[:DERIVED_FROM]->(:Miss) is miss_id. (:Lesson)-[:APPLIES_TO]->(:Project) is
-- project_key; writing one also creates the projects row when missing, as Neo4j's MERGE does.
-- decided_by_you: you approved, rejected or edited it, so re-importing its memory file never overrides you.
CREATE TABLE lessons (
  id                 text PRIMARY KEY,
  project_key        text,
  origin_project_key text,
  miss_id            text REFERENCES misses (id) ON DELETE SET NULL,
  title              text NOT NULL,
  rule               text NOT NULL,
  applies_when       text,
  scope              text NOT NULL CONSTRAINT lessons_scope_check CHECK (scope IN ('task', 'project', 'global')),
  paths              text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL CONSTRAINT lessons_status_check CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
  source             text NOT NULL CONSTRAINT lessons_source_check CHECK (source IN ('postmortem', 'memory', 'manual')),
  cause              text CONSTRAINT lessons_cause_check
                       CHECK (cause IN ('context_missing', 'context_available_ignored', 'requirement_unstated', 'verification_gap', 'implementation_error')),
  created_at         timestamptz NOT NULL,
  decided_at         timestamptz,
  valid_to           timestamptz,
  decided_by_you     boolean NOT NULL DEFAULT false,
  embedding          vector,
  reembed_pending    boolean NOT NULL DEFAULT false
);
CREATE INDEX lessons_status ON lessons (status);
CREATE INDEX lessons_project_status ON lessons (project_key, status);
CREATE INDEX lessons_origin ON lessons (origin_project_key);
CREATE INDEX lessons_miss ON lessons (miss_id);
CREATE INDEX lessons_embedding ON lessons
  USING hnsw ((embedding::vector({{embedding_dimensions}})) vector_cosine_ops)
  WHERE vector_dims(embedding) = {{embedding_dimensions}};

-- (:Lesson)-[:SUPERSEDES]->(:Lesson)
CREATE TABLE lesson_supersedes (
  lesson_id     text NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  superseded_id text NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, superseded_id)
);
CREATE INDEX lesson_supersedes_superseded ON lesson_supersedes (superseded_id);

-- (:ContextItem): what would have prevented a miss. id from contextItemId(feedbackId, kind, ref).
CREATE TABLE context_items (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  kind        text NOT NULL CONSTRAINT context_items_kind_check
                CHECK (kind IN ('code', 'doc', 'claude_md', 'memory', 'session', 'pr', 'ticket', 'upload')),
  ref         text NOT NULL,
  excerpt     text
);
CREATE INDEX context_items_project ON context_items (project_key);

-- (:ContextItem)-[:WOULD_HAVE_PREVENTED {why}]->(:Miss)
CREATE TABLE context_item_misses (
  context_item_id text NOT NULL REFERENCES context_items (id) ON DELETE CASCADE,
  miss_id         text NOT NULL REFERENCES misses (id) ON DELETE CASCADE,
  why             text,
  PRIMARY KEY (context_item_id, miss_id)
);
CREATE INDEX context_item_misses_miss ON context_item_misses (miss_id);

-- (:ContextItem)-[:WAS_AVAILABLE_IN]->(:Session)
CREATE TABLE context_item_sessions (
  context_item_id text NOT NULL REFERENCES context_items (id) ON DELETE CASCADE,
  session_id      text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  PRIMARY KEY (context_item_id, session_id)
);
CREATE INDEX context_item_sessions_session ON context_item_sessions (session_id);

-- (:PreDoneCheck): an agent checked its work against lessons before calling it done. checked / gaps are counts.
CREATE TABLE predone_checks (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  ts          timestamptz NOT NULL,
  task        text NOT NULL,
  checked     integer NOT NULL,
  gaps        integer NOT NULL
);
CREATE INDEX predone_checks_project ON predone_checks (project_key);

-- (:PreDoneCheck)-[:CHECKED {gap}]->(:Lesson). Lesson ids that do not exist are not linked.
CREATE TABLE predone_check_lessons (
  check_id  text NOT NULL REFERENCES predone_checks (id) ON DELETE CASCADE,
  lesson_id text NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  gap       boolean NOT NULL,
  PRIMARY KEY (check_id, lesson_id)
);
CREATE INDEX predone_check_lessons_lesson ON predone_check_lessons (lesson_id);

-- (:CodeFile)-[:IN]->(:Project). id '<projectKey>:<path>'; path '.' holds facts about the whole project.
CREATE TABLE code_files (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  path        text NOT NULL,
  hash        text,
  summary     text,
  scanned_at  timestamptz,
  removed     boolean NOT NULL DEFAULT false
);
CREATE INDEX code_files_project ON code_files (project_key);

-- (:Fact)-[:ABOUT]->(:CodeFile) is code_file_id. Facts are never updated in place: a rescan closes the current ones
-- (current = false, valid_to set) and adds new ones. scan_job_id is provenance only (no foreign key, as in Neo4j).
CREATE TABLE facts (
  id              text PRIMARY KEY,
  project_key     text NOT NULL,
  code_file_id    text NOT NULL REFERENCES code_files (id) ON DELETE CASCADE,
  kind            text NOT NULL CONSTRAINT facts_kind_check
                    CHECK (kind IN ('architecture', 'convention', 'api', 'invariant', 'gotcha', 'config', 'dependency', 'command', 'data_model', 'security')),
  statement       text NOT NULL,
  path            text NOT NULL,
  lines           text,
  confidence      double precision,
  why             text,
  source          text NOT NULL,
  scan_job_id     text,
  file_hash       text,
  current         boolean NOT NULL,
  created_at      timestamptz NOT NULL,
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  embedding       vector,
  reembed_pending boolean NOT NULL DEFAULT false
);
CREATE INDEX facts_project_current ON facts (project_key, current);
CREATE INDEX facts_code_file_current ON facts (code_file_id) WHERE current;
CREATE INDEX facts_embedding ON facts
  USING hnsw ((embedding::vector({{embedding_dimensions}})) vector_cosine_ops)
  WHERE vector_dims(embedding) = {{embedding_dimensions}} AND current;

-- (:ScanJob)-[:FOR]->(:Project)
CREATE TABLE scan_jobs (
  id            text PRIMARY KEY,
  project_key   text NOT NULL,
  repo_path     text,
  provider      text,
  status        text NOT NULL CONSTRAINT scan_jobs_status_check CHECK (status IN ('queued', 'running', 'done', 'failed')),
  requested_at  timestamptz NOT NULL,
  started_at    timestamptz,
  finished_at   timestamptz,
  files_scanned integer NOT NULL DEFAULT 0,
  facts_added   integer NOT NULL DEFAULT 0,
  error         text
);
CREATE INDEX scan_jobs_status ON scan_jobs (status, requested_at);
CREATE INDEX scan_jobs_project ON scan_jobs (project_key, requested_at DESC);

-- (:Doc)-[:IN]->(:Project). id docIdOf({projectKey, source, ref}).
CREATE TABLE docs (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  source      text NOT NULL CONSTRAINT docs_source_check CHECK (source IN ('upload', 'github', 'linear')),
  ref         text NOT NULL,
  title       text NOT NULL,
  url         text,
  added_at    timestamptz NOT NULL
);
CREATE INDEX docs_project ON docs (project_key, added_at DESC);

-- (:Doc)-[:HAS_CHUNK]->(:Chunk). id '<docId>#<idx>'.
CREATE TABLE chunks (
  id              text PRIMARY KEY,
  doc_id          text NOT NULL REFERENCES docs (id) ON DELETE CASCADE,
  project_key     text NOT NULL,
  idx             integer NOT NULL,
  text            text NOT NULL,
  embedding       vector,
  reembed_pending boolean NOT NULL DEFAULT false
);
CREATE INDEX chunks_doc ON chunks (doc_id, idx);
CREATE INDEX chunks_project ON chunks (project_key);
CREATE INDEX chunks_embedding ON chunks
  USING hnsw ((embedding::vector({{embedding_dimensions}})) vector_cosine_ops)
  WHERE vector_dims(embedding) = {{embedding_dimensions}};

-- (:SyncCursor) key/value for integration syncs, e.g. 'github:<projectKey>'. deleteProject removes the keys that
-- end in ':<projectKey>'.
CREATE TABLE sync_cursors (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- (:Activity): the append-only provenance log. seq orders it (Neo4j's `order`); list() is newest first.
-- targets: ids of the records an entry created or touched.
CREATE TABLE activity (
  id          text PRIMARY KEY,
  seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  ts          timestamptz NOT NULL,
  kind        text NOT NULL CONSTRAINT activity_kind_check CHECK (kind IN (
                'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
                'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
                'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
                'projects_cleaned')),
  actor       text NOT NULL,
  project_key text,
  subject     text NOT NULL,
  why         text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}',
  targets     text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX activity_project ON activity (project_key, seq DESC);
CREATE INDEX activity_kind ON activity (kind, seq DESC);
CREATE INDEX activity_targets ON activity USING gin (targets);

-- (:WorkerStatus {id: 'worker'}): the worker's last heartbeat, as the WorkerStatus document.
CREATE TABLE worker_status (
  id         text PRIMARY KEY,
  status     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- (:GraphConfig {id: 'embedding'}): the embedding model the stored vectors came from.
CREATE TABLE graph_config (
  id         text PRIMARY KEY,
  model      text NOT NULL,
  updated_at timestamptz NOT NULL
);

-- (:ProjectSelection {id: 'selection'}): the folders the owner chose to have read. created_by: the token of the
-- ensure() call that created it, so only that call logs the first selection.
CREATE TABLE project_selection (
  id          text PRIMARY KEY,
  tracked     text[] NOT NULL DEFAULT '{}',
  initialized boolean NOT NULL DEFAULT false,
  updated_at  timestamptz,
  created_by  text
);

-- (:ProjectCandidates {id: 'selection'}): the worker's last CandidateSnapshot of the folders it could read.
CREATE TABLE project_candidates (
  id       text PRIMARY KEY,
  snapshot jsonb NOT NULL,
  built_at timestamptz
);
