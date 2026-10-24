-- Evidence that a session did work rather than only read (core sessionWork(), set by upsertSession from its tool
-- calls): file edits (Edit, Write, MultiEdit, NotebookEdit; Codex apply_patch and file changes) and git commits it
-- ran, with the times of the first and last of them. GraphStore.workSessions links a GitHub or Linear comment only to
-- a session that did work, so a review or Q&A session on the same branch is never taken for the one that wrote the
-- code. Sessions stored before this have none until their transcript is read again (the worker's INGEST_VERSION 2).
ALTER TABLE sessions
  ADD COLUMN work_edits    integer NOT NULL DEFAULT 0,
  ADD COLUMN work_commits  integer NOT NULL DEFAULT 0,
  ADD COLUMN first_work_at timestamptz,
  ADD COLUMN last_work_at  timestamptz;
