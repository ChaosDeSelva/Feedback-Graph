-- Who made the last decision on a project link: 'you' (the UI) or 'operator:<name>' (an agent holding
-- FG_OPERATOR_TOKEN). Null: a detected suggestion nobody has decided, or decided before this was recorded.
ALTER TABLE project_links ADD COLUMN decided_by text;
