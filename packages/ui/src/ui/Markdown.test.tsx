import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Markdown } from './Markdown.tsx';

afterEach(cleanup);

test('renders the markdown an agent writes as text elements, not markup', () => {
  const { container } = render(
    <Markdown text={'**Changes:**\n- moved `filter` to the API\n- added *tests*\n\n```ts\nconst a = 1;\n```\n<b>not html</b>'} />,
  );
  expect(container.querySelector('strong')?.textContent).toBe('Changes:');
  expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['moved filter to the API', 'added tests']);
  expect(container.querySelector('code')?.textContent).toBe('filter');
  expect(container.querySelector('em')?.textContent).toBe('tests');
  expect(container.querySelector('pre')?.textContent).toBe('const a = 1;');
  expect(container.querySelector('b')).toBeNull();
  expect(container.textContent).toContain('<b>not html</b>');
  expect(container.textContent).not.toContain('**');
});

test('leaves stray markers and snake_case alone', () => {
  const { container } = render(<Markdown text={'2 * 3 = 6 and some_var_name stays, a lone ** too'} />);
  expect(container.textContent).toBe('2 * 3 = 6 and some_var_name stays, a lone ** too');
});

test('code inside bold stays code', () => {
  const { container } = render(<Markdown text={'- **`src/db.ts`**: the table'} />);
  expect(container.querySelector('strong code')?.textContent).toBe('src/db.ts');
  expect(container.textContent).toBe('src/db.ts: the table');
});

test('an indented line under a list item continues that item instead of starting a paragraph', () => {
  const { container } = render(<Markdown text={'1. first step\n   which wraps here\n2. second step\n\nafter'} />);
  expect(container.querySelector('ol')).not.toBeNull();
  expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['first step which wraps here', 'second step']);
  expect(container.querySelector('p')?.textContent).toBe('after');
});

test('underscore emphasis renders like the asterisk kind', () => {
  const { container } = render(<Markdown text={'a __strong__ and _soft_ word'} />);
  expect(container.querySelector('strong')?.textContent).toBe('strong');
  expect(container.querySelector('em')?.textContent).toBe('soft');
  expect(container.textContent).toBe('a strong and soft word');
});
