import type { ActivityStore, CommentLesson, DocsStore, ExternalRef, GraphStore, KnowledgeStore, LessonCheck, PendingExternalItem, WorkSession } from '@fb/core';
import { SESSION_MATCH_VERSION } from '../integrations/feedbackSync.ts';
import { saysNoMiss } from './noMiss.ts';
import { NO_MISS_DECIDER, noMissWhy } from './step.ts';
import { pickWorkSession, type TouchedFile } from './work.ts';

/**
 * The session-matching rule (SESSION_MATCH_VERSION) runs once per version over what was matched under an older one, so
 * a rule change migrates its data:
 * - pending synced comments are matched again, and the work sessions they link are set to what the rule matches now;
 * - a proposed lesson whose comment the old rule matched to a session the new rule does not match (the nearest session
 *   in time, which did other work) gets the wrong-session flag: what its post-mortem took from that session is likely
 *   wrong. Flags only: the owner decides;
 * - a proposed lesson whose own miss says there was none ("the agent did not miss any defects") is rejected, as a new
 *   post-mortem saying so is (postmortem/step.ts), unless the owner edited it: then it is flagged no-miss (`held`),
 *   for the owner to decide.
 * Approved and decided lessons are left as they are. One Activity entry says what changed.
 */

export type RematchDeps = {
  graph: Pick<GraphStore, 'pendingExternalItems' | 'setExternalLinks' | 'workSessions'>;
  knowledge: Pick<KnowledgeStore, 'setLessonChecks' | 'updateLesson'> & Partial<Pick<KnowledgeStore, 'commentLessons'>>;
  /** The repo files a session read or edited (CodeGraphStore.sessionFiles); unset: none known. */
  files?: (sessionId: string) => Promise<TouchedFile[]>;
  cursors: Pick<DocsStore, 'getCursor' | 'setCursor'>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
};

export const SESSION_MATCH_CURSOR = 'session-match';
const PAGE = 500;
const MAX_TARGETS = 200;
const MAX_SAMPLES = 5;

const stamp = () => `v${SESSION_MATCH_VERSION}`;

