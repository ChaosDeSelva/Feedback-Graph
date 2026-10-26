-- Runs: a tester labels its requests with a run id (x-fg-run) and what they write records it, so `fg cleanup --run`
-- removes exactly that (RunsStore). Null: not written in a run. sandbox: the run asked to be a sandbox
-- (x-fg-sandbox): its lessons, misses, facts, documents and links are served only to that run's own agents, and never
-- exported or synced. A post-mortem copies its report's run onto the miss and lesson; a reading copies its document's
-- onto the facts read from it.
ALTER TABLE activity ADD COLUMN run text, ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX activity_run ON activity (run, seq DESC) WHERE run IS NOT NULL;
ALTER TABLE candidates ADD COLUMN run text, ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX candidates_run ON candidates (run) WHERE run IS NOT NULL;
ALTER TABLE misses ADD COLUMN run text, ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX misses_run ON misses (run) WHERE run IS NOT NULL;
ALTER TABLE lessons ADD COLUMN run text, ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX lessons_run ON lessons (run) WHERE run IS NOT NULL;
ALTER TABLE facts ADD COLUMN run text, ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX facts_run ON facts (run) WHERE run IS NOT NULL;
ALTER TABLE docs ADD COLUMN run text, ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX docs_run ON docs (run) WHERE run IS NOT NULL;
ALTER TABLE project_links ADD COLUMN run text, ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX project_links_run ON project_links (run) WHERE run IS NOT NULL;
ALTER TABLE predone_checks ADD COLUMN run text;
CREATE INDEX predone_checks_run ON predone_checks (run) WHERE run IS NOT NULL;
ALTER TABLE chat_conversations ADD COLUMN run text;
CREATE INDEX chat_conversations_run ON chat_conversations (run) WHERE run IS NOT NULL;

-- run_cleaned: `fg cleanup --run <id>` (DELETE /api/runs/:id) removed what a run wrote.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned',
  'links_suggested', 'link_decided', 'doc_read', 'comments_skipped', 'lessons_checked', 'lesson_to_fact',
  'misses_reclassified', 'items_reopened', 'session_resumed', 'secrets_redacted', 'run_cleaned'));
