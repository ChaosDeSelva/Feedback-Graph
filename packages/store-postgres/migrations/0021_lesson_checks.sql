-- What the lesson check found on a proposed lesson ([{name, why}], worker postmortem/lessonCheck.ts), shown to the
-- owner as chips before they decide. Null: never checked (proposed before the checks were stored; the worker re-checks
-- those once). An empty array: checked, nothing found.
ALTER TABLE lessons ADD COLUMN checks jsonb;

-- comments_skipped: GitHub and Linear comments a skip rule kept from the classifier, counted per rule each cycle.
-- lessons_checked: the one-off re-check of lessons proposed before the checks were stored.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned',
  'links_suggested', 'link_decided', 'doc_read', 'comments_skipped', 'lessons_checked'));
