import { sessionFiles, type Classification, type ParsedSession, type PostMortem, type Project, type Store, type ToolCall } from '@fb/core';

/**
 * A small public history to try the replay on (scripts/loop-replay.ts --demo): one synthetic project, `replay-demo`,
 * with repeated misses, proposed lessons, served and judged lessons and an Inbox item, then a cut, then what "the
 * owner" did after it: approvals, a rejection, an edit, an Inbox decision, and a miss that is new after the cut.
 * Everything is made up here; nothing comes from a real install. It is a smoke test of the harness, not a benchmark.
 */

export const DEMO_REPLAY_PROJECT: Project = { key: 'replay-demo', name: 'replay-demo', repoPath: '/projects/replay-demo' };
const HOST = '/home/demo/replay-demo';
const DIMS = 768;
const pushback: Classification = { label: 'pushback', confidence: 0.92, summary: 'the owner pushed back', signals: [] };

/** A unit vector near axis `axis` (tilt moves it toward the next axis), so misses on one axis repeat each other. */
const vec = (axis: number, tilt = 0) => {
  const v = Array.from({ length: DIMS }, (_, i) => (i === axis ? 1 : i === axis + 1 ? tilt : 0));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

type Miss = { id: string; axis: number; tilt: number; file: string; missed: string; title: string; rule: string };
const MISSES: Miss[] = [
  { id: 'rd-1', axis: 1, tilt: 0, file: 'src/routes/orders.ts', missed: 'the orders route returned every tenant\'s rows', title: 'Scope order queries to the tenant', rule: 'Read orders through db.scoped(orgId).' },
  { id: 'rd-2', axis: 1, tilt: 0.1, file: 'src/routes/orders.ts', missed: 'the order export ignored the tenant again', title: 'Scope the order export to the tenant', rule: 'The export reads through db.scoped(orgId) too.' },
  { id: 'rd-3', axis: 3, tilt: 0, file: 'src/http.ts', missed: 'an error was sent as a bare string', title: 'Errors go through sendError', rule: 'Respond to failures with sendError(res, status, code, message).' },
  { id: 'rd-4', axis: 3, tilt: 0.12, file: 'src/http.ts', missed: 'a 404 was sent as plain text', title: 'Not-found answers use sendError', rule: 'A 404 is sendError(res, 404, "not_found", message).' },
  { id: 'rd-5', axis: 5, tilt: 0, file: 'src/routes/customers.ts', missed: 'the list endpoint returned the whole table', title: 'Be careful', rule: 'Be careful with lists.' },
];
/** New after the cut: a replay at the cut must not see it. */
const LATE: Miss = { id: 'rd-6', axis: 1, tilt: 0.05, file: 'src/routes/orders.ts', missed: 'the order search leaked other tenants', title: 'Scope order search to the tenant', rule: 'Search reads through db.scoped(orgId).' };

const lessonId = (m: Miss) => `lesson:${m.id}-t1`;
const tick = () => new Promise((r) => setTimeout(r, 15));

function session(m: Miss): ParsedSession {
  const turns = [0, 1, 2].map((i) => ({
    uuid: `${m.id}-t${i}`, sessionId: m.id, ts: new Date(Date.now() - (3 - i) * 60_000).toISOString(), index: i, text: i === 1 ? `no: ${m.missed}` : `turn ${i}`,
    precedingAssistantText: 'done', precedingToolCalls: [],
  }));
  const calls: ToolCall[] = [{ name: 'Edit', ts: turns[0].ts, filePath: `${HOST}/${m.file}` }];
  return { sessionId: m.id, sourceFile: `${m.id}.jsonl`, cwd: HOST, gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: calls };
}

/** A confirmed miss and its proposed lesson, as the worker makes them, with the post-mortem's Activity entry. */
async function miss(s: Store, m: Miss) {
  const p = DEMO_REPLAY_PROJECT;
  const sess = session(m);
  await s.graph.upsertSession(p, sess, []);
  await s.codegraph.recordSessionFiles(m.id, sessionFiles(sess, HOST));
  await s.graph.saveClassification(`${m.id}-t1`, pushback, true);
  await s.graph.decide(`${m.id}-t1`, 'confirmed', null);
  const pm: PostMortem = {
    taskTitle: `work on ${m.file}`, missed: m.missed, cause: 'requirement_unstated', causeExplanation: 'the rule was never written down', outcome: 'addressed',
    lesson: { title: m.title, rule: m.rule, appliesWhen: `changing ${m.file}`, scope: 'project', paths: [m.file] }, contextItems: [],
  };
  await s.knowledge.savePostmortem(`${m.id}-t1`, pm, { miss: vec(m.axis, m.tilt), lesson: vec(m.axis, m.tilt) });
  await s.activity.record({ kind: 'postmortem_done', actor: 'postmortem', projectKey: p.key, subject: m.missed, why: 'synthetic', targets: [`${m.id}-t1`, `miss:${m.id}-t1`] });
}

/** The owner's decision on a lesson, recorded as the API records it. */
async function decideLesson(s: Store, id: string, status: 'approved' | 'rejected') {
  const l = (await s.knowledge.lessonDetail(id))!.lesson;
  await s.knowledge.updateLesson(id, { status }, { by: 'you' });
  await s.activity.record({
    kind: 'lesson_decided', actor: 'you', projectKey: l.projectKey, subject: `${status} lesson "${l.title}"`, why: 'synthetic',
    details: { status, changed: {}, supersedes: null }, targets: [id],
  });
}

/**
 * Seed the history into an empty store. Returns the cut: everything before it is the loop's to read, everything after
 * it is "the owner's later actions".
 */
export async function seedReplayDemo(s: Store): Promise<{ t0: number; project: string }> {
  for (const m of MISSES) {
    await miss(s, m);
    await tick();
  }
  const [orders, , errors, notFound, careful] = MISSES.map(lessonId);
  await decideLesson(s, orders, 'approved');
  await s.knowledge.setLessonChecks(careful, [{ name: 'platitude', why: 'says nothing a reader could act on' }]);
  // An Inbox item still waiting at the cut.
  await s.graph.upsertSession(DEMO_REPLAY_PROJECT, session({ ...MISSES[0], id: 'rd-inbox', missed: 'please keep the tenant check' }), []);
  const inbox = (await s.graph.saveClassification('rd-inbox-t1', pushback, true))!;
  // Agents were served the approved lesson and judged against it.
  for (const [i, status] of (['addressed', 'not_applicable', 'not_addressed', 'addressed'] as const).entries()) {
    await s.activity.record({ kind: 'context_served', actor: 'agent', projectKey: DEMO_REPLAY_PROJECT.key, subject: 'task context', why: 'synthetic', details: { lessons: [{ id: orders }] }, targets: [orders, `sess-${i}`] });
    await s.activity.record({ kind: 'predone_check', actor: 'agent', projectKey: DEMO_REPLAY_PROJECT.key, subject: 'done check', why: 'synthetic', details: { verdicts: [{ lessonId: orders, status }] }, targets: [orders, `sess-${i}`] });
  }
  await tick();
  const t0 = Date.now();
  await tick();

  // After the cut: what the owner did.
  await decideLesson(s, errors, 'approved');
  await decideLesson(s, notFound, 'approved');
  await decideLesson(s, careful, 'rejected');
  const before = (await s.knowledge.lessonDetail(orders))!.lesson;
  const rule = 'Read and write orders only through db.scoped(orgId); never db.raw() in a route.';
  await s.knowledge.updateLesson(orders, { rule }, { by: 'you' });
  await s.activity.record({
    kind: 'lesson_decided', actor: 'you', projectKey: before.projectKey, subject: `edited lesson "${before.title}"`, why: 'synthetic',
    details: { status: before.status, changed: { rule: { from: before.rule, to: rule } }, supersedes: null }, targets: [orders],
  });
  await s.graph.decide(inbox, 'confirmed', null, 'you');
  await s.activity.record({ kind: 'feedback_decided', actor: 'you', projectKey: DEMO_REPLAY_PROJECT.key, subject: 'confirmed: "please keep the tenant check"', why: 'synthetic', details: { status: 'confirmed' }, targets: [inbox] });
  await miss(s, LATE);
  return { t0, project: DEMO_REPLAY_PROJECT.key };
}
