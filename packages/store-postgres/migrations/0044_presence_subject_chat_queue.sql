-- sandbox_presence: the searches skip the per-row run filter while no sandbox record exists (vector.ts
-- sandboxPresence); these partial indexes make that check a lookup, not a scan of every table.
CREATE INDEX IF NOT EXISTS candidates_sandbox ON candidates (id) WHERE sandbox;
CREATE INDEX IF NOT EXISTS lessons_sandbox ON lessons (id) WHERE sandbox;
CREATE INDEX IF NOT EXISTS misses_sandbox ON misses (id) WHERE sandbox;
CREATE INDEX IF NOT EXISTS facts_sandbox ON facts (id) WHERE sandbox;
CREATE INDEX IF NOT EXISTS docs_sandbox ON docs (id) WHERE sandbox;
CREATE INDEX IF NOT EXISTS project_links_sandbox ON project_links (id) WHERE sandbox;
-- An Activity subject is at most 500 characters from now on (core capActivitySubject): older ones are cut the same
-- way, and their details say how long they were.
UPDATE activity
   SET details = coalesce(details, '{}'::jsonb) || jsonb_build_object('subjectChars', length(subject)),
       subject = left(subject, 499) || '…'
 WHERE length(subject) > 500;
-- Ask: while a question waits, how many are ahead of it in its model's line (the worker counts; ChatTurn.queueAhead).
ALTER TABLE chat_turns ADD COLUMN queue_ahead integer;
