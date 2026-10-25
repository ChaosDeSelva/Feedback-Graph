-- Who made a lesson's last decision: 'you' (the UI) or 'operator:<name>' (an agent holding FG_OPERATOR_TOKEN, allowed
-- lesson_decide by OPERATOR_ALLOW). Null: decided before this was recorded, or never decided.
ALTER TABLE lessons ADD COLUMN decided_by text;
