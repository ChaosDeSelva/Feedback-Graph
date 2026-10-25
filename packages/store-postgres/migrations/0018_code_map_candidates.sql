-- How many files were worth mapping before the cap (SCAN_MAX_FILES), so a capped map can say what it left out.
-- Null: a map built before this was counted.
ALTER TABLE code_maps ADD COLUMN candidates integer;