/** At worker start: when the rule's version differs from the one last applied. Null: it has run for this version. */
export async function rematchOnRuleChange(d: RematchDeps): Promise<{ relinked: number; flagged: number; rejected: number; held: number } | null> {
  const last = await d.cursors.getCursor(SESSION_MATCH_CURSOR);
  if (last === stamp()) return null;
  const relinked = await relinkPending(d);
  const lessons = await recheckProposed(d);
  const r = { relinked: relinked.length, flagged: lessons.flagged.length, rejected: lessons.rejected.length, held: lessons.held.length };
  if (r.relinked || r.flagged || r.rejected || r.held) {
    const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    await d.activity?.record({
      kind: 'sessions_rematched', actor: 'session-match', projectKey: null,
      subject: `session matching v${SESSION_MATCH_VERSION}: ${n(r.relinked, 'pending comment')} re-matched, ${n(r.flagged, 'proposed lesson')} flagged wrong-session, ${n(r.rejected, 'proposed lesson')} rejected (no miss)${r.held ? `, ${r.held} edited by you flagged no-miss (yours to decide)` : ''}`,
      why: `${last ? `the rule changed (${last} to ${stamp()})` : 'the rule had not been run over stored comments yet'}: a comment matches a session only when it ran on the pull request's branch or edited the files it changed, never for being near in time`,
      details: {
        version: SESSION_MATCH_VERSION, ...r,
        samples: lessons.flagged.slice(0, MAX_SAMPLES).map((l) => ({ lesson: l.id, thread: l.external.thread, session: l.oldSession })),
      },
      targets: [...lessons.flagged.map((l) => l.id), ...lessons.rejected, ...lessons.held, ...relinked].slice(0, MAX_TARGETS),
    });
    d.log?.('comments re-matched to sessions', r);
  }
  await d.cursors.setCursor(SESSION_MATCH_CURSOR, stamp());
  return r;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Pending synced comments: link the session the rule matches now (none, rather than a guess). Returns their ids. */
async function relinkPending(d: RematchDeps): Promise<string[]> {
  const items: PendingExternalItem[] = [];
  for (let after: string | null = null; ;) {
    const page = await d.graph.pendingExternalItems({ limit: PAGE, afterId: after });
    items.push(...page);
    if (page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  const changed: string[] = [];
  for (const i of items) {
    const pick = await pickWorkSession({ ...i.external, linkedSessionIds: [] }, i.projectKey, d);
    const ids = pick ? [pick.id] : [];
    if (sameSet(ids, i.external.linkedSessionIds ?? [])) continue;
    if (await d.graph.setExternalLinks(i.turnUuid, ids)) changed.push(i.id);
  }
  return changed;
}

/**
 * Proposed lessons from comments: flag those built on a session the new rule does not match; reject those with no
 * miss, or flag them no-miss (`held`) when the owner edited them: an owner's lesson is only ever flagged.
 */
async function recheckProposed(d: RematchDeps): Promise<{ flagged: (CommentLesson & { oldSession: string })[]; rejected: string[]; held: string[] }> {
  const flagged: (CommentLesson & { oldSession: string })[] = [];
  const rejected: string[] = [];
  const held: string[] = [];
  if (!d.knowledge.commentLessons) return { flagged, rejected, held };
  for (let after: string | null = null; ;) {
    const page = await d.knowledge.commentLessons({ status: 'proposed', limit: PAGE, afterId: after });
    for (const l of page) {
      const none = saysNoMiss(l);
      if (none && l.ownerEdited) {
        if (!(l.checks ?? []).some((c) => c.name === 'no-miss')) {
          l.checks = [...(l.checks ?? []), { name: 'no-miss', why: noMissWhy(none) }];
          await d.knowledge.setLessonChecks(l.id, l.checks);
          held.push(l.id);
        }
      } else if (none) {
        await d.knowledge.updateLesson(l.id, { status: 'rejected' }, { by: NO_MISS_DECIDER, note: `no miss: the post-mortem said "${none.slice(0, 300)}", so no lesson` });
        rejected.push(l.id);
        continue;
      }
      if ((l.checks ?? []).some((c) => c.name === 'wrong-session')) continue;
      const old = await pickV1(l.external, l.projectKey, l.text, d);
      if (!old) continue;
      const now = await pickWorkSession(l.external, l.projectKey, d);
      if (now?.id === old) continue;
      const flag: LessonCheck = {
        name: 'wrong-session',
        why: `its comment was matched to session ${old} by the old rule (near in time); the rule now (the pull request's branch, or the files it changed) ${now ? `matches ${now.id}` : 'matches no session'}: what the post-mortem took from ${old} is likely wrong`,
      };
      await d.knowledge.setLessonChecks(l.id, [...(l.checks ?? []), flag]);
      flagged.push({ ...l, oldSession: old });
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  return { flagged, rejected, held };
}

// ── The rule before SESSION_MATCH_VERSION 2, kept as it was to tell which stored post-mortems it shaped ──

const V1_WINDOW_MS = 2 * 86_400_000;
const V1_DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk']);
const v1DidWork = (s: WorkSession) => s.edits + s.commits > 0;

/** The session the v1 rule picked: on the branch, else the only session in the two days before, with a file named. */
async function pickV1(ext: ExternalRef, projectKey: string, text: string, d: RematchDeps): Promise<string | null> {
  let found: (WorkSession & { by: 'branch' | 'time' })[] = [];
  if (ext.branch) found = (await d.graph.workSessions({ projectKey, branch: ext.branch, before: ext.createdAt, limit: 3 })).filter(v1DidWork).map((s) => ({ ...s, by: 'branch' as const }));
  if (!found.length) {
    const after = new Date(Date.parse(ext.createdAt) - V1_WINDOW_MS).toISOString();
    const near = (await d.graph.workSessions({ projectKey, branch: null, before: ext.createdAt, after, limit: 2 })).filter(v1DidWork);
    const s = near[0];
    if (near.length === 1 && (!ext.branch || !s.gitBranch || s.gitBranch === ext.branch || V1_DEFAULT_BRANCHES.has(s.gitBranch))) found = [{ ...s, by: 'time' }];
  }
  const touched = await Promise.all(found.map((s) => (d.files ? d.files(s.id).catch(() => [] as TouchedFile[]) : Promise.resolve(null))));
  const fits = found.filter((s, i) => {
    const files = touched[i];
    if (s.by === 'branch') return !ext.path || !files?.length || files.some((f) => f.path === ext.path);
    const edited = (files ?? []).filter((f) => f.edited).map((f) => f.path);
    if (ext.path) return edited.includes(ext.path);
    const named = [text, ext.diffHunk ?? '', ext.description ?? ''].join('\n');
    return edited.some((p) => named.includes(p) || (p.includes('/') && named.includes(p.split('/').slice(-2).join('/'))));
  });
  return (fits.find((s) => ext.linkedSessionIds.includes(s.id)) ?? fits[0])?.id ?? null;
}
