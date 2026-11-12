import { ACME_TASKS, wordEmbed } from '@fb/core/testing/lessons';
import { expect, test } from 'vitest';
import { formatRetrievalReport, pr, runRetrievalEval } from './retrievalEval.ts';

test('precision and recall of a returned set; recall has no meaning when nothing applies', () => {
  expect(pr(['a', 'b'], ['a'])).toEqual({ precision: 0.5, recall: 1, returned: 2 });
  expect(pr([], ['a'])).toEqual({ precision: null, recall: 0, returned: 0 });
  expect(pr(['a'], [])).toEqual({ precision: 0, recall: null, returned: 1 });
});

test('the eval runs every labelled task through the serving path and the vector ranking, and reports per task and overall', async () => {
  const r = await runRetrievalEval(async (t) => t.map(wordEmbed), { model: 'word-buckets', floor: 0.78 });
  expect(r.tasks.map((t) => t.task)).toEqual(ACME_TASKS.map((t) => t.task));
  const refresh = r.tasks.find((t) => t.applies.includes('auth-refresh'))!;
  expect(refresh.top[0].id).toBe('auth-refresh');
  expect(refresh.atK[1]).toEqual({ precision: 1, recall: 1, returned: 1 });
  expect(r.overall.atK[5].recall).toBeGreaterThan(0.5);
  // A nonsense task is served nothing, on either path.
  expect(r.overall.nonsenseServed).toBe(0);
  const text = formatRetrievalReport(r);
  expect(text).toContain('vector ranking @3');
  expect(text).toMatch(/floor 0\.78: keeps \d+\/\d+ applying/);
});
