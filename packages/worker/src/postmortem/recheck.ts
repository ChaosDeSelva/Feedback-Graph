import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LESSON_CHECKS_VERSION, redactSecrets, type ActivityStore, type KnowledgeStore, type Lesson, type LessonCheck, type LessonCheckName, type LessonDetail, type SimilarLesson } from '@fb/core';
import { MODEL_FACT_WHY, recheckLesson, saysWrongSession } from './lessonCheck.ts';
import { ambiguousFlag, junkPathReason, normalizeStoredPaths, repoFileList, repoHas, type Normalized } from './paths.ts';
import { claimsNotLoaded, imports } from './standing.ts';
import { isFiller } from './shape.ts';

/** More lessons than any instance holds; one pass, so a store that cannot save never loops. */
const MAX_LESSONS = 10_000;

/** Lessons this close (cosine of their stored embeddings, same project) say the same thing. */
export const DUPLICATE_COSINE = 0.92;
/** Neighbours looked at per lesson: the nearest that counts is enough. */
const NEIGHBOURS = 5;

const MAX_TARGETS = 500;

/** The why of a wrong-session a re-check read from a stored miss: worked out again each time, never kept. */
export const RECHECK_WRONG_SESSION_WHY = 'the post-mortem says the matched session did other work: what it took from that session is likely wrong';

/**
 * may-hold-secret (the redaction re-run's flag on an approved lesson) holds while a rule still reads a credential in
 * the lesson's text as it is now: once the owner edited the secret out (an edit resets checksVersion), it goes.
 */
const mayHoldSecret = (l: Lesson) => [l.title, l.rule, l.appliesWhen ?? ''].some((t) => redactSecrets(t) !== t);

/**
 * Flags a re-check cannot work out again, kept from the earlier checks: made from the comment's metadata (who wrote
 * it, the matched session: the post-mortem's own redo or the session re-match, not a re-check's reading of the miss) or
 * by the model, neither of which is stored with the lesson; or a repair already applied to the lesson (a dropped path);
 * or no-miss, which only a post-mortem's own words raise. broken-rule (the title used as the rule) only while the
 * lesson is the writer's, as the repair left it: once the owner edited or decided it, the rule is judged as it is now.
 */
const kept = (l: Lesson) => (c: LessonCheck) =>
  (c.name === 'wrong-session' && c.why !== RECHECK_WRONG_SESSION_WHY) || c.name === 'self-review' || c.name === 'no-miss' || c.name === 'non-repo-path' ||
  (c.name === 'broken-rule' && l.status === 'proposed' && !l.proposedAs) || c.name === 'contradicts-evidence' ||
  (c.name === 'may-hold-secret' && mayHoldSecret(l)) ||
  (c.name === 'looks-like-a-fact' && c.why === MODEL_FACT_WHY);

/**
 * Whether a stored miss says its session did other work. Only a post-mortem whose session is not known can be judged
 * so: one recorded with no session (the comment alone) had none to be wrong, and one recorded with a session matched by
 * branch or files was redone from the comment alone at the time if the model said so (postmortem.ts), so its words now
 * are about the code ("another function"), not the session. Before the match was recorded, the words are all there is.
 */
/** RecheckDeps.workSession from Activity: the newest postmortem_done of the feedback, as the post-mortem recorded it. */
export const recordedWorkSession = (activity: Pick<ActivityStore, 'list'>) => async (feedbackId: string) => {
  const [a] = await activity.list({ kind: 'postmortem_done', target: feedbackId, limit: 1 });
  if (!a?.details || !('workSession' in a.details)) return undefined;
  return a.details.workSession as { id: string; matchedBy: 'branch' | 'files' | null } | null;
};

async function wrongSession(detail: LessonDetail | null, d: RecheckDeps): Promise<boolean> {
  if (!detail?.miss || !saysWrongSession(detail.miss)) return false;
  const work = detail.feedback && d.workSession ? await d.workSession(detail.feedback.id) : undefined;
  return work === undefined;
}

/**
 * duplicate-of, when a near-identical lesson of the same project (DUPLICATE_COSINE) is the one to keep: an approved one
 * over one that is not, else the older. Rejected and superseded lessons do not count. Of a pair, only one is flagged.
 */
