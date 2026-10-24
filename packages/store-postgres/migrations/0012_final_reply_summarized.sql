-- The time of the agent's final reply (final_reply_ts) the session's summary has taken in; null: none. A final reply
-- stored after the summary already reached the last turn (a SUMMARY_MAX_DELTA_TURNS update while the agent was still
-- answering) differs from it, so SessionsStore.work lists the session for an update of that reply alone. A rebuild
-- clears it unless it reaches the reply too. Sessions summarized before this migration start with none: each one with
-- a final reply gets that one small update.
ALTER TABLE sessions ADD COLUMN final_reply_summarized_ts text;
