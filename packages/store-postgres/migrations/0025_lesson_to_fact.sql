-- A fact you wrote (origin 'you'): a lesson converted to a fact on the Lessons page. No scan closes or replaces it.
ALTER TABLE facts DROP CONSTRAINT facts_origin_check;
ALTER TABLE facts ADD CONSTRAINT facts_origin_check CHECK (origin IN ('model', 'manifest', 'document', 'you'));
-- It is filed under its project, not a code file or a document: the only fact about neither.
ALTER TABLE facts DROP CONSTRAINT facts_about_one;
ALTER TABLE facts ADD CONSTRAINT facts_about_one CHECK (
  (code_file_id IS NULL) <> (doc_id IS NULL) OR (origin = 'you' AND code_file_id IS NULL AND doc_id IS NULL));

-- Why the last decision on a lesson was made, when it says more than its status (e.g. "converted to a fact"). Null:
-- none given; a later decision without one clears it.
ALTER TABLE lessons ADD COLUMN decision_note text;

-- lesson_to_fact: you (or an agent with the operator token) turned a proposed lesson into a project fact.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced', 'facts_scored', 'fact_relevance_set', 'project_pinned',
  'links_suggested', 'link_decided', 'doc_read', 'comments_skipped', 'lessons_checked', 'lesson_to_fact'));
