-- A fact the learning loop recorded (origin 'loop', record_fact): a lesson that states how the code is, or what you
-- said more than once. Filed under its project like a fact you wrote, so no scan closes, replaces or re-checks it.
ALTER TABLE facts DROP CONSTRAINT facts_origin_check;
ALTER TABLE facts ADD CONSTRAINT facts_origin_check CHECK (origin IN ('model', 'manifest', 'document', 'you', 'loop'));
ALTER TABLE facts DROP CONSTRAINT facts_about_one;
ALTER TABLE facts ADD CONSTRAINT facts_about_one CHECK (
  (code_file_id IS NULL) <> (doc_id IS NULL) OR (origin IN ('you', 'loop') AND code_file_id IS NULL AND doc_id IS NULL));
-- Its relevance is the loop's ('loop:<policy version>'): like yours, a model never overwrites it.
ALTER TABLE facts DROP CONSTRAINT facts_relevance_by_check;
ALTER TABLE facts ADD CONSTRAINT facts_relevance_by_check CHECK (relevance_by IN ('model', 'you') OR relevance_by LIKE 'operator%' OR relevance_by LIKE 'loop:%');

-- A lesson the loop split off a bundled one (reword_lesson): the lesson it came from. Only such a lesson may be taken
-- back by a rollback (KnowledgeStore.removeLoopLesson).
ALTER TABLE lessons ADD COLUMN split_from text;
