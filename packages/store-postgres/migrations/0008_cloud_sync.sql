-- Feedback Graph Cloud sync runs are logged in Activity (kind cloud_synced). Nothing else is stored: what was sent,
-- to which host and with what result is in the activity row's details. Redefines the list from 0007_import.sql: the
-- latest definition must name every kind in core's ACTIVITY_KINDS (schema.test.ts).
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported'));
