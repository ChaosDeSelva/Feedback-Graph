import type { DocsStore } from '@fb/core';

/**
 * What ingest records about each session (state.ts INGEST_VERSION: the git calls after each message, the branch, the
 * instruction files it had) is evidence that start-up passes judge stored data against: the instruction rule (was a
 * "don't push yet" broken?), the lesson re-check (contradicts-evidence: "did not load AGENTS.md" against the files the
 * session had) and the session re-match. Run before an ingest version bump's re-read has finished, they judge on the
 * old evidence and stamp themselves done: 0.6.1's instruction pass resolved instructions whose session then pushed, and
 * 0.6.2's lesson re-check (v4) could never find a contradiction ingest v5 had not recorded yet.
 *
 * So they wait for the first cycle that read the transcripts through, once per start; and the lesson re-check, which
 * stamps each lesson, is asked for again once per ingest version (EVIDENCE_CURSOR), then logged.
 */
export const EVIDENCE_CURSOR = 'session-evidence';

export type EvidenceGateDeps = {
  ingestVersion: number;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  /** The instruction rule over the pending Inbox (detect/pendingInstructions.ts); its own cursor says when it reruns. */
  instructions: () => Promise<unknown>;
  /** Mark every lesson for a re-check (KnowledgeStore.requestLessonRecheck); unset: the store cannot. */
  requestLessonRecheck?: () => Promise<number>;
  /** The lesson re-check (postmortem/recheck.ts). */
  recheck: () => Promise<unknown>;
  /** The session re-match (postmortem/rematch.ts), after the re-check so its flags are kept. */
  rematch: () => Promise<unknown>;
  log: (msg: string, extra?: object) => void;
};

export class SessionEvidenceGate {
  private d: EvidenceGateDeps;
  /** The lessons were re-checked against evidence of this ingest version (EVIDENCE_CURSOR). */
  private current = false;
  /** A cycle read the transcripts through since this start. */
  private ingested = false;
  private passesRun = false;

  constructor(d: EvidenceGateDeps) {
    this.d = d;
  }

  private get stamp() {
    return `ingest v${this.d.ingestVersion}`;
  }

  async load(): Promise<void> {
    this.current = (await this.d.cursors.getCursor(EVIDENCE_CURSOR)) === this.stamp;
  }

  /** Whether what reads session evidence may run now: the lessons were checked against this version's, or it is read. */
  ready(): boolean {
    return this.current || this.ingested;
  }

  /**
   * The one-off passes have run this start (after its first ingest). Post-mortems wait for it: they read the same
   * evidence, and one made before the session re-match ran would be judged by that pass as made under the old rule.
   */
  settled(): boolean {
    return this.passesRun;
  }

  /** The start's lesson re-check, when the evidence is current; otherwise it waits for afterIngest. */
  async atStart(): Promise<void> {
    if (this.ready()) await this.recheck();
  }

  /** The per-round lesson re-check (its failure waits for the next round). */
  async recheck(): Promise<void> {
    await this.d.recheck().catch((err) => this.d.log('lesson re-check failed', { error: String(err) }));
  }

  /**
   * After a cycle that read the transcripts through. The first time per start: the instruction pass, the lesson
   * re-check (every lesson again when the evidence version changed), then the re-match. Each fails on its own; a failed
   * re-check is tried after the next cycle.
   */
  async afterIngest(): Promise<void> {
    this.ingested = true;
    const first = !this.passesRun;
    this.passesRun = true;
    if (first) await this.d.instructions().catch((err) => this.d.log('instruction rule after ingest failed', { error: String(err) }));
    if (!this.current) {
      try {
        const requeued = (await this.d.requestLessonRecheck?.()) ?? 0;
        await this.d.recheck();
        await this.d.cursors.setCursor(EVIDENCE_CURSOR, this.stamp);
        this.current = true;
        this.d.log('session evidence is current: lessons re-checked against it', { ingestVersion: this.d.ingestVersion, requeued });
      } catch (err) {
        this.d.log('lesson re-check after ingest failed', { error: String(err) });
      }
    }
    if (first) await this.d.rematch().catch((err) => this.d.log('session re-match after ingest failed', { error: String(err) }));
  }
}
