-- The tool calls after a session's last human turn (trailingToolCalls): what the agent did after an instruction when
-- no later message takes it in, so "don't push yet" followed by a push is still seen (GraphStore.callsAfter).
ALTER TABLE sessions ADD COLUMN final_tool_calls jsonb NOT NULL DEFAULT '[]';

-- What a miss is about: 'process' (how the work was handled, not the code) is tied to no file, so it is never "the
-- last miss here" on every file the session edited. Null: about the code.
ALTER TABLE misses ADD COLUMN subject text CONSTRAINT misses_subject_check CHECK (subject IN ('process'));

-- code_not_read: the code that showed what "right" looked like was in the repository, and the session never read it.
ALTER TABLE misses DROP CONSTRAINT misses_cause_check;
ALTER TABLE misses ADD CONSTRAINT misses_cause_check
  CHECK (cause IN ('context_missing', 'context_available_ignored', 'code_not_read', 'requirement_unstated', 'verification_gap', 'implementation_error'));
ALTER TABLE lessons DROP CONSTRAINT lessons_cause_check;
ALTER TABLE lessons ADD CONSTRAINT lessons_cause_check
  CHECK (cause IN ('context_missing', 'context_available_ignored', 'code_not_read', 'requirement_unstated', 'verification_gap', 'implementation_error'));
