-- The code knowledge graph (CodeGraphStore): each project's code map from the worker's parser, the files each session
-- read and edited, and the activity kind its builds are logged under. Conventions as in 0001_init.sql.

-- (:CodeFile) gains the map's own properties. The scanner's columns (hash = sha1 of the content, summary, removed)
-- are untouched: a file can be mapped, scanned, both, or only touched by a session. in_map: in the latest map.
-- code_hash: the map's sha256. churn_commits null: no commits in the churn window.
ALTER TABLE code_files
  ADD COLUMN in_map        boolean NOT NULL DEFAULT false,
  ADD COLUMN lang          text,
  ADD COLUMN code_hash     text,
  ADD COLUMN loc           integer,
  ADD COLUMN is_test       boolean NOT NULL DEFAULT false,
  ADD COLUMN churn_commits integer,
  ADD COLUMN churn_last_ts text,
  ADD COLUMN mapped_at     timestamptz;
CREATE INDEX code_files_project_map ON code_files (project_key, path) WHERE in_map;

-- (:CodeFile)-[:DEFINES]->(:Symbol). id is the parser's '<path>#<name>' (not unique); ord keeps its order in the file.
CREATE TABLE code_symbols (
  code_file_id text NOT NULL REFERENCES code_files (id) ON DELETE CASCADE,
  ord          integer NOT NULL,
  project_key  text NOT NULL,
  id           text NOT NULL,
  path         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL CONSTRAINT code_symbols_kind_check
                 CHECK (kind IN ('function', 'class', 'interface', 'type', 'const', 'method', 'other')),
  exported     boolean NOT NULL,
  lines        text,
  PRIMARY KEY (code_file_id, ord)
);
CREATE INDEX code_symbols_project ON code_symbols (project_key);

-- (:CodeFile)-[:IMPORTS {names, spec}]->(:CodeFile | :Module). to_ref: the target's repo path, or 'pkg:<name>' (a
-- Module) with to_file_id null.
CREATE TABLE code_imports (
  from_file_id text NOT NULL REFERENCES code_files (id) ON DELETE CASCADE,
  to_ref       text NOT NULL,
  to_file_id   text REFERENCES code_files (id) ON DELETE CASCADE,
  project_key  text NOT NULL,
  names        text[] NOT NULL DEFAULT '{}',
  spec         text,
  PRIMARY KEY (from_file_id, to_ref)
);
CREATE INDEX code_imports_to ON code_imports (to_file_id);
CREATE INDEX code_imports_project ON code_imports (project_key);

-- (:CodeFile)-[:TESTS]->(:CodeFile): the test imports the target directly or through one file.
CREATE TABLE code_tests (
  test_file_id   text NOT NULL REFERENCES code_files (id) ON DELETE CASCADE,
  target_file_id text NOT NULL REFERENCES code_files (id) ON DELETE CASCADE,
  project_key    text NOT NULL,
  PRIMARY KEY (test_file_id, target_file_id)
);
CREATE INDEX code_tests_target ON code_tests (target_file_id);
CREATE INDEX code_tests_project ON code_tests (project_key);

-- (:CodeMap {projectKey}): when the map was built, the repo fingerprint it was built from, and its size.
CREATE TABLE code_maps (
  project_key text PRIMARY KEY,
  fingerprint text,
  built_at    timestamptz NOT NULL,
  files       integer NOT NULL,
  symbols     integer NOT NULL,
  imports     integer NOT NULL,
  tests       integer NOT NULL
);

-- (:Session)-[:TOUCHED {read, edited, firstEditAt, lastEditAt}]->(:CodeFile). path is repo-relative; the file is
-- '<project_key>:<path>' in code_files when mapped or scanned, but a touch needs no code_files row.
CREATE TABLE session_files (
  session_id    text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  path          text NOT NULL,
  project_key   text NOT NULL,
  read          boolean NOT NULL,
  edited        boolean NOT NULL,
  first_edit_at timestamptz,
  last_edit_at  timestamptz,
  PRIMARY KEY (session_id, path)
);
CREATE INDEX session_files_project_path ON session_files (project_key, path) WHERE edited;

-- Map builds are logged in Activity.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped'));
