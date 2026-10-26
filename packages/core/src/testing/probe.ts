/**
 * What the contract suites need to see or set up that no Store method offers: test-only, per backend
 * (Neo4jProbe here, PostgresProbe in @fb/store-postgres). A probe reads storage directly, so it pins down what is
 * stored without each suite knowing Cypher or SQL. Production code never uses one.
 */

/** The record kinds, named after the Neo4j labels. */
export type ProbeKind =
  | 'Project'
  | 'Session'
  | 'Turn'
  | 'Commit'
  | 'Candidate'
  | 'Feedback'
  | 'Task'
  | 'Miss'
  | 'Cause'
  | 'Lesson'
  | 'ContextItem'
  | 'PreDoneCheck'
  | 'CodeFile'
  | 'Symbol'
  | 'Fact'
  | 'ScanJob'
  | 'Doc'
  | 'Chunk'
  | 'Activity'
  | 'SyncCursor';

/** An embedded record with just the fields its embedding text is built from, as an older store might hold it. */
export type EmbeddedSeed =
  | { kind: 'Lesson'; id: string; title: string; rule: string; appliesWhen?: string; status?: 'proposed' | 'approved'; embedding: number[] }
  | { kind: 'Miss'; id: string; missed: string; causeExplanation: string; embedding: number[] }
  | { kind: 'Fact'; id: string; path: string; statement: string; current: boolean; origin?: 'model' | 'you'; docId?: string; embedding: number[] }
  | { kind: 'Chunk'; id: string; text: string; embedding: number[] };

/**
 * Text as older redaction rules left it, written past the redaction at the door: an Inbox item (its turn, feedback and
 * miss), a session's summary and final reply, an Activity entry.
 */
export type StaleTextSeed =
  | {
      kind: 'InboxItem'; id: string; text: string; context: string; summary: string; note: string;
      agentReport: Record<string, unknown> | null; feedbackText: string; missed: string; causeExplanation: string;
    }
  | { kind: 'Session'; id: string; summary: Record<string, unknown>; finalReply: string }
  | { kind: 'Activity'; id: string; subject: string; why: string; details: Record<string, unknown> }
  /**
   * An Ask conversation `id` with a user turn (question, pack context) and its assistant turn, left pending so
   * nextPendingTurn returns the stored context, holding an answer and sources.
   */
  | { kind: 'ChatTurns'; id: string; question: string; context: string; answer: Record<string, unknown>; sources: Record<string, unknown>[] };

export type PreDoneCheckRow = {
  projectKey: string;
  task: string;
  checked: number;
  gaps: number;
  /** The CHECKED links, by lesson id. */
  lessons: { lessonId: string; gap: boolean }[];
  /** The agent's session it was made in; absent when none was given. */
  sessionId?: string;
};

export interface StoreProbe {
  /** Delete every record (the schema stays). Runs before each contract test. */
  wipe(): Promise<void>;
  count(kind: ProbeKind): Promise<number>;
  /** Identities of every record of a kind, sorted: Project/Cause/SyncCursor key, Turn uuid, Commit sha, otherwise id. */
  ids(kind: ProbeKind): Promise<string[]>;
  /** Every stored value of every record of a kind, vectors left out. Field names are the backend's own: use for content checks only. */
  rows(kind: ProbeKind): Promise<Record<string, unknown>[]>;
  project(key: string): Promise<{ key: string; remote: string | null; aliases: string[]; repoPath: string | null } | null>;
  /** The source stored on a session ('claude' | 'codex'), null when none was stored (or no such session). */
  sessionSource(id: string): Promise<string | null>;
  turn(uuid: string): Promise<{ text: string | null; precedingAssistantText: string | null } | null>;
  feedbackStatus(id: string): Promise<string | null>;
  /** Every fact with this statement, current or closed (closed: it has a validTo). */
  factVersions(statement: string): Promise<{ current: boolean; closed: boolean }[]>;
  preDoneChecks(): Promise<PreDoneCheckRow[]>;
  /** Kinds of the records still filed under a project key: its projectKey, a lesson's origin, or the project itself. Sorted. */
  filedUnder(key: string): Promise<ProbeKind[]>;
  /** Vectors by record id across lessons, misses, facts and chunks; null where none is stored. */
  embeddings(): Promise<Record<string, number[] | null>>;
  /** Overwrite fields of an existing project directly, bypassing the aliasing rules. */
  setProject(key: string, fields: { remote?: string | null; aliases?: string[] }): Promise<void>;
  /** A record filed under a project key that has no project of its own, as older stores hold them. */
  seedOrphan(row: { kind: 'Lesson' | 'Doc'; id: string; projectKey: string }): Promise<void>;
  /** An embedded record with only the fields its embedding text needs (a backend may add placeholder parents). */
  seedEmbedded(row: EmbeddedSeed): Promise<void>;
  /** Text stored under older redaction rules (StaleTextSeed), with placeholder parents where a backend needs them. */
  seedStaleText(row: StaleTextSeed): Promise<void>;
  /** Mark a lesson decided by you, as the rule before 0.6.2 marked every decision, a machine's too. */
  seedOwnerMark(lessonId: string): Promise<void>;
}
