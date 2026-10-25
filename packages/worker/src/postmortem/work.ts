import type { ExternalRef, GraphStore, PostMortemInput, SessionsStore } from '@fb/core';
import { findWorkSessions, type WorkMatch } from '../integrations/feedbackSync.ts';

const MAX_WORK_TURNS = 400;

/** A file a session touched: `edited` when it changed it, not only read it. */
export type TouchedFile = { path: string; edited: boolean };

/**
 * For a comment from GitHub or Linear, the agent session that did the work, looked up now (it may have been ingested
 * after the comment was synced): the session the sync linked, else the newest on the branch or the only one just
 * before the comment. The post-mortem then reads that session's turns, edited files and summary, as it would for
 * pushback in a transcript. No session: `work` is null and the post-mortem works from the comment alone.
 *
 * `files` (the repo files a session read or edited): a session that never touched the file a review comment is on did
 * not do that work, however well its branch fits; one on the branch with no files recorded is not ruled out.
 * A session found by time alone (none on the PR's branch) is a guess, and one wrong guess turned every comment of a
 * week into lessons about another feature: it counts only when it edited the commented file, or, for a comment on no
 * file, a file the comment, its diff lines or the description name. No evidence: the comment alone.
 */
export async function attachWorkSession(
  input: PostMortemInput,
  d: { graph: Pick<GraphStore, 'workSessions'>; sessions: Pick<SessionsStore, 'turns'>; files?: (sessionId: string) => Promise<TouchedFile[]> },
): Promise<PostMortemInput> {
  const ext = input.feedback.external;
  if (!ext) return input;
  const found = await findWorkSessions(d.graph, input.projectKey, ext.branch, ext.createdAt);
  const touched = await Promise.all(found.map((s) => (d.files ? d.files(s.id).catch(() => [] as TouchedFile[]) : Promise.resolve(null))));
  const fits = found.filter((s, i) => didThisWork(s, touched[i], ext, input.feedback.text));
  const pick = fits.find((s) => ext.linkedSessionIds.includes(s.id)) ?? fits[0];
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

/** Whether a found session did the work the comment is about. `files` null: not known (no lookup). */
function didThisWork(s: WorkMatch, files: TouchedFile[] | null, ext: ExternalRef, text: string): boolean {
  if (s.by === 'branch') return !ext.path || !files?.length || files.some((f) => f.path === ext.path);
  const edited = (files ?? []).filter((f) => f.edited).map((f) => f.path);
  if (ext.path) return edited.includes(ext.path);
  const named = [text, ext.diffHunk ?? '', ext.description ?? ''].join('\n');
  return edited.some((p) => named.includes(p) || (p.includes('/') && named.includes(p.split('/').slice(-2).join('/'))));
}
