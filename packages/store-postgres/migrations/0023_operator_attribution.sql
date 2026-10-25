-- Who made an owner decision, on the record itself and not only in Activity: 'you' (the UI) or 'operator:<name>' (an
-- agent holding FG_OPERATOR_TOKEN). Null: undecided, or decided before this was recorded.
ALTER TABLE candidates ADD COLUMN decided_by text;
-- Who uploaded a document on the Projects page. Null for PR discussions, tickets and older uploads.
ALTER TABLE docs ADD COLUMN added_by text;
-- A fact's relevance can now be set by an agent with the operator token too ('operator:<name>'); a model still never
-- overwrites anything but its own score.
ALTER TABLE facts DROP CONSTRAINT facts_relevance_by_check;
ALTER TABLE facts ADD CONSTRAINT facts_relevance_by_check CHECK (relevance_by IN ('model', 'you') OR relevance_by LIKE 'operator%');
