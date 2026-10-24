-- Scan jobs back off like post-mortems (FactsStore.recordScanFailure): a real failure counts an attempt and waits
-- (scanRetryAt) before it runs again, giving up after MAX_SCAN_ATTEMPTS; a model that could not be asked never counts,
-- it only waits. nextScanJob skips a job whose retry_at is still ahead. No CHECK constraint changes here.
ALTER TABLE scan_jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE scan_jobs ADD COLUMN retry_at timestamptz;
