// Which approved lessons reach an agent, and how much room each part of an answer gets: the team's 0.6.2 report
// ("0 of 6 served lessons applied; a nonsense task still gets 4"; "search_graph returned only 5 irrelevant lessons and
// cut every miss and fact"; "impact on hub files lists 0 dependents because lessons fill the budget").
import type { ActivityInput, FactHit, FileMiss, Impact, Lesson, LessonHit, RelatedMiss } from '@fb/core';
import { ACME_TASKS, PATH_TASK, searchAcme } from '@fb/core/testing/lessons';
import { describe, expect, test } from 'vitest';
import { checkBeforeDone, getImpact, getTaskContext, searchGraph, type ContextDeps } from './context.ts';

const roots = [{ host: '/Users/j/Vibe', container: '/vibe' }];
const NONSENSE = ACME_TASKS.filter((t) => !t.applies.length).map((t) => t.task);

/** The acme project, whose lesson search scores the acme corpus against the text last embedded (wordEmbed). */
function acme(over: Partial<ContextDeps> = {}): ContextDeps & { judged: LessonHit[][]; asked: number[]; recorded: ActivityInput[] } {
  let last = '';
  const judged: LessonHit[][] = [];
  const asked: number[] = [];
  const recorded: ActivityInput[] = [];
  return {
    roots,
    embed: async (t) => ((last = t[0]), t.map(() => [1])),
    k: {
      searchLessons: async (q) => (asked.push(q.k), searchAcme(last, q.k)),
      relatedMisses: async () => [],
      recordPreDoneCheck: async () => {},
      createManualFeedback: async () => 'manual:1',
    },
    judge: async (_w, lessons) => (judged.push(lessons), []),
    activity: { record: async (a) => { recorded.push(a); } },
    judged,
    asked,
    recorded,
    ...over,
  } as ContextDeps & { judged: LessonHit[][]; asked: number[]; recorded: ActivityInput[] };
}

const FOLLOW = '## Approved lessons (follow these)';
const RELATED = '## Possibly related lessons';
const section = (md: string, head: string) => (md.includes(head) ? md.slice(md.indexOf(head)).split('\n## ')[0] : '');

describe('approved lessons for a task', () => {
  test('the search is asked for a pool of lessons, so the gate can see how the rest scored', async () => {
    const d = acme();
    await getTaskContext({ cwd: '/Users/j/Vibe/acme', task: ACME_TASKS[2].task }, d);
    expect(Math.min(...d.asked)).toBeGreaterThanOrEqual(30);
  });

  test('a nonsense task gets no lesson, to follow or possibly related', async () => {
    for (const task of NONSENSE) {
      const r = await getTaskContext({ cwd: '/Users/j/Vibe/acme', task }, acme());
      expect(r.lessons).toEqual([]);
      expect(r.markdown).not.toContain(RELATED);
      expect(r.markdown).not.toContain('**');
    }
  });

  test('a semantic-only match is dropped, including its possibly-related pointer', async () => {
    const d = acme();
    const r = await getTaskContext({ cwd: '/Users/j/Vibe/acme', task: 'rotate the refresh token when a session is renewed' }, d);
    expect(r.lessons.map((h) => h.lesson.id)).toEqual([]);
    const follow = section(r.markdown, FOLLOW);
    const related = section(r.markdown, RELATED);
    expect(follow).toBe('');
    expect(related).toBe('');
    expect(related).not.toContain('Late events are accepted for 3 days');
    expect(follow).not.toContain('Late events');
    // The Activity entry tells the two apart.
    const details = d.recorded[0].details as { lessons: { id: string }[]; related: { id: string }[] };
    expect(details.lessons.map((x) => x.id)).toEqual([]);
    expect(details.related).toBeUndefined();
  });

  test('a lesson tied to a named file is followed whatever the task says', async () => {
    const r = await getTaskContext({ cwd: '/Users/j/Vibe/acme', task: PATH_TASK.task, files: PATH_TASK.files }, acme());
    expect(r.lessons.map((h) => h.lesson.id)).toContain(PATH_TASK.tied);
  });

  test('brief drops untied lessons instead of offering possibly-related pointers', async () => {
    const r = await getTaskContext({ cwd: '/Users/j/Vibe/acme', task: 'rotate the refresh token when a session is renewed', brief: true }, acme());
    expect(r.lessons.map((h) => h.lesson.id)).toEqual([]);
    expect(r.markdown).not.toContain('possibly related');
    const none = await getTaskContext({ cwd: '/Users/j/Vibe/acme', task: NONSENSE[0], brief: true }, acme());
    expect(none.lessons).toEqual([]);
  });

  test('check_before_done judges only what would be followed: nothing for a nonsense task, a lesson tied to a changed file always', async () => {
    const d = acme();
    await checkBeforeDone({ cwd: '/Users/j/Vibe/acme', task: NONSENSE[0], summary: 'sang it' }, d);
    expect(d.judged).toEqual([]);
    const tied = acme();
    await checkBeforeDone({ cwd: '/Users/j/Vibe/acme', task: PATH_TASK.task, summary: 'reworded them', diff: 'x', filesChanged: PATH_TASK.files }, tied);
    expect(tied.judged[0].map((h) => h.lesson.id)).toContain(PATH_TASK.tied);
    const topic = acme();
    await checkBeforeDone({ cwd: '/Users/j/Vibe/acme', task: 'rotate the refresh token when a session is renewed', summary: 'rotated it', diff: 'x' }, topic);
    expect(topic.judged).toEqual([]);
  });
});

