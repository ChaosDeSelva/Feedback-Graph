-- Session summaries (SessionsStore, src/sessions.ts): a running summary per session, the cursor of the last turn it
-- covers, its update history, and whether the session is active or idle. Conventions as in 0001_init.sql.
--
-- Summaries come from transcripts: they are redacted before they are stored and never exported or synced.

-- Kept current by upsertSession: turn_count, the last turn (index and time, the text as stored), and last activity
-- (the newest of the session's last event and its last turn), which the Sessions list is ordered by.
-- state null: never set (a session from before summaries), read as 'active'.
-- summary: the redacted summary document. summarized_through_idx / _ts: the cursor (null: nothing summarized).
-- summary_version: how many updates built it (the stage writes only over the version it read).
-- summary_rebuild: the owner asked for a rebuild from the first turn. summary_attempts / _retry_at / _error: backoff.
ALTER TABLE sessions
  ADD COLUMN turn_count             integer,
  ADD COLUMN last_turn_idx          integer,
  ADD COLUMN last_turn_ts           timestamptz,
  ADD COLUMN last_turn_ts_text      text,
  ADD COLUMN last_activity_at       timestamptz,
  ADD COLUMN state                  text CONSTRAINT sessions_state_check CHECK (state IN ('active', 'idle')),
  ADD COLUMN summary                jsonb,
  ADD COLUMN summarized_through_idx integer,
  ADD COLUMN summarized_through_ts  text,
  ADD COLUMN summary_updated_at     timestamptz,
  ADD COLUMN summary_model          text,
  ADD COLUMN summary_version        integer NOT NULL DEFAULT 0,
  ADD COLUMN summary_rebuild        boolean NOT NULL DEFAULT false,
  ADD COLUMN summary_attempts       integer NOT NULL DEFAULT 0,
  ADD COLUMN summary_retry_at       timestamptz,
  ADD COLUMN summary_error          text;
CREATE INDEX sessions_project_activity ON sessions (project_key, (coalesce(last_activity_at, 'epoch'::timestamptz)) DESC, id)
  WHERE NOT manual AND last_turn_idx IS NOT NULL;

-- One row per summary update (Neo4j: Session.summaryHistory). from_idx null: built from the first turn.
CREATE TABLE session_summary_updates (
  session_id  text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  project_key text NOT NULL,
  from_idx    integer,
  from_ts     text,
  to_idx      integer NOT NULL,
  to_ts       text NOT NULL,
  delta_turns integer NOT NULL,
  model       text NOT NULL,
  rebuild     boolean NOT NULL,
  at          timestamptz NOT NULL,
  PRIMARY KEY (session_id, version)
);

-- Sessions stored before this migration get their stats now.
UPDATE sessions s
SET turn_count = x.n, last_turn_idx = x.idx, last_turn_ts = x.ts, last_turn_ts_text = x.ts_text,
    last_activity_at = GREATEST(s.ended_at, x.ts)
FROM (
  SELECT session_id, count(*) AS n,
         (array_agg(idx ORDER BY idx DESC))[1] AS idx,
         (array_agg(ts ORDER BY idx DESC))[1] AS ts,
         (array_agg(ts_text ORDER BY idx DESC))[1] AS ts_text
  FROM turns GROUP BY session_id
) x
WHERE s.id = x.session_id;

-- Summary updates are logged in Activity. Redefines the list from 0008_cloud_sync.sql: the latest definition must name
-- every kind in core's ACTIVITY_KINDS (schema.test.ts).
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'scan_started', 'facts_extracted', 'scan_finished', 'memory_imported', 'candidate_flagged',
  'feedback_decided', 'postmortem_done', 'postmortem_failed', 'lesson_decided', 'context_served',
  'predone_check', 'doc_added', 'doc_removed', 'project_deleted', 'project_aliased', 'projects_selected',
  'projects_cleaned', 'code_mapped', 'cloud_synced', 'turns_requeued', 'bundle_imported', 'session_summarized'));
