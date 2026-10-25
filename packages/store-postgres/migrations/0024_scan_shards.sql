-- An agentic scan runs one agent pass per shard (package or service) and rescans only the shards that changed:
-- {total, rescanned, failed} for the Projects page. Null for per-file scans and scans from before shards.
ALTER TABLE scan_jobs ADD COLUMN shards jsonb;
