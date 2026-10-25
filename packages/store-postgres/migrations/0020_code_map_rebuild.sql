-- A rebuild of the code map the owner asked for (POST /api/projects/:key/codemap/rebuild): the worker remaps the
-- project from scratch while this is later than built_at. Null: none asked for.
ALTER TABLE code_maps ADD COLUMN rebuild_requested_at timestamptz;
