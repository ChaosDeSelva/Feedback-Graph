-- demo_corpus: `fg demo seed` writes a small, labelled corpus (approved lessons with source 'demo', one miss under a
-- demo: session, facts with source 'demo') so a tester's project has something for the lesson path to serve, and
-- `fg demo remove` takes back exactly it. Logged as demo_seeded and demo_removed.
ALTER TABLE lessons DROP CONSTRAINT lessons_source_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_source_check CHECK (source IN ('postmortem', 'memory', 'manual', 'demo'));
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned',
  'links_suggested', 'link_decided', 'doc_read', 'comments_skipped', 'lessons_checked', 'lesson_to_fact',
  'misses_reclassified', 'items_reopened', 'session_resumed', 'secrets_redacted', 'run_cleaned', 'demo_seeded', 'demo_removed'));
