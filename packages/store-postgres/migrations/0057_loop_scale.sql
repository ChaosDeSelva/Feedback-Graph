-- The learning loop at scale. An applied decision the loop counted kept (labelUntouched) is marked here, so a round
-- reads only those still waiting for their label instead of every decision it ever applied. Labels counted before this
-- column existed are carried over from their loop-kept:<id> cursors.
ALTER TABLE decisions ADD COLUMN labelled_at timestamptz;
UPDATE decisions d SET labelled_at = now() FROM sync_cursors c WHERE c.key = 'loop-kept:' || d.id;
CREATE INDEX decisions_unlabelled ON decisions (applied_at DESC) WHERE status = 'applied' AND mode = 'auto' AND labelled_at IS NULL;

-- The cloud sync hold: every export reads the decisions held now (sync_hold_until > now()), by this range instead of a
-- table scan. Keyed by the time, not the project: a hold that has passed keeps its sync_hold_until, so an index of
-- every decision ever held would grow with them all.
CREATE INDEX decisions_held ON decisions (sync_hold_until) WHERE status = 'applied' AND ratified_at IS NULL;

-- GET /api/decisions?q=: text in the rationale or a target id, found by trigram index instead of reading every decision.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX decisions_rationale_trgm ON decisions USING gin (lower(rationale) gin_trgm_ops);
CREATE INDEX decision_targets_target_trgm ON decision_targets USING gin (lower(target_id) gin_trgm_ops);