export function duplicateFlag(me: Pick<Lesson, 'id' | 'status' | 'createdAt'>, near: SimilarLesson[]): LessonCheck | null {
  const rank = (s: string) => (s === 'approved' ? 1 : 0);
  const older = (a: Pick<SimilarLesson, 'createdAt' | 'id'>, b: Pick<SimilarLesson, 'createdAt' | 'id'>) =>
    a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
  const other = near.find((n) =>
    n.id !== me.id && n.cosine >= DUPLICATE_COSINE && (n.status === 'approved' || n.status === 'proposed') &&
    (rank(n.status) > rank(me.status) || (rank(n.status) === rank(me.status) && older(n, me))));
  return other ? { name: 'duplicate-of', of: other.id, why: `repeats ${other.id} (cosine ${other.cosine.toFixed(2)}): merge them or reject one` } : null;
}

export type RecheckDeps = {
  k: Pick<KnowledgeStore, 'listLessons' | 'lessonDetail' | 'setLessonChecks'> & Partial<Pick<KnowledgeStore, 'staleLessonChecks' | 'similarLessons' | 'setLessonPaths'>>;
  /** Each project's repository folder as the worker sees it; unset or missing a project: its paths are not looked up. */
  repoPaths?: () => Promise<Map<string, string>>;
  /** Whether the repository has the path (default repoHas: true when the repository is not mounted). */
  exists?: (repoPath: string, path: string) => Promise<boolean>;
  /** The repository's files, so a bare file name resolves (default repoFileList: null when it is not mounted). */
  repoFiles?: (repoPath: string) => Promise<string[] | null>;
  /**
   * The Linear ticket ids among `ids` linked to the project: from its mapped team or named by its pull requests (the
   * worker: DocsStore.projectTickets and its synced tickets' team keys). Unset: cited tickets are not checked.
   */
  linkedTickets?: (projectKey: string, ids: string[]) => Promise<string[]>;
  /** The instruction files a session's transcript shows its agent had (GraphStore.sessionInstructionFiles); unset: none known. */
  instructionFiles?: (sessionId: string) => Promise<string[] | null>;
  /**
   * The session a comment's post-mortem was worked out against (its postmortem_done Activity, details.workSession):
   * null when none matched, undefined when not recorded (before 0.6.2) or unknown. Unset: never known.
   */
  workSession?: (feedbackId: string) => Promise<{ id: string; matchedBy: 'branch' | 'files' | null } | null | undefined>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
};

const FILE_NAME = { claude_md: /(^|\/)CLAUDE(\.local)?\.md$/, agents_md: /(^|\/)AGENTS\.md$/ } as const;
const LABEL = { claude_md: 'CLAUDE.md', agents_md: 'AGENTS.md' } as const;

/**
 * contradicts-evidence on a stored lesson: its miss says the agent did not load CLAUDE.md or AGENTS.md, and what is
 * stored shows it had: a context item marked available, the session's recorded instruction files, or (AGENTS.md) the
 * project's CLAUDE.md importing it, which Claude Code follows and Codex, which loads AGENTS.md itself, does not need.
 */
const TICKET_REF = /^(?:linear:)?([A-Za-z]{2}[A-Za-z0-9]{0,8}-\d{1,6})\b/;

/**
 * unlinked-ticket: the post-mortem cited Linear tickets that are not linked to the lesson's project. Before the hunt
 * kept to the project's tickets it searched the whole workspace, so a lesson could be built on another team's ticket.
 */
async function unlinkedTickets(l: Lesson, detail: LessonDetail | null, d: RecheckDeps): Promise<LessonCheck | null> {
  const key = l.projectKey ?? l.origin;
  if (!d.linkedTickets || !key || !detail) return null;
  const ids = [...new Set(detail.contextItems.filter((i) => i.kind === 'ticket').flatMap((i) => TICKET_REF.exec(i.ref)?.[1]?.toUpperCase() ?? []))];
  if (!ids.length) return null;
  const linked = new Set(await d.linkedTickets(key, ids));
  const other = ids.filter((id) => !linked.has(id));
  return other.length ? { name: 'unlinked-ticket', why: `its post-mortem cited Linear tickets not linked to ${key} (${other.join(', ')}): what it took from them is likely another project's` } : null;
}

