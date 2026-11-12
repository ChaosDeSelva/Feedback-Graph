-- The version of the rules a lesson's derived triggers were worked out by (core TRIGGER_DERIVATION_VERSION). Null: before
-- it was stored, read as 1, so the worker derives them again once (never the owner's: triggers_owned).
ALTER TABLE lessons ADD COLUMN triggers_version integer;
CREATE INDEX lessons_old_triggers ON lessons (created_at, id) WHERE triggers IS NOT NULL AND NOT triggers_owned;
