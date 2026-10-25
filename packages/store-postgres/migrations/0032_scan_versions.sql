-- The scanner (prompt and reader) version that last read each file: a file an older scanner read is rescanned even
-- when its hash is unchanged. Null: read before versions were recorded, so by an older scanner.
-- hash_changed_at: when a scan first saw the file at its current hash, so a fact refreshed during a session from a file
-- that changed during it can be told apart from prior knowledge. Null: not recorded yet.
-- scan_requested_at: an agent named the file and it had no facts; the next scan reads it first. Null: not asked for.
ALTER TABLE code_files
  ADD COLUMN scan_version text,
  ADD COLUMN hash_changed_at timestamptz,
  ADD COLUMN scan_requested_at timestamptz;
CREATE INDEX code_files_scan_requested ON code_files (project_key, scan_requested_at) WHERE scan_requested_at IS NOT NULL;

-- The citation rule that last checked a fact: facts checked by an older rule (or never, null) are checked again once.
ALTER TABLE facts ADD COLUMN check_version text;
