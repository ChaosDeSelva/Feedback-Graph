import type { Hono } from 'hono';
import { MAX_CLASSIFY_ATTEMPTS, redactDeep, type Activity, type ActivityStore, type CandidateDetail, type CodeGraphStore, type GraphStore, type KnowledgeStore, type LessonDetail, type SessionsStore } from '@fb/core';

/**
 * GET /api/sessions/:id/evidence: for one ingested session, what the tool saw and what it decided, so a tester (or
 * you) can tell why an Inbox item is or is not there. Read-only; a session of a project that is not selected is not
 * found. Words are never in it (the turns' text stays on the Sessions page), and what is quoted is redacted again.
 */
export type EvidenceDeps = {
  sessions: Pick<SessionsStore, 'detail' | 'turnEvidence'>;
  /** ProjectScope.project: a session of any other project is not shown. */
  inScope(key: string): boolean | Promise<boolean>;
  candidateDetail?: GraphStore['candidateDetail'];
  lessonDetail?: KnowledgeStore['lessonDetail'];
  sessionFiles?: CodeGraphStore['sessionFiles'];
  activity?: Pick<ActivityStore, 'list'>;
};

/** At most this many classified turns are listed (the counts cover them all); the answer says how many it left out. */
const MAX_FLAGS = 2000;
/** Activity entries per record (the session, an Inbox item, its lesson). */
const MAX_ENTRIES = 50;

const entryRow = (a: Activity) => ({ id: a.id, ts: a.ts, kind: a.kind, actor: a.actor, subject: a.subject, ...(a.run ? { run: a.run } : {}) });
/** The lessons an entry says it served (context_served, predone_check), by id. */
const servedLessons = (a: Activity): string[] => {
  const ls = (a.details?.lessons ?? a.details?.verdicts) as { id?: string; lessonId?: string }[] | undefined;
  return Array.isArray(ls) ? ls.map((l) => l.id ?? l.lessonId ?? '').filter(Boolean) : [];
};

export function evidenceRoutes(app: Hono, d: EvidenceDeps) {
  const entries = async (target: string) => (d.activity ? d.activity.list({ target, limit: MAX_ENTRIES, maxDetailBytes: 64 * 1024 }) : []);

  app.get('/api/sessions/:id/evidence', async (c) => {
    const id = c.req.param('id');
    const s = await d.sessions.detail(id);
    if (!s || !(await d.inScope(s.projectKey))) return c.json({ error: 'not found' }, 404);
    const [turns, files, served] = await Promise.all([d.sessions.turnEvidence(id), d.sessionFiles?.(id) ?? Promise.resolve(null), entries(id)]);
    const classified = turns.filter((t) => t.label !== null);
    const inbox = await Promise.all(s.inbox.map(async (item) => {
      const [cand, lesson, history] = await Promise.all([
        d.candidateDetail?.(item.id) ?? Promise.resolve(null as CandidateDetail | null),
        item.lessonId && d.lessonDetail ? d.lessonDetail(item.lessonId) : Promise.resolve(null as LessonDetail | null),
        entries(item.id),
      ]);
      const k = cand?.candidate;
      return {
        id: item.id, status: item.status, label: item.label, summary: item.summary,
        decidedBy: k?.decidedBy ?? null, decidedAt: k?.decidedAt ?? null, note: k?.note ?? null, origins: k?.origins ?? null,
        ...(k?.agentReport && { agentReport: { text: k.agentReport.text, whatWasDone: k.agentReport.whatWasDone, reportedAt: k.agentReport.reportedAt } }),
        postmortem: cand?.postmortem ?? null,
        miss: lesson?.miss ? { id: lesson.miss.id, missed: lesson.miss.missed, cause: lesson.miss.cause } : null,
        lesson: lesson
          ? { id: lesson.lesson.id, status: lesson.lesson.status, title: lesson.lesson.title, rule: lesson.lesson.rule, decidedBy: lesson.lesson.decidedBy ?? null, checks: lesson.lesson.checks ? lesson.lesson.checks.map((x) => x.name) : null }
          : null,
        history: history.map(entryRow),
      };
    }));
    const out = {
      session: { id: s.id, projectKey: s.projectKey, source: s.source, cwd: s.cwd, gitBranch: s.gitBranch, startedAt: s.startedAt, lastActivityAt: s.lastActivityAt, state: s.state, goal: s.snippet },
      turns: {
        count: turns.length,
        first: turns[0]?.ts ?? null,
        last: turns.at(-1)?.ts ?? null,
        classified: classified.length,
        // The opening turn (index 0) is context, never classified.
        waiting: turns.filter((t) => t.label === null && t.index > 0 && t.classifyAttempts < MAX_CLASSIFY_ATTEMPTS).length,
        givenUp: turns.filter((t) => t.label === null && t.classifyAttempts >= MAX_CLASSIFY_ATTEMPTS).length,
        prunedText: s.prunedTurns,
      },
      files: files && { edited: files.filter((f) => f.edited).map((f) => f.path), readOnly: files.filter((f) => !f.edited).map((f) => f.path) },
      // pushback and correction are what the detector files; approval and neutral (an instruction, say) are not. A
      // skip rule (signal skip:<rule>) is why a turn that reads like pushback was not filed.
      flags: classified.slice(0, MAX_FLAGS).map((t) => ({
        uuid: t.uuid, index: t.index, ts: t.ts, label: t.label, confidence: t.confidence, why: t.summary,
        signals: t.signals, skipped: t.signals.filter((x) => x.startsWith('skip:')).map((x) => x.slice(5)),
        flagged: t.candidateId !== null, candidateId: t.candidateId,
      })),
      ...(classified.length > MAX_FLAGS && { flagsLeftOut: classified.length - MAX_FLAGS }),
      inbox,
      // Recorded when the agent passed its session_id (get_task_context, check_before_done, report_feedback).
      served: served.map((a) => ({ ...entryRow(a), lessons: servedLessons(a) })),
    };
    return c.json(redactDeep(out));
  });
}