async function contradiction(detail: LessonDetail | null, repo: string | undefined, d: RecheckDeps): Promise<LessonCheck | null> {
  if (!detail?.miss) return null;
  const claimed = claimsNotLoaded(`${detail.miss.causeExplanation}\n${detail.miss.missed}`);
  if (!claimed.length) return null;
  const recorded = detail.feedback ? ((await d.instructionFiles?.(detail.feedback.sessionId).catch(() => null)) ?? []) : [];
  const claudeMd = repo ? await readFile(join(repo, 'CLAUDE.md'), 'utf8').catch(() => null) : null;
  const importsAgents = !!repo && !!claudeMd && imports(claudeMd, repo, resolve).some((p) => p === join(repo, 'AGENTS.md'));
  for (const kind of claimed) {
    const said = `the miss says ${LABEL[kind]} was not loaded, but`;
    const item = detail.contextItems.find((i) => i.kind === kind && i.wasAvailable);
    if (item) return { name: 'contradicts-evidence', why: `${said} the post-mortem itself marked it available (${item.ref}): its cause is likely wrong` };
    const file = recorded.find((p) => FILE_NAME[kind].test(p));
    if (file) return { name: 'contradicts-evidence', why: `${said} the session's transcript shows it (${file}): its cause is likely wrong` };
    if (kind === 'agents_md' && importsAgents) return { name: 'contradicts-evidence', why: `${said} the project's CLAUDE.md imports it (@AGENTS.md), so Claude Code loads it: its cause is likely wrong` };
  }
  return null;
}

/**
 * The path flags of a stored lesson after normalizeStoredPaths. Its paths replaced (proposed): bad-path says what was
 * dropped. Kept as they are (approved): path-missing for what the repository does not have as written (bad-path for
 * what cannot be a path comes from recheckLesson).
 */
function pathFlags(n: Normalized, replaced: boolean): LessonCheck[] {
  const missing = [...n.resolved.map((r) => `${r.from} (it is ${r.to})`), ...n.dropped.filter((x) => !junkPathReason(x.path)).map((x) => x.path)];
  const flags: LessonCheck[] = replaced
    ? n.dropped.length ? [{ name: 'bad-path', why: `dropped ${n.dropped.map((x) => `${x.path}: ${x.why}`).join('; ')}` }] : []
    : missing.length ? [{ name: 'path-missing', why: `not in the repository: ${missing.join(', ')}` }] : [];
  return [...flags, ...n.ambiguous.map(ambiguousFlag)];
}

/**
 * The lesson checks of today over every proposed and approved lesson checked with an older LESSON_CHECKS_VERSION (or
 * never): the text checks, and the data checks only a stored lesson can have (its miss saying the session was the wrong
 * one, its paths against the mounted repository, a near-duplicate by stored embedding). A proposed lesson's paths are
 * normalized and stored (normalizeStoredPaths: bare names resolved, junk and missing files dropped) and the change
 * logged; otherwise flags only: an approved lesson's text and paths are left as the owner approved them. Each lesson is stamped with the version, so it runs once
 * per version (and again after requestLessonRecheck); Activity says how many were checked and which flags came and went.
 */
