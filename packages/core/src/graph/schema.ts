export const SCHEMA = [
  'CREATE CONSTRAINT project_key IF NOT EXISTS FOR (n:Project) REQUIRE n.key IS UNIQUE',
  'CREATE INDEX project_remote IF NOT EXISTS FOR (n:Project) ON (n.remote)',
  'CREATE CONSTRAINT session_run_id IF NOT EXISTS FOR (n:SessionRun) REQUIRE n.sessionId IS UNIQUE',
  'CREATE CONSTRAINT session_id IF NOT EXISTS FOR (n:Session) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT turn_uuid IF NOT EXISTS FOR (n:Turn) REQUIRE n.uuid IS UNIQUE',
  'CREATE CONSTRAINT commit_sha IF NOT EXISTS FOR (n:Commit) REQUIRE n.sha IS UNIQUE',
  'CREATE CONSTRAINT candidate_id IF NOT EXISTS FOR (n:Candidate) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT feedback_id IF NOT EXISTS FOR (n:Feedback) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX turn_label IF NOT EXISTS FOR (n:Turn) ON (n.label)',
  'CREATE INDEX candidate_status IF NOT EXISTS FOR (n:Candidate) ON (n.status)',
  'CREATE CONSTRAINT miss_id IF NOT EXISTS FOR (n:Miss) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT lesson_id IF NOT EXISTS FOR (n:Lesson) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT distinct_pair_key IF NOT EXISTS FOR (n:DistinctPair) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT task_id IF NOT EXISTS FOR (n:Task) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT context_id IF NOT EXISTS FOR (n:ContextItem) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT cause_key IF NOT EXISTS FOR (n:Cause) REQUIRE n.key IS UNIQUE',
  'CREATE INDEX lesson_status IF NOT EXISTS FOR (n:Lesson) ON (n.status)',
  'CREATE INDEX lesson_project_status IF NOT EXISTS FOR (n:Lesson) ON (n.projectKey, n.status)',
  'CREATE INDEX miss_project IF NOT EXISTS FOR (n:Miss) ON (n.projectKey)',
  'CREATE INDEX chunk_project IF NOT EXISTS FOR (n:Chunk) ON (n.projectKey)',
  `CREATE VECTOR INDEX lesson_embedding IF NOT EXISTS FOR (n:Lesson) ON n.embedding
     OPTIONS {indexConfig: {\`vector.dimensions\`: 768, \`vector.similarity_function\`: 'cosine'}}`,
  `CREATE VECTOR INDEX miss_embedding IF NOT EXISTS FOR (n:Miss) ON n.embedding
     OPTIONS {indexConfig: {\`vector.dimensions\`: 768, \`vector.similarity_function\`: 'cosine'}}`,
  'CREATE CONSTRAINT codefile_id IF NOT EXISTS FOR (n:CodeFile) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT fact_id IF NOT EXISTS FOR (n:Fact) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT scanjob_id IF NOT EXISTS FOR (n:ScanJob) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX fact_project IF NOT EXISTS FOR (n:Fact) ON (n.projectKey, n.current)',
  'CREATE INDEX fact_doc IF NOT EXISTS FOR (n:Fact) ON (n.docId)',
  'CREATE INDEX doc_read IF NOT EXISTS FOR (n:Doc) ON (n.readStatus)',
  'CREATE INDEX docblob_doc IF NOT EXISTS FOR (n:DocBlob) ON (n.docId)',
  'CREATE CONSTRAINT projectlink_id IF NOT EXISTS FOR (n:ProjectLink) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX codefile_project IF NOT EXISTS FOR (n:CodeFile) ON (n.projectKey)',
  // The map's files (`{projectKey} WHERE inMap = true`): most CodeFile nodes of a scanned project are not in its map.
  'CREATE INDEX codefile_project_inmap IF NOT EXISTS FOR (n:CodeFile) ON (n.projectKey, n.inMap)',
  // The import index past the cap (`WHERE inIndex = true`): files a capped map left out, with their edges.
  'CREATE INDEX codefile_project_inindex IF NOT EXISTS FOR (n:CodeFile) ON (n.projectKey, n.inIndex)',
  // Files an agent asked to have scanned: the scan queue's order reads each queued project's oldest request.
  'CREATE INDEX codefile_project_requested IF NOT EXISTS FOR (n:CodeFile) ON (n.projectKey, n.scanRequestedAt)',
  'CREATE INDEX scanjob_status IF NOT EXISTS FOR (n:ScanJob) ON (n.status)',
  // Per-project lookups (`{projectKey: ...}`): the projects list counts feedback and finds the last scan of every
  // project, the Docs list pages a project's documents; without these each one reads every node of the label.
  ...['Feedback', 'ScanJob', 'Doc', 'Candidate', 'Module'].map(
    (label) => `CREATE INDEX ${label.toLowerCase()}_project IF NOT EXISTS FOR (n:${label}) ON (n.projectKey)`,
  ),
  `CREATE VECTOR INDEX fact_embedding IF NOT EXISTS FOR (n:Fact) ON n.embedding
     OPTIONS {indexConfig: {\`vector.dimensions\`: 768, \`vector.similarity_function\`: 'cosine'}}`,
  'CREATE CONSTRAINT activity_id IF NOT EXISTS FOR (n:Activity) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX activity_order IF NOT EXISTS FOR (n:Activity) ON (n.order)',
  'CREATE INDEX activity_project IF NOT EXISTS FOR (n:Activity) ON (n.projectKey)',
  // The log by kind in its order (the loop's fold, record_fact, tune_threshold), and by the records an entry names: a
  // list property has no index, so each entry -[:ABOUT]-> an (:ActivityTarget {id}) key per target (graph/activity.ts).
  'CREATE INDEX activity_kind_order IF NOT EXISTS FOR (n:Activity) ON (n.kind, n.order)',
  'CREATE CONSTRAINT activity_target_id IF NOT EXISTS FOR (n:ActivityTarget) REQUIRE n.id IS UNIQUE',
  // Start-up work the api and the worker must not both do, and one-off upgrades (graph/schemaTasks.ts).
  'CREATE CONSTRAINT schema_task_id IF NOT EXISTS FOR (n:SchemaTask) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT doc_id IF NOT EXISTS FOR (n:Doc) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (n:Chunk) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT project_selection_id IF NOT EXISTS FOR (n:ProjectSelection) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT project_candidates_id IF NOT EXISTS FOR (n:ProjectCandidates) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT ingest_lock_id IF NOT EXISTS FOR (n:IngestLock) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT read_reset_seq IF NOT EXISTS FOR (n:ReadReset) REQUIRE n.seq IS UNIQUE',
  'CREATE CONSTRAINT read_reset_counter_id IF NOT EXISTS FOR (n:ReadResetSeq) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT sync_cursor IF NOT EXISTS FOR (n:SyncCursor) REQUIRE n.key IS UNIQUE',
  'CREATE INDEX symbol_project_path IF NOT EXISTS FOR (n:Symbol) ON (n.projectKey, n.path)',
  'CREATE CONSTRAINT module_id IF NOT EXISTS FOR (n:Module) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT codemap_project IF NOT EXISTS FOR (n:CodeMap) REQUIRE n.projectKey IS UNIQUE',
  'CREATE INDEX session_activity IF NOT EXISTS FOR (n:Session) ON (n.lastActivityAt)',
  'CREATE CONSTRAINT chat_conversation_id IF NOT EXISTS FOR (n:ChatConversation) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT chat_turn_id IF NOT EXISTS FOR (n:ChatTurn) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX chat_turn_conversation IF NOT EXISTS FOR (n:ChatTurn) ON (n.conversationId)',
  'CREATE INDEX chat_turn_status IF NOT EXISTS FOR (n:ChatTurn) ON (n.status)',
  'CREATE INDEX chat_conversation_project IF NOT EXISTS FOR (n:ChatConversation) ON (n.projectKey)',
  `CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS FOR (n:Chunk) ON n.embedding
     OPTIONS {indexConfig: {\`vector.dimensions\`: 768, \`vector.similarity_function\`: 'cosine'}}`,
  // Runs (x-fg-run): Activity filters by it; cleanup finds each kind's records by it.
  ...['Activity', 'Candidate', 'Lesson', 'Miss', 'PreDoneCheck', 'Fact', 'Doc', 'ProjectLink', 'ChatConversation'].map(
    (label) => `CREATE INDEX ${label.toLowerCase()}_run IF NOT EXISTS FOR (n:${label}) ON (n.run)`,
  ),
  // Who opened each run (RunsStore.claim): unique, so two first writes racing MERGE into one owner.
  'CREATE CONSTRAINT run_owner_run IF NOT EXISTS FOR (n:RunOwner) REQUIRE n.run IS UNIQUE',
  // The learning loop (graph/decisions.ts). Decisions are listed by status, type, project, age and when applied, and
  // the held ones (cloud sync hold) found by syncHoldUntil; notes by decision.
  'CREATE CONSTRAINT decision_id IF NOT EXISTS FOR (n:Decision) REQUIRE n.id IS UNIQUE',
  ...['status', 'type', 'projectKey', 'createdAt', 'appliedAt', 'syncHoldUntil'].map((p) => `CREATE INDEX decision_${p.toLowerCase()} IF NOT EXISTS FOR (n:Decision) ON (n.${p})`),
  'CREATE CONSTRAINT decision_target_id IF NOT EXISTS FOR (n:DecisionTarget) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT decision_note_id IF NOT EXISTS FOR (n:DecisionNote) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX decision_note_decision IF NOT EXISTS FOR (n:DecisionNote) ON (n.decisionId)',
  'CREATE CONSTRAINT lesson_signals_lesson IF NOT EXISTS FOR (n:LessonSignals) REQUIRE n.lessonId IS UNIQUE',
  'CREATE CONSTRAINT loop_calibration_key IF NOT EXISTS FOR (n:LoopCalibration) REQUIRE n.key IS UNIQUE',
  // Knowledge intake (graph/intake.ts). Claims are reviewed by project and status, questions and conflicts by status;
  // a conflict's sides are found by the records they name (conflictsFor), a source's records by their Doc.
  'CREATE CONSTRAINT person_id IF NOT EXISTS FOR (n:Person) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (n:Claim) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT question_id IF NOT EXISTS FOR (n:Question) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT conflict_id IF NOT EXISTS FOR (n:Conflict) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT person_alias_norm IF NOT EXISTS FOR (n:PersonAlias) REQUIRE n.norm IS UNIQUE',
  'CREATE INDEX claim_project_status IF NOT EXISTS FOR (n:Claim) ON (n.projectKey, n.status)',
  // Export and sync find the claim behind each claim fact (graph/portability.ts).
  'CREATE INDEX claim_fact IF NOT EXISTS FOR (n:Claim) ON (n.factId)',
  'CREATE INDEX conflict_status IF NOT EXISTS FOR (n:Conflict) ON (n.status)',
  'CREATE INDEX question_status IF NOT EXISTS FOR (n:Question) ON (n.status)',
  'CREATE INDEX conflict_side_a IF NOT EXISTS FOR (n:Conflict) ON (n.aId)',
  'CREATE INDEX conflict_side_b IF NOT EXISTS FOR (n:Conflict) ON (n.bId)',
  ...['Claim', 'Question'].map((label) => `CREATE INDEX ${label.toLowerCase()}_doc IF NOT EXISTS FOR (n:${label}) ON (n.docId)`),
  ...['Claim', 'Question', 'Conflict'].map((label) => `CREATE INDEX ${label.toLowerCase()}_run IF NOT EXISTS FOR (n:${label}) ON (n.run)`),
  `CREATE VECTOR INDEX claim_embedding IF NOT EXISTS FOR (n:Claim) ON n.embedding
     OPTIONS {indexConfig: {\`vector.dimensions\`: 768, \`vector.similarity_function\`: 'cosine'}}`,
  // One GraphConfig per id. Two services MERGEing one at once before this constraint could make two: the newest
  // (updatedAt) is kept, so the constraint can be created on a store that has them.
  `MATCH (c:GraphConfig) WITH c ORDER BY coalesce(c.updatedAt, '') DESC, elementId(c)
   WITH c.id AS id, collect(c) AS nodes WHERE size(nodes) > 1
   UNWIND tail(nodes) AS extra DETACH DELETE extra`,
  'CREATE CONSTRAINT graph_config_id IF NOT EXISTS FOR (n:GraphConfig) REQUIRE n.id IS UNIQUE',
];

export const EMBEDDING_DIMENSIONS = 768;
