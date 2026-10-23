-- One miss, two reports (core dedupe.ts): an agent's report_feedback and the detector's flag on the same turn are one
-- Inbox item that keeps both provenances. agent_report: what the agent reported ({text, whatWasDone, reportedAt,
-- sessionId}); detected: a report the detector then found in the transcript (detected_turn_uuid: that turn, when the
-- report had already been decided and so stayed on its own turn).
ALTER TABLE candidates
  ADD COLUMN detected boolean NOT NULL DEFAULT false,
  ADD COLUMN detected_turn_uuid text,
  ADD COLUMN agent_report jsonb;
CREATE INDEX candidates_manual_created ON candidates (project_key, created_at) WHERE manual;
