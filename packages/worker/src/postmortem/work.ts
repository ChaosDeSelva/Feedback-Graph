import type { ExternalRef, GraphStore, PostMortemInput, SessionsStore } from '@fb/core';
import { findWorkSessions, type WorkMatch } from '../integrations/feedbackSync.ts';

const MAX_WORK_TURNS = 400;

/** A file a session touched: `edited` when it changed it, not only read it. */
export type TouchedFile = { path: string; edited: boolean };

/**
 * Files nearly every change touches (manifests, lockfiles, the changelog): sharing one with a PR says nothing about
 * which work a session did. A comment on one of them still counts its own file.
 */
const SHARED = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|CHANGELOG\.md|README\.md|\.gitignore)$/;

/**
 * For a comment from GitHub or Linear, the agent session that did the work, looked up now (it may have been ingested
 * after the comment was synced). A session matches only if, in the comment's project, it ran on the PR's branch, or it
 * edited the files the PR changed (the commented file, for a review comment): never for being the nearest in time. One
 * wrong guess turned every comment of a week into lessons about another feature (a data-pipeline review was worked out
 * from a UI session's turns and paths). No confident match: `work` is null, and the post-mortem works from the comment,
 * its diff lines and the PR alone, and says so.
 *
 * `files` (the repo files a session read or edited): a session on the branch that never touched the file a review
 * comment is on did not do that work; one on the branch with no files recorded is not ruled out. Off the branch, the
 * session that edited the most of the PR's files is the one; a tie is no match.
 */
export async function attachWorkSession(
  input: PostMortemInput,
  d: { graph: Pick<GraphStore, 'workSessions'>; sessions: Pick<SessionsStore, 'turns'>; files?: (sessionId: string) => Promise<TouchedFile[]> },
): Promise<PostMortemInput> {
  const ext = input.feedback.external;
  if (!ext) return input;
  const pick = await pickWorkSession(ext, input.projectKey, d);
  if (!pick) return { ...input, work: null };
  const turns = await d.sessions.turns(pick.id, -1, MAX_WORK_TURNS);
  return {
    ...input,
    sessionId: pick.id,
    cwd: pick.cwd ?? input.cwd,
    source: pick.source,
    work: { sessionId: pick.id, source: pick.source, cwd: pick.cwd ?? '', turns, matchedBy: pick.by === 'branch' ? 'branch' : 'files' },
  };
}

/** The session the rule matches to this comment now, or null (postmortem/rematch.ts uses it for pending items too). */
export async function pickWorkSession(
  ext: ExternalRef,
  projectKey: string,
  d: { graph: Pick<GraphStore, 'workSessions'>; files?: (sessionId: string) => Promise<TouchedFile[]> },
): Promise<WorkMatch | null> {
  const found = await findWorkSessions(d.graph, projectKey, ext.branch, ext.createdAt);
  const touched = await Promise.all(found.map((s) => (d.files ? d.files(s.id).catch(() => [] as TouchedFile[]) : Promise.resolve(null))));
  const fits = found.map((s, i) => ({ s, files: touched[i] })).filter((f) => workMatches(f.s, f.files, ext));
  const linked = fits.find((f) => ext.linkedSessionIds.includes(f.s.id));
  if (linked) return linked.s;
  const branch = fits.find((f) => f.s.by === 'branch');
  if (branch) return branch.s;
  const scored = fits.map((f) => ({ s: f.s, n: prFilesEdited(f.files, ext).length })).sort((a, b) => b.n - a.n);
  if (!scored.length || (scored.length > 1 && scored[1].n === scored[0].n)) return null;
  return scored[0].s;
}

/** The files that tie a session to the PR: the commented file, else the PR's changed files but the shared ones. */
function evidenceFiles(ext: ExternalRef): string[] {
  if (ext.path) return [ext.path];
  return (ext.prFiles ?? []).filter((p) => !SHARED.test(p));
}

/** The evidence files the session edited (reading is not doing). */
function prFilesEdited(files: TouchedFile[] | null, ext: ExternalRef): string[] {
  const edited = new Set((files ?? []).filter((f) => f.edited).map((f) => f.path));
  return evidenceFiles(ext).filter((p) => edited.has(p));
}

/**
 * The matching rule (SESSION_MATCH_VERSION) for one candidate: on the branch, it counts unless it is known not to have
 * touched the commented file; off it, only when it edited a file the PR changed. `files` null: not known (no lookup).
 */
export function workMatches(s: WorkMatch, files: TouchedFile[] | null, ext: ExternalRef): boolean {
  if (s.by === 'branch') return !ext.path || !files?.length || files.some((f) => f.path === ext.path);
  return prFilesEdited(files, ext).length > 0;
}
