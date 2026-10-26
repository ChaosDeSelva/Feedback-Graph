-- secrets_redacted: wider redaction rules (REDACTION_VERSION) ran once at worker start over the facts, document chunks
-- and lessons stored under older ones (worker redactStored.ts). Counts only; never the secret.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned',
  'links_suggested', 'link_decided', 'doc_read', 'comments_skipped', 'lessons_checked', 'lesson_to_fact',
  'misses_reclassified', 'items_reopened', 'session_resumed', 'secrets_redacted'));
