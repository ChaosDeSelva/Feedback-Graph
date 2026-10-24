-- The agent's final reply (ParsedSession.finalReply): its last text after the last human turn, redacted, kept on the
-- session by upsertSession so a summary can take it in. It is not a turn, so nothing classifies it. Retention
-- (pruneTurnText) clears it with the session's turns. Like summaries, it is never exported or synced.
ALTER TABLE sessions
  ADD COLUMN final_reply_text text,
  ADD COLUMN final_reply_ts   text;
