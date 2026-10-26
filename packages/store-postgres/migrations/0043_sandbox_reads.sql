-- sandbox_reads: a sandbox run's records reach no one but that run, on every read.
-- A document chunk carries its document's run and sandbox flag, so the nearest-chunk search leaves out other runs'
-- sandbox uploads inside the HNSW scan (as it does facts), before the top k, never after. Existing chunks take theirs
-- from their document.
ALTER TABLE chunks ADD COLUMN run text, ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
UPDATE chunks c SET run = d.run, sandbox = d.sandbox FROM docs d WHERE d.id = c.doc_id AND (d.run IS NOT NULL OR d.sandbox);
-- A pre-done check records whether its run was a sandbox (left out of the Dashboard's catch rate for everyone else),
-- and the agent's session when it passed one (check_before_done's session_id), so the session's evidence lists it.
ALTER TABLE predone_checks ADD COLUMN sandbox boolean NOT NULL DEFAULT false, ADD COLUMN session_id text;
CREATE INDEX predone_checks_session ON predone_checks (session_id) WHERE session_id IS NOT NULL;
