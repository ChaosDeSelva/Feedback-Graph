-- session_instruction_files: the instruction files (CLAUDE.md, AGENTS.md, memory notes) a session's transcript shows
-- its agent had (worker ingest/instructions.ts). NULL: read before they were recorded; ingest v5 reads it again.
ALTER TABLE sessions ADD COLUMN instruction_files jsonb;
