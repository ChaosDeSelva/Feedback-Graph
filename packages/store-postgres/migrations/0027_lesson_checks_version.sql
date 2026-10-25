-- The LESSON_CHECKS_VERSION a lesson's checks were made with. Null: checked before the version was stored (or never
-- checked); 0: a re-check was asked for. The worker re-checks proposed and approved lessons older than the current one.
ALTER TABLE lessons ADD COLUMN checks_version integer;
CREATE INDEX lessons_checks_stale ON lessons (created_at) WHERE status IN ('proposed', 'approved');
