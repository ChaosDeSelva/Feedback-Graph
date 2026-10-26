-- sessions_rematched: at worker start, once per session-matching rule version, pending synced comments are matched to
-- the session that did their work again, and proposed lessons built on a session the new rule does not match are
-- flagged wrong-session (worker postmortem/rematch.ts). Logged as sessions_rematched.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned',
  'links_suggested', 'link_decided', 'doc_read', 'comments_skipped', 'lessons_checked', 'lesson_to_fact',
  'misses_reclassified', 'items_reopened', 'session_resumed', 'secrets_redacted', 'run_cleaned', 'demo_seeded', 'demo_removed',
  'sessions_rematched'));
