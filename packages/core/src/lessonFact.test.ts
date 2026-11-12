import { expect, test } from 'vitest';
import { lessonFactPath, lessonToFact } from './lessonFact.ts';

test('lessonFactPath files a fact under the first path, a glob cut back to its folder, else the project', () => {
  expect(lessonFactPath(['src/db/pool.ts', 'src/b.ts'])).toBe('src/db/pool.ts');
  expect(lessonFactPath(['src/db/**/*.ts'])).toBe('src/db');
  expect(lessonFactPath(['**/*.ts'])).toBe('.');
  expect(lessonFactPath([])).toBe('.');
});

test('lessonToFact: the rule as a convention fact in the lesson project (or origin), everyday relevance, why naming the lesson', () => {
  const l = { title: 'Cents', rule: 'Amounts are stored in cents', paths: ['src/money.ts'], projectKey: 'demo', origin: 'demo' };
  expect(lessonToFact(l, 'used dollars')).toEqual({
    projectKey: 'demo', kind: 'convention', statement: 'Amounts are stored in cents', path: 'src/money.ts', lines: null,
    why: 'From the lesson "Cents": used dollars', relevance: 0.8,
  });
  expect(lessonToFact({ ...l, projectKey: null }, null, { kind: 'gotcha', relevance: 0.3 })).toMatchObject({ projectKey: 'demo', kind: 'gotcha', relevance: 0.3, why: 'From the lesson "Cents"' });
  expect(lessonToFact({ ...l, projectKey: null, origin: null }, null)).toBeNull();
});
