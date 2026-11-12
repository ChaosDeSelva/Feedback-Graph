-- The learning loop's ranking writes (0.8.0). rank_weight: a lesson's serving weight, which reorders the lessons already
-- tied to a task (null: none, served as 1; Neo4j :Lesson.servingWeight). tune_threshold: a project's own similarity
-- floors, set only by a decision the owner approved (null: the defaults; Neo4j :Project.similarityFloor/factRankFloor).
ALTER TABLE lessons ADD COLUMN serving_weight double precision
  CONSTRAINT lessons_serving_weight_check CHECK (serving_weight BETWEEN 0.5 AND 1.5);
ALTER TABLE projects ADD COLUMN similarity_floor double precision
  CONSTRAINT projects_similarity_floor_check CHECK (similarity_floor BETWEEN 0 AND 1);
ALTER TABLE projects ADD COLUMN fact_rank_floor double precision
  CONSTRAINT projects_fact_rank_floor_check CHECK (fact_rank_floor BETWEEN 0 AND 1);