export async function recheckLessons(d: RecheckDeps): Promise<{ checked: number; flagged: number; changed: number }> {
  const todo = d.k.staleLessonChecks
    ? await d.k.staleLessonChecks(LESSON_CHECKS_VERSION, MAX_LESSONS)
    : (await d.k.listLessons({ limit: MAX_LESSONS })).filter((l) => (l.status === 'proposed' || l.status === 'approved') && (l.checksVersion ?? 0) < LESSON_CHECKS_VERSION);
  if (!todo.length) return { checked: 0, flagged: 0, changed: 0 };
  const repos = (await d.repoPaths?.().catch(() => null)) ?? new Map<string, string>();
  const exists = d.exists ?? repoHas;
  const repoFiles = d.repoFiles ?? repoFileList;
  let normalized = 0;
  const counts: Record<string, number> = {};
  const added: Record<string, number> = {};
  const removed: Record<string, number> = {};
  let flagged = 0;
  let changed = 0;
  const changedIds: string[] = [];
  for (const l of todo) {
    const detail = await d.k.lessonDetail(l.id);
    const repo = repos.get(l.projectKey ?? l.origin ?? '');
    const norm = await normalizeStoredPaths(l.paths, repo ? { exists: (p) => exists(repo, p), repoFiles: () => repoFiles(repo) } : {});
    // A proposed lesson's paths are replaced by the normalized ones (only while it is proposed and the writer's alone:
    // the store refuses others). Paths the owner edited are the owner's (a file about to be created too): only flagged.
    let paths = l.paths;
    if (l.status === 'proposed' && !l.proposedAs && d.k.setLessonPaths && JSON.stringify(norm.paths) !== JSON.stringify(l.paths) && (await d.k.setLessonPaths(l.id, norm.paths))) {
      paths = norm.paths;
      normalized++;
      d.log?.('lesson paths normalized', { id: l.id, from: l.paths, to: norm.paths, dropped: norm.dropped, resolved: norm.resolved });
    }
    const replaced = paths !== l.paths;
    const fresh = recheckLesson({ ...l, paths }, detail?.feedback?.text ?? '', detail?.feedback?.external);
    const usable = paths.filter((p) => !junkPathReason(p));
    const data: LessonCheck[] = [];
    if (!usable.length && l.scope !== 'global' && l.source === 'postmortem') {
      data.push({ name: 'needs-path', why: 'no file the evidence supports: as it is, it would apply anywhere in the project' });
    }
    const fromPaths = pathFlags(norm, replaced);
    if ((l.from === 'github' || l.from === 'linear') && (await wrongSession(detail, d))) data.push({ name: 'wrong-session', why: RECHECK_WRONG_SESSION_WHY });
    // Flagged only: an approved lesson's words are the owner's (the writer's are repaired when proposed, shape.ts).
    if (isFiller(l.appliesWhen)) {
      data.push({ name: 'filler-applies-when', why: `its "applies when" is just "${l.appliesWhen.trim()}": it says nothing about when the rule applies; say the kind of task or the files` });
    }
    const dup = d.k.similarLessons ? duplicateFlag(l, await d.k.similarLessons(l.id, NEIGHBOURS)) : null;
    if (dup) data.push(dup);
    const contradicted = await contradiction(detail, repo, d);
    if (contradicted) data.push(contradicted);
    const unlinked = await unlinkedTickets(l, detail, d);
    if (unlinked) data.push(unlinked);
    // bad-path first, as at proposal time, then the data checks, then the rest of the text checks.
    const computed = [
      ...fresh.filter((f) => f.name === 'bad-path'), ...fromPaths.filter((f) => f.name === 'bad-path'), ...data,
      ...fromPaths.filter((f) => f.name !== 'bad-path'), ...fresh.filter((f) => f.name !== 'bad-path'),
    ];
    const keep = (l.checks ?? []).filter(kept(l));
    const flags = [...keep, ...computed.filter((c) => !keep.some((k) => k.name === c.name))];
    await d.k.setLessonChecks(l.id, flags, LESSON_CHECKS_VERSION);
    const before = new Set((l.checks ?? []).map((c) => c.name));
    const after = new Set<LessonCheckName>(flags.map((c) => c.name));
    const plus = [...after].filter((n) => !before.has(n));
    const minus = [...before].filter((n) => !after.has(n));
    if (plus.length || minus.length) {
      changed++;
      changedIds.push(l.id);
    }
    for (const n of plus) added[n] = (added[n] ?? 0) + 1;
    for (const n of minus) removed[n] = (removed[n] ?? 0) + 1;
    if (flags.length) flagged++;
    for (const f of flags) counts[f.name] = (counts[f.name] ?? 0) + 1;
  }
  const checked = todo.length;
  d.log?.('lessons re-checked', { checked, flagged, changed, normalized, version: LESSON_CHECKS_VERSION, added, removed });
  await d.activity?.record({
    kind: 'lessons_checked', actor: 'lesson-check', projectKey: null,
    subject: `${checked} lesson${checked === 1 ? '' : 's'} re-checked (checks v${LESSON_CHECKS_VERSION}): ${flagged} flagged, ${changed} changed${normalized ? `, ${normalized} proposed with paths normalized` : ''}`,
    why: normalized
      ? 'their checks were older than the current ones (or a re-check was asked for); the flags are shown on each lesson, and proposed lessons got their paths normalized (approved ones were only flagged)'
      : 'their checks were older than the current ones (or a re-check was asked for); the flags are shown on each lesson, nothing else was changed',
    details: { checked, flagged, changed, normalized, version: LESSON_CHECKS_VERSION, flags: counts, added, removed },
    // The lessons whose flags changed, so each one's history shows it (capped: a big backlog is one entry, not a list).
    targets: changedIds.slice(0, MAX_TARGETS),
  });
  return { checked, flagged, changed };
}
