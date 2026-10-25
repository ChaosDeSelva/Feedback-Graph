-- The import index past the cap: candidate files a capped map leaves out keep their import edges (code_imports from
-- and to them) but no symbols, so importer counts stay right and a file outside the map is still known. in_index: in
-- the latest map's index and not in the map itself (in_map and in_index are never both true).
ALTER TABLE code_files ADD COLUMN in_index boolean NOT NULL DEFAULT false;
CREATE INDEX code_files_project_index ON code_files (project_key, path) WHERE in_index;

-- The map rules a map was built by (core CODE_MAP_VERSION). Null: a map from before maps were versioned; the worker
-- rebuilds any older map from scratch at start.
ALTER TABLE code_maps ADD COLUMN version integer;
