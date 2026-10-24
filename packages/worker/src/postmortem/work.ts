import type { GraphStore, PostMortemInput, SessionsStore } from '@fb/core';
import { findWorkSessions } from '../integrations/feedbackSync.ts';

const MAX_WORK_TURNS = 400;

/**
 * For a comment from GitHub or Linear, the agent session that did the work, looked up now (it may have been ingested
 * after the comment was synced): the session the sync linked, else the newest on the branch or the only one just
 * before the comment. The post-mortem then reads that session's turns, edited files and summary, as it would for
 * pushback in a transcript. No session: `work` is null and the post-mortem works from the comment alone.
 */
export async function attachWorkSession(
  input: PostMortemInput,
  d: { graph: Pick<GraphStore, 'workSessions'>; sessions: Pick<SessionsStore, 'turns'> },
): Promise<PostMortemInput> {
  const ext = input.feedback.external;
  if (!ext) return input;
  const found = await findWorkSessions(d.graph, input.projectKey, ext.branch, ext.createdAt);
  const pick = found.find((s) => ext.linkedSessionIds.includes(s.id)) ?? found[0];
  if (!pick) return { ...input, work: null };
  const turns = await d.sessions.turns(pick.id, -1, MAX_WORK_TURNS);
  return {
    ...input,
    sessionId: pick.id,
    cwd: pick.cwd ?? input.cwd,
    source: pick.source,
    work: { sessionId: pick.id, source: pick.source, cwd: pick.cwd ?? '', turns },
  };
}
