-- Project roots saved in Settings are logged in Activity (kind roots_saved). The roots themselves live in a file the
-- api writes for scripts/setup.sh (state/settings/project-roots.json), not in the database. Redefines the list from
-- 0009_session_summaries.sql: the latest definition must name every kind in core's ACTIVITY_KINDS (schema.test.ts).
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved'));