// ── search_graph's budget ──

const longLesson = (i: number): LessonHit => ({
  lesson: {
    id: `l${i}`, projectKey: 'acme', origin: 'acme', title: `Checkout lesson ${i}`, rule: `Checkout ${'must keep the cart, the address and the payment step in this order, '.repeat(8)}`,
    appliesWhen: 'changing checkout', scope: 'project', paths: [], status: 'approved', source: 'postmortem', cause: 'requirement_unstated', missId: null, createdAt: 't', decidedAt: 't',
  },
  score: 0.8 - i * 0.005,
});
const miss = (i: number): RelatedMiss => ({ missId: `m${i}`, missed: `missed the checkout total rounding in case ${i}`, cause: 'context_available_ignored', feedbackText: 'the total is off by a cent again', sessionId: `s${i}`, ts: '2026-10-10T10:00:00Z', score: 0.95 - i * 0.01 } as RelatedMiss);
const fact = (i: number): FactHit => ({
  fact: { id: `f${i}`, projectKey: 'acme', path: `services/billing/src/checkout${i}.ts`, lines: '1-9', kind: 'convention', statement: `Checkout fact ${i}: totals are integer cents`, why: 'w', confidence: 1, source: 'x', createdAt: 't', scanJobId: null, fileHash: null, fileSummary: null, relevance: 0.8, relevanceBy: 'model', docId: null } as never,
  score: 0.98 - i * 0.005,
});

describe('search_graph', () => {
  test('lessons never take the whole answer: misses and facts get their share, and each section says what it cut', async () => {
    const d = acme({
      k: { ...acme().k, searchLessons: async () => Array.from({ length: 6 }, (_, i) => longLesson(i)), relatedMisses: async () => Array.from({ length: 8 }, (_, i) => miss(i)) },
      facts: { searchFacts: async () => Array.from({ length: 20 }, (_, i) => fact(i)) },
    });
    const md = (await searchGraph({ cwd: '/Users/j/Vibe/acme', query: 'fix the checkout total' }, d)).markdown;
    expect(md.length).toBeLessThan(3_300);
    expect(md).not.toContain('Checkout lesson 0');
    expect(md).toContain('missed the checkout total rounding in case 0');
    expect(md).toContain('Checkout fact 0');
    // Each section that held items back says how many.
    expect(md).not.toContain('Checkout lesson 0');
    expect(md).toContain('Checkout fact 9');
    const details = d.recorded[0].details as { lessons: string[]; facts: string[]; cut?: string[] };
    // What was served is what was shown.
    expect(details.facts.every((id) => md.includes(`Checkout fact ${id.slice(1)}:`))).toBe(true);
    expect(md).not.toContain('Possibly related lessons');
  });
});

// ── impact's budget ──

describe('impact on a hub file', () => {
  const lessons: Lesson[] = Array.from({ length: 12 }, (_, i) => longLesson(i).lesson);
  const misses: FileMiss[] = Array.from({ length: 10 }, (_, i) => ({
    missId: `m${i}`, missed: `missed thing ${i}: ${'the logger swallowed the error context, '.repeat(4)}`, cause: 'implementation_error', causeExplanation: 'x', feedbackId: `fb${i}`,
    feedbackText: 'it happened again, '.repeat(10), sessionId: `s${i}`, ts: `2026-10-${String(10 + i).padStart(2, '0')}T10:00:00Z`, paths: ['src/utils/log.ts'], fixedHere: false, lessonId: null,
  }));
  const dependents = Array.from({ length: 60 }, (_, i) => ({ path: `src/jobs/job${String(i).padStart(2, '0')}.ts`, depth: i < 20 ? 1 : i < 40 ? 2 : 3 }));
  const hub: Impact = { paths: ['src/utils/log.ts'], dependents, tests: ['test/log.test.ts'], misses, lessons };
  const d = () => acme({ codegraph: { lessonsForPaths: async () => [], impact: async () => hub } });

  test('lists dependents first, nearest first, and lessons get a share; what was cut is said', async () => {
    const dd = d();
    const md = (await getImpact({ cwd: '/Users/j/Vibe/acme', paths: ['src/utils/log.ts'] }, dd)).markdown;
    expect(md.length).toBeLessThan(4_500);
    const listed = md.match(/^- `src\/jobs\/job\d\d\.ts`/gm) ?? [];
    expect(listed.length).toBeGreaterThanOrEqual(20);
    expect(listed[0]).toBe('- `src/jobs/job00.ts`');
    expect(md.indexOf('## Files that depend on them')).toBeLessThan(md.indexOf('## Approved lessons'));
    expect(md).toContain('Checkout lesson 0');
    expect(md).toMatch(/- and \d+ more approved lessons?/);
    expect(md).toMatch(/- and \d+ more dependents?/);
  });
});
