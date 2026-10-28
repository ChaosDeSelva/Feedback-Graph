import { repairV6Sources } from './v6Recovery.ts';
import { REDACTION_VERSION, type ActivityStore, type ChatStore, type DocsStore, type FactsStore, type GraphStore, type KnowledgeStore, type SessionsStore } from '@fb/core';

/**
 * A redaction rule change migrates its data. Everything is redacted on the way in, but only by the rules of the day:
 * a secret stored before a pattern existed (a `const API_KEY = "..."` line in a fact, "the password is ..." in an
 * image's description or a pushback) stays readable until the new rules run over it. This runs them once per
 * REDACTION_VERSION, at worker start, over every kind of stored text agents or the owner are shown, and logs the
 * counts per kind in Activity (never what was redacted).
 */

/** Where the redaction version last applied to stored data is kept. */
export const REDACTION_CURSOR = 'redaction-rules';

export type RedactStoredDeps = {
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  facts: Pick<FactsStore, 'redactStoredFacts'> & Partial<Pick<FactsStore, 'reopenInstructionFacts'>>;
  docs: Pick<DocsStore, 'redactStoredDocs'>;
  knowledge: Pick<KnowledgeStore, 'redactStoredLessons' | 'redactStoredMisses'>;
  graph?: Pick<GraphStore, 'redactStoredCandidates'>;
  sessions?: Pick<SessionsStore, 'redactStoredSummaries'>;
  /** Ask: each question, its stored pack, the answer and its sources. */
  chats?: Pick<ChatStore, 'redactStoredTurns'>;
  activity?: Pick<ActivityStore, 'record'> & Partial<Pick<ActivityStore, 'list' | 'redactStoredActivity'>>;
  repair?: Parameters<typeof repairV6Sources>[0];
  log?: (msg: string, extra?: object) => void;
};

/**
 * lessonsFlagged: approved lessons a rule read a credential in, flagged and not changed. chatTurns: Ask messages.
 * reopenedFacts: document facts an older rule closed as instructions that the current rule reads as facts, current again.
 */
export type RedactStoredResult = {
  facts: number; closed: number; ownerFacts: number; instructionFacts: number; reopenedFacts: number; chunks: number; lessons: number; lessonsFlagged: number;
  misses: number; candidates: number; sessions: number; chatTurns: number; activity: number;
};

/** What rules v2 did, from its own Activity entry: the only record of it (v2 kept no copy of the text it replaced). */
type V2Counts = { facts: number; factsClosed: number; chunks: number; lessons: number };

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

async function v2Counts(d: RedactStoredDeps): Promise<V2Counts | null> {
  const list = await d.activity?.list?.({ kind: 'secrets_redacted', limit: 50 });
  const e = list?.find((a) => a.details?.version === 2);
  if (!e) return null;
  const c = { facts: num(e.details.facts), factsClosed: num(e.details.factsClosed), chunks: num(e.details.chunks), lessons: num(e.details.lessons) };
  return c.facts || c.chunks || c.lessons ? c : null;
}

/**
 * Null when the stored data is already under the current rules. A failure leaves the old version recorded, so the
 * next start runs again (each step is idempotent: text the rules leave alone is not written).
 */
