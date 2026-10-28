-- A run can register a real session before its transcript reaches the worker.
CREATE TABLE session_run_tags (
  session_id text PRIMARY KEY,
  run text NOT NULL,
  sandbox boolean NOT NULL DEFAULT false
);
CREATE INDEX session_run_tags_run ON session_run_tags (run);
ALTER TABLE sessions ADD COLUMN run text;
ALTER TABLE sessions ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX sessions_run ON sessions (run);
ALTER TABLE feedback ADD COLUMN run text;
ALTER TABLE feedback ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
CREATE INDEX feedback_run ON feedback (run);
-- Preserve attribution already carried by reports confirmed before this migration.
UPDATE feedback f SET run = k.run, sandbox = k.sandbox FROM candidates k WHERE k.id = f.id AND k.run IS NOT NULL;
