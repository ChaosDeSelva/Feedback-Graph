-- Fact relevance (0..1): how often an agent doing everyday coding in the project needs the fact. Null: not scored yet
-- (ranked as 0.5 until the worker scores it). relevance_by: 'model' (the extractor or the background scorer) or 'you'
-- (set on the Projects page; a model score never replaces it).
ALTER TABLE facts
  ADD COLUMN relevance    double precision,
  ADD COLUMN relevance_by text CONSTRAINT facts_relevance_by_check CHECK (relevance_by IN ('model', 'you'));
CREATE INDEX facts_unscored ON facts (project_key) WHERE current AND relevance IS NULL;

ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned',
  'links_suggested', 'link_decided', 'doc_read'));

-- Pinned projects come first in every project list (UI order only).
ALTER TABLE projects ADD COLUMN pinned boolean NOT NULL DEFAULT false;

-- Links between projects, one row per pair (a < b). status: suggested (found by the worker, never served to agents),
-- confirmed or dismissed (by you). evidence: [{signal, detail, path, from}], at most five.
CREATE TABLE project_links (
  id         text PRIMARY KEY,
  a          text NOT NULL,
  b          text NOT NULL,
  relation   text NOT NULL CONSTRAINT project_links_relation_check CHECK (relation IN ('depends_on', 'same_product', 'shares_code', 'related')),
  note       text NOT NULL DEFAULT '',
  status     text NOT NULL CONSTRAINT project_links_status_check CHECK (status IN ('suggested', 'confirmed', 'dismissed')),
  source     text NOT NULL CONSTRAINT project_links_source_check CHECK (source IN ('detected', 'you')),
  score      double precision NOT NULL DEFAULT 0,
  evidence   jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT project_links_order CHECK (a COLLATE "C" < b COLLATE "C")
);
CREATE INDEX project_links_a ON project_links (a);
CREATE INDEX project_links_b ON project_links (b);

-- Uploads read into facts by the worker's docs stage. kind: text or image (its bytes in doc_blobs). read_status: null
-- for documents that are never read (PR discussions, tickets); pending, reading, done or failed for uploads.
ALTER TABLE docs
  ADD COLUMN kind          text NOT NULL DEFAULT 'text' CONSTRAINT docs_kind_check CHECK (kind IN ('text', 'image')),
  ADD COLUMN media_type    text,
  ADD COLUMN read_status   text CONSTRAINT docs_read_status_check CHECK (read_status IN ('pending', 'reading', 'done', 'failed')),
  ADD COLUMN read_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN read_error    text,
  ADD COLUMN read_retry_at timestamptz,
  ADD COLUMN read_at       timestamptz;
CREATE INDEX docs_to_read ON docs (added_at, id) WHERE read_status = 'pending';

-- (:Doc)-[:HAS_BLOB]->(:DocBlob): an uploaded image, at most 8 MB, for the reader and the thumbnail.
CREATE TABLE doc_blobs (
  doc_id      text PRIMARY KEY REFERENCES docs (id) ON DELETE CASCADE,
  project_key text NOT NULL,
  media_type  text NOT NULL,
  data        bytea NOT NULL
);

-- Facts read from an uploaded document: (:Fact)-[:FROM]->(:Doc) is doc_id, and such a fact has no code file. A code
-- scan never closes them; they go with their document.
ALTER TABLE facts
  ALTER COLUMN code_file_id DROP NOT NULL,
  ADD COLUMN doc_id text REFERENCES docs (id) ON DELETE CASCADE,
  ADD CONSTRAINT facts_about_one CHECK ((code_file_id IS NULL) <> (doc_id IS NULL));
CREATE INDEX facts_doc ON facts (doc_id) WHERE doc_id IS NOT NULL;
