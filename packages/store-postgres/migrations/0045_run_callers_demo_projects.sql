-- run_callers_demo_projects
-- A run belongs to the caller that opened it, not only to its kind of credential: an operator-token run records the
-- operator's name (operator:<name>, from X-FG-Operator / fg --as), and another name may neither write under it nor
-- clean it up. Null: not an operator run, or one opened before names were recorded (any operator name may, as before).
ALTER TABLE run_owners ADD COLUMN actor text;
-- The demo seed marks a project it created, so fg demo remove takes the project back too once nothing else is stored
-- under its key. Projects that exist now were not created by a seed that recorded it: none is marked.
ALTER TABLE projects ADD COLUMN demo_created boolean NOT NULL DEFAULT false;
-- The default Activity feed is what happened outside test runs (GET /api/activity without run=): newest first over
-- the unlabelled entries, however many a stress run logged.
CREATE INDEX activity_unlabelled ON activity (seq DESC) WHERE run IS NULL;
