-- (:ReadReset {seq, keys}): folders whose project data was deleted (Settings cleanup, project delete). The worker
-- forgets which of their transcripts and memory files it read, so selecting them again reads their history again.
CREATE TABLE read_resets (
  seq  bigserial PRIMARY KEY,
  keys text[] NOT NULL,
  at   timestamptz NOT NULL
);
