-- lesson_proposed_as: what the post-mortem proposed (title, rule, applies_when, scope, paths), kept the first time the
-- owner edits a proposed lesson's words, paths or scope. Null: never edited while proposed, so an approved lesson was
-- approved as written. The post-mortem shows this project's edited pairs and rejections to the writer as examples, and
-- the Lessons page counts approved as written / after an edit / rejected. Lessons edited before this have none.
ALTER TABLE lessons ADD COLUMN proposed_as jsonb;
CREATE INDEX lessons_decided ON lessons (decided_at DESC) WHERE source = 'postmortem' AND status IN ('approved', 'rejected');
