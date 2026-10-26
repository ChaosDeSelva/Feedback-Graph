-- data_safety
-- Why the startup redaction re-run closed a fact ('credential' or 'instruction'), so a later rule that no longer reads
-- a statement as an instruction can serve it again. Facts closed before this was recorded have none.
ALTER TABLE facts ADD COLUMN close_reason text;