export async function redactStoredOnRuleChange(d: RedactStoredDeps): Promise<RedactStoredResult | null> {
  const stamp = `v${REDACTION_VERSION}`;
  const last = await d.cursors.getCursor(REDACTION_CURSOR);
  if (d.repair && (last === 'v6' || await d.cursors.getCursor('redaction-v6-repair-needed') === 'yes')) {
    await d.cursors.setCursor('redaction-v6-repair-needed', 'yes');
    await repairV6Sources(d.repair);
    await d.cursors.setCursor('redaction-v6-repair-needed', 'done');
  }
  if (last === stamp) return null;
  // Rules v2 redacted ordinary prose ("the primary key is user_id2") and closed such facts as credentials. Read what
  // it did before this run touches the log.
  const v2 = last === 'v2' ? await v2Counts(d) : null;
  // Before the current rule runs over the facts: what an older rule closed as an instruction and is a fact now.
  const reopenedFacts = (await d.facts.reopenInstructionFacts?.()) ?? 0;
  const f = (await d.facts.redactStoredFacts?.()) ?? { redacted: 0, closed: 0, owner: 0, instructions: 0 };
  const chunks = (await d.docs.redactStoredDocs?.()) ?? 0;
  const l = (await d.knowledge.redactStoredLessons?.()) ?? { redacted: 0, flagged: 0 };
  const misses = (await d.knowledge.redactStoredMisses?.()) ?? 0;
  const candidates = (await d.graph?.redactStoredCandidates?.()) ?? 0;
  const sessions = (await d.sessions?.redactStoredSummaries?.()) ?? 0;
  const chatTurns = (await d.chats?.redactStoredTurns?.()) ?? 0;
  // The log last, so the entry below is not itself rewritten.
  const activity = (await d.activity?.redactStoredActivity?.()) ?? 0;
  const r: RedactStoredResult = {
    facts: f.redacted, closed: f.closed, ownerFacts: f.owner, instructionFacts: f.instructions, reopenedFacts, chunks, lessons: l.redacted, lessonsFlagged: l.flagged, misses, candidates, sessions, chatTurns, activity,
  };
  const changed = [
    r.facts && n(r.facts, 'fact'), r.chunks && n(r.chunks, 'document text'), r.lessons && n(r.lessons, 'lesson'),
    r.misses && n(r.misses, 'miss', 'misses'), r.candidates && n(r.candidates, 'Inbox item'),
    r.sessions && n(r.sessions, 'session summary', 'session summaries'), r.chatTurns && n(r.chatTurns, 'Ask message'),
    r.activity && n(r.activity, 'Activity entry', 'Activity entries'),
  ].filter(Boolean) as string[];
  const one = r.lessonsFlagged === 1;
  // Not text changes, but the owner is told of them all the same.
  const other = [
    r.instructionFacts && `${n(r.instructionFacts, 'fact')} from uploads closed`, r.reopenedFacts && `${n(r.reopenedFacts, 'fact')} from uploads served again`, r.lessonsFlagged && `${n(r.lessonsFlagged, 'approved lesson')} flagged`,
  ].filter(Boolean) as string[];
  if (changed.length || other.length || v2) {
    await d.activity?.record({
      kind: 'secrets_redacted', actor: 'deterministic', projectKey: null,
      subject: `redaction rules ${stamp} applied to stored data: ${changed.length ? `${changed.join(', ')} changed` : other.length ? other.join(', ') : 'nothing changed'}`,
      why: `${last ? `the redaction rules changed (${last} to ${stamp})` : `data stored before redaction rules ${stamp}`}: credentials in code, config, command-line flags and prose are redacted; keys, identifiers, paths and versions are not`
        + (r.closed ? `; ${n(r.closed, 'fact')} that ${r.closed === 1 ? 'was a credential is' : 'were credentials are'} no longer served` : '')
        + (r.ownerFacts ? `; ${n(r.ownerFacts, 'fact')} you wrote kept, with only a known token shape redacted in ${r.ownerFacts === 1 ? 'it' : 'them'}` : '')
        + (r.instructionFacts ? `; ${n(r.instructionFacts, 'fact')} from an upload that ${r.instructionFacts === 1 ? 'was an instruction to the agent is' : 'were instructions to the agent are'} no longer served (an upload is data, not instructions)` : '')
        + (r.reopenedFacts ? `; ${n(r.reopenedFacts, 'fact')} from uploads that an older rule took for instructions to the agent ${r.reopenedFacts === 1 ? 'is' : 'are'} served again: project conventions ("always run the tests before committing") are facts` : '')
        + (r.lessonsFlagged ? `; ${n(r.lessonsFlagged, 'approved lesson')} may hold a secret: ${one ? 'its' : 'their'} text was not changed; ${one ? 'it is' : 'they are'} flagged "may hold a secret" in Lessons for you to edit` : '')
        + (v2 ? `. Before this, redaction rules v2 had rewritten ${n(v2.facts, 'fact')} (${v2.factsClosed} of them closed as credentials), ${n(v2.chunks, 'document text')} and ${n(v2.lessons, 'lesson')} in place, some of them ordinary text such as a key or identifier; v2 kept no copy of the original text, so it cannot be restored: scan the affected files again to rebuild their facts` : '')
        + '. Rotate any secret that was in an upload or a scanned file.',
      details: {
        version: REDACTION_VERSION, previous: last, facts: r.facts, factsClosed: r.closed, ownerFacts: r.ownerFacts, instructionFacts: r.instructionFacts, reopenedFacts: r.reopenedFacts, chunks: r.chunks, lessons: r.lessons,
        lessonsFlagged: r.lessonsFlagged, misses: r.misses, candidates: r.candidates, sessions: r.sessions, chatTurns: r.chatTurns, activity: r.activity, ...(v2 && { v2 }),
      },
    });
  }
  await d.cursors.setCursor(REDACTION_CURSOR, stamp);
  d.log?.('redaction rules applied to stored data', { version: REDACTION_VERSION, previous: last, ...r });
  return r;
}
