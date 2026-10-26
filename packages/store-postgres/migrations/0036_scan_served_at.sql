-- served_at: when a scan last gave up its slot after a shard so another project's scan could run. The queue serves the
-- job that has waited longest, counting from here (else from requested_at), so a big scan takes turns shard by shard.
ALTER TABLE scan_jobs ADD COLUMN served_at timestamptz;
