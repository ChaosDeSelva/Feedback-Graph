import { expect, test } from 'vitest';
import { codeLinkLabel, codeNodeLabel, escapeHtml, evidenceLinkLabel, evidenceNodeLabel } from './graphLabels.ts';

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
