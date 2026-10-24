-- Comments from GitHub pull requests and Linear issues become Inbox items (GraphStore.upsertExternalThread). Each PR or
-- issue is a stand-in session (manual: never listed or summarized) with source 'github' or 'linear', and each comment
-- one of its turns; turns.external holds the comment's details (author, url, title, file and line, branch, linked
-- agent sessions). Candidates take their session's source, so both source constraints grow.
ALTER TABLE turns ADD COLUMN external jsonb;

ALTER TABLE sessions DROP CONSTRAINT sessions_source_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_source_check CHECK (source IN ('claude', 'codex', 'github', 'linear'));
ALTER TABLE candidates DROP CONSTRAINT candidates_source_check;
ALTER TABLE candidates ADD CONSTRAINT candidates_source_check CHECK (source IN ('claude', 'codex', 'github', 'linear'));

-- Finding the agent session that did the work a comment is about: by project and branch.
CREATE INDEX sessions_project_branch ON sessions (project_key, git_branch) WHERE NOT manual;

-- Connecting or disconnecting an integration, and each sync that brought comments in, are logged in Activity.
-- Redefines the list from 0013_roots_saved.sql: the latest definition must name every kind in core's
-- ACTIVITY_KINDS (schema.test.ts).
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized',
  'roots_saved', 'integration_changed', 'feedback_synced'));
