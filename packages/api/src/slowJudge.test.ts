import { expect, test } from 'vitest';
import type { Lesson } from '@fb/core';
import { Admission } from './admission.ts';
import { checkBeforeDone, type ContextDeps } from './context.ts';

// A judge slower than the check's response budget (a loaded host's Ollama took 50 s for 5 tokens, the budget is 50 s),
// with many checks at once. Each check's obedient retries must collect the one judge call it started, never start
// another, and every answer before the verdict must still give the lessons to check by hand.
const lesson = (id: string): Lesson => ({ id, projectKey: 'demo', origin: 'demo', title: `Rule ${id}`, rule: `Follow rule ${id} in src/${id}.ts`, appliesWhen: 'editing it', scope: 'project', paths: [`src/${id}.ts`], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' });
const BUDGET = 400;
const SERVICE = 650;

test('under load, retries after the advised wait join the running judge call: one call per check, and the lessons meanwhile', async () => {
  const queue = new Admission({ concurrency: 2, timeoutMs: BUDGET });
  const calls = new Map<string, number>();
  const d = (id: string): ContextDeps => ({
    roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]], judgeQueue: queue, checkRetryIdentity: 'agent', checkTimeoutMs: BUDGET,
    k: { searchLessons: async () => [{ lesson: lesson(id), score: .9 }], relatedMisses: async () => [], missesNaming: async () => [], createManualFeedback: async () => 'f', recordPreDoneCheck: async () => {} },
    // Like askJson: the model call is abandoned at the deadline it was given.
    judge: async (_work, lessons, turn = {}) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      await new Promise((resolve, reject) => {
        const done = setTimeout(resolve, SERVICE);
        if (turn.deadline !== undefined) setTimeout(() => { clearTimeout(done); reject(new Error('model call deadline')); }, Math.max(0, turn.deadline - Date.now()));
      });
      return lessons.map((h) => ({ lessonId: h.lesson.id, status: 'addressed' as const, applies: true, why: 'done', evidence: ['+ok'] }));
    },
  });
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const diff = (id: string) => `diff --git a/src/${id}.ts b/src/${id}.ts\n--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n-x\n+ok\n`;
  const finalOf = await Promise.all(ids.map(async (id) => {
    const args = { project: 'demo', task: `edit src/${id}.ts`, summary: 'changed it', filesChanged: [`src/${id}.ts`], diff: diff(id) };
    for (let attempt = 0; attempt < 12; attempt++) {
      const r = await checkBeforeDone(args, d(id));
      if (!r.queued) return { id, attempt, r };
      // Every not-yet-judged answer names the lesson to check by hand, and one plain line on when to retry.
      expect(r.markdown).toContain(`Rule ${id}`);
      expect(r.markdown).toMatch(/Call check_before_done again with the same arguments in about \d+ s\./);
      expect(r.markdown).not.toMatch(/planning window|physical|logical position|retained priority|authorized/i);
      await new Promise((resolve) => setTimeout(resolve, Math.min(r.queue?.retryAfterMs ?? 1000, 1000) / 20));
    }
    return { id, attempt: -1, r: null };
  }));
  for (const { id, attempt, r } of finalOf) {
    expect(attempt, id).toBeGreaterThanOrEqual(0);
    expect(r!.status, id).toBe('lesson_judged');
  }
  expect(Object.fromEntries(calls)).toEqual(Object.fromEntries(ids.map((id) => [id, 1])));
}, 30_000);
