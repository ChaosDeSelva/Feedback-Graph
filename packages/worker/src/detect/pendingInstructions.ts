import type { ActivityStore, DocsStore, GraphStore } from '@fb/core';
import { DETECT_RULES_VERSION, gitEvidence } from './instruction.ts';

/**
 * The instruction rule (instruction.ts) runs once more over what is already pending in the Inbox, so a rule change
 * migrates its data: "do not merge back to main, don't push a PR yet" flagged before the rule existed is resolved as
 * not pushback, as the cycle would label it today, when nothing it forbids happened later in the session. It is
 * rejected by `detect-rules` with the reason as its note and the `skip:instruction` signal on its turn, like the skip
 * rules do; only items still pending are touched, so your decisions stand. Items the agent then broke stay for you.
 * Items an older version rejected that this one would not (pushback that only mentioned a commit or a PR) go back to
 * the Inbox: only those `detect-rules` decided, never one you decided.
 */
export type PendingInstructionDeps = {
  graph: Pick<GraphStore, 'pendingSessionItems' | 'skipPendingItem' | 'ruleSkippedItems' | 'reopenRuleSkippedItem' | 'callsAfter'>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
  now?: () => number;
  /**
   * The ingest version the transcripts have been read at (state.ts INGEST_VERSION), part of the stamp: the rule reads
   * the git calls ingest records after each instruction (ingest v4), so it runs again once they are read again. Run only
   * after that ingest (evidence.ts): before it, a push that ended the session is not recorded and the instruction looks
   * kept. Unset: the rules version alone.
   */
  ingestVersion?: number;
};

/** Where the detect rules version last applied to pending items is kept. */
export const INSTRUCTION_RULES_CURSOR = 'detect-instruction-rules';
export const DETECT_DECIDER = 'detect-rules';
const PAGE = 500;
const MAX_TARGETS = 50;
const MAX_SAMPLES = 5;
const SAMPLE_CHARS = 200;

/**
 * At worker start, when the detect rules differ from the ones last applied: put back in the Inbox what an older rule
 * rejected and this one would not, resolve the pending items the instruction rule calls neutral, and record the
 * version. Returns how many were reopened and resolved, or null when the rules have not changed. An instruction in a
 * session still active waits (it stays as it is): the version is then not recorded, so the next start looks again. A
 * failure leaves the old version too.
 */
export async function resolvePendingInstructions(d: PendingInstructionDeps): Promise<{ resolved: number; reopened: number } | null> {
  const rules = `v${DETECT_RULES_VERSION}`;
  const stamp = d.ingestVersion ? `${rules} ingest v${d.ingestVersion}` : rules;
  const last = await d.cursors.getCursor(INSTRUCTION_RULES_CURSOR);
  if (last === stamp) return null;
  // The rules are the same and only the evidence they read is new.
  const reread = !!last && last.split(' ')[0] === rules && !!d.ingestVersion;
  const changed = reread
    ? `the sessions' transcripts were read again (ingest v${d.ingestVersion}), so the git calls after each instruction are known now`
    : `the detect rules changed (${last} to ${stamp})`;
  const now = (d.now ?? Date.now)();
  const hits = new Map<string, { id: string; text: string }[]>();
  const back = new Map<string, { id: string; text: string }[]>();
  let waiting = 0;
  let after: string | null = null;
  // Reopened only when this rule says it is not a cleared instruction (not one, or one the agent broke); an
  // instruction it still clears, or one that waits, stays as decided.
  if (last) {
    for (;;) {
      const page = await d.graph.ruleSkippedItems({ rule: 'instruction', by: DETECT_DECIDER, limit: PAGE, afterId: after });
      for (const i of page) {
        const verdict = await gitEvidence({ uuid: i.turnUuid, text: i.text, precedingToolCalls: i.precedingToolCalls }, (u) => d.graph.callsAfter(u), now);
        if (verdict === 'wait') waiting++;
        if (verdict === 'instruction' || verdict === 'wait') continue;
        if (!(await d.graph.reopenRuleSkippedItem(i.id, { rule: 'instruction', by: DETECT_DECIDER }))) continue;
        back.set(i.projectKey, [...(back.get(i.projectKey) ?? []), { id: i.id, text: i.text }]);
      }
      if (page.length < PAGE) break;
      after = page[page.length - 1].id;
    }
    after = null;
  }
  for (;;) {
    const page = await d.graph.pendingSessionItems({ limit: PAGE, afterId: after });
    for (const i of page) {
      const verdict = await gitEvidence({ uuid: i.turnUuid, text: i.text, precedingToolCalls: i.precedingToolCalls }, (u) => d.graph.callsAfter(u), now);
      if (verdict === 'wait') waiting++;
      if (verdict !== 'instruction') continue;
      const note = `not pushback: an instruction about git, and nothing it forbids was done before it or after it (detect rules v${DETECT_RULES_VERSION})`;
      if (!(await d.graph.skipPendingItem(i.id, { rule: 'instruction', note, by: DETECT_DECIDER }))) continue;
      hits.set(i.projectKey, [...(hits.get(i.projectKey) ?? []), { id: i.id, text: i.text }]);
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  let reopened = 0;
  for (const [projectKey, list] of back) {
    reopened += list.length;
    await d.activity?.record({
      kind: 'items_reopened', actor: DETECT_DECIDER, projectKey,
      subject: `${list.length} Inbox item${list.length === 1 ? '' : 's'} back for your decision: pushback that mentions git, not an instruction`,
      why: `${changed}; the earlier ${reread ? 'run' : 'rule'} had resolved ${list.length === 1 ? 'it as an instruction' : 'them as instructions'}`,
      details: {
        rule: 'instruction', reopened: list.length, rulesVersion: DETECT_RULES_VERSION,
        samples: list.slice(0, MAX_SAMPLES).map((h) => ({ turn: h.id, text: h.text.slice(0, SAMPLE_CHARS) })),
      },
      targets: list.slice(0, MAX_TARGETS).map((h) => h.id),
    });
  }
  let resolved = 0;
  for (const [projectKey, list] of hits) {
    resolved += list.length;
    await d.activity?.record({
      kind: 'comments_skipped', actor: DETECT_DECIDER, projectKey,
      subject: `${list.length} pending Inbox item${list.length === 1 ? '' : 's'} resolved as not pushback: an instruction, not a correction`,
      why: `${last ? changed : `the detect rules (${stamp}) had not been run over the Inbox yet`}; instruction: ${list.length}`,
      details: {
        rules: { instruction: list.length }, pending: list.length, rulesVersion: DETECT_RULES_VERSION,
        samples: list.slice(0, MAX_SAMPLES).map((h) => ({ rule: 'instruction', turn: h.id, text: h.text.slice(0, SAMPLE_CHARS) })),
      },
      targets: list.slice(0, MAX_TARGETS).map((h) => h.id),
    });
  }
  if (resolved || reopened) d.log?.('instruction rule applied to the Inbox', { resolved, reopened, waiting });
  if (!waiting) await d.cursors.setCursor(INSTRUCTION_RULES_CURSOR, stamp);
  return { resolved, reopened };
}
