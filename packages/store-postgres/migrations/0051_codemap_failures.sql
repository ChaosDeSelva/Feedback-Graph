ALTER TABLE code_maps ADD COLUMN last_failure_at timestamptz;
ALTER TABLE code_maps ADD COLUMN last_failure text;
