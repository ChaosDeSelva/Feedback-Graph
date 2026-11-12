-- parked_at: when a queued scan's model first failed the readiness probe in this wait; a scan parked for more than a
-- day is failed with the reason (worker scan/runner.ts). Null once the model answers.
ALTER TABLE scan_jobs ADD COLUMN parked_at timestamptz;
