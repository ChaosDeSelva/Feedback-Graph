-- A lesson's triggers (LessonTriggers: path globs, added-line patterns, symbols), as JSON. NULL: never derived (the
-- worker's backfill derives them); empty lists: derived, and nothing specific enough was found.
ALTER TABLE lessons ADD COLUMN triggers jsonb;
-- The owner (or an operator) set them: a re-saved post-mortem keeps them.
ALTER TABLE lessons ADD COLUMN triggers_owned boolean NOT NULL DEFAULT false;
