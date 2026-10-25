import { expect, test } from 'vitest';
import { codeLinkLabel, codeNodeCaption, codeNodeLabel, escapeHtml, evidenceLinkLabel, evidenceNodeLabel, LabelPlacer, shortestSuffixes } from './graphLabels.ts';

// force-graph renders nodeLabel/linkLabel strings as HTML: untrusted text (feedback, lesson titles, paths) is escaped.
const evil = '<img src=x onerror=alert(1)>';

test('escapeHtml escapes the HTML metacharacters', () => {
  expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('an evidence node label is escaped text', () => {
  const s = evidenceNodeLabel({ kind: 'feedback', label: evil });
  expect(s).toBe('feedback: &lt;img src=x onerror=alert(1)&gt;');
  expect(s).not.toContain('<');
});

test('a code node label is escaped text, file and lesson alike', () => {
  expect(codeNodeLabel({ kind: 'lesson', label: evil, score: 0, misses: 0 })).toBe('lesson: &lt;img src=x onerror=alert(1)&gt;');
  const f = codeNodeLabel({ kind: 'file', label: `src/${evil}.ts`, score: 1.5, misses: 2 });
  expect(f).toBe('src/&lt;img src=x onerror=alert(1)&gt;.ts · score 1.50 · 2 misses');
});

test('link labels are escaped too', () => {
  expect(evidenceLinkLabel({ type: evil })).not.toContain('<');
  expect(codeLinkLabel({ type: evil })).not.toContain('<');
});

test('a file node is captioned with its base name: always when it had misses, else once zoomed in', () => {
  const f = { kind: 'file', label: 'src/webapp/page.tsx', score: 1, misses: 0 };
  expect(codeNodeCaption(f, 0.8)).toBeNull();
  expect(codeNodeCaption(f, 1.5)).toBe('page.tsx');
  expect(codeNodeCaption({ ...f, misses: 1 }, 0.5)).toBe('page.tsx');
  expect(codeNodeCaption({ kind: 'miss', label: 'x', misses: 0 }, 3)).toBeNull();
});

test('shortestSuffixes: each path gets the fewest trailing segments no other path shares', () => {
  const s = shortestSuffixes(['src/tools/read/handler.ts', 'src/tools/write/handler.ts', 'src/mcp/types.ts', 'src/db/types.ts', 'src/app.ts', 'lib/a/index.ts', 'lib/b/a/index.ts']);
  expect(s.get('src/tools/read/handler.ts')).toBe('read/handler.ts');
  expect(s.get('src/tools/write/handler.ts')).toBe('write/handler.ts');
  expect(s.get('src/mcp/types.ts')).toBe('mcp/types.ts');
  expect(s.get('src/app.ts')).toBe('app.ts');
  // One path is a suffix of the other: the shorter one needs all of itself.
  expect(s.get('lib/a/index.ts')).toBe('lib/a/index.ts');
  expect(s.get('lib/b/a/index.ts')).toBe('b/a/index.ts');
});

test('a top hotspot is captioned at any zoom, with its short label when given', () => {
  const f = { kind: 'file', label: 'src/tools/read/handler.ts', score: 9, misses: 0 };
  expect(codeNodeCaption(f, 0.3)).toBeNull();
  expect(codeNodeCaption(f, 0.3, { top: true, short: 'read/handler.ts' })).toBe('read/handler.ts');
  expect(codeNodeCaption(f, 2, { short: 'read/handler.ts' })).toBe('read/handler.ts');
});

test('LabelPlacer keeps the first label in a spot and refuses one that overlaps it', () => {
  const p = new LabelPlacer();
  expect(p.place(0, 0, 40, 10)).toBe(true);
  expect(p.place(20, 5, 40, 10)).toBe(false);
  expect(p.place(0, 12, 40, 10)).toBe(true);
  p.reset();
  expect(p.place(20, 5, 40, 10)).toBe(true);
});
