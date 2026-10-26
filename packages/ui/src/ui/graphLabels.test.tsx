import { expect, test } from 'vitest';
import { codeLinkLabel, codeNodeCaption, codeNodeLabel, escapeHtml, evidenceLinkLabel, evidenceNodeLabel, keyFiles, LabelPlacer, placeCaptions, shortestSuffixes } from './graphLabels.ts';

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

test('LabelPlacer refuses a caption that would cover a node, never its own (drawn below it)', () => {
  const p = new LabelPlacer();
  p.block(30, 0, 10, 10); // a neighbour's node
  p.block(0, -10, 10, 10); // the captioned node itself, just above its caption
  expect(p.place(0, 2, 40, 10)).toBe(false);
  expect(p.place(0, 2, 25, 10)).toBe(true);
  p.reset();
  expect(p.place(0, 2, 40, 10)).toBe(true);
});

test('LabelPlacer caps captions per area, so the dense centre of a map does not fill with text', () => {
  const p = new LabelPlacer({ cell: 100, perCell: 2 });
  expect(p.place(0, 0, 20, 5)).toBe(true);
  expect(p.place(0, 10, 20, 5)).toBe(true);
  expect(p.place(0, 20, 20, 5)).toBe(false);
  // Another area has its own allowance.
  expect(p.place(150, 0, 20, 5)).toBe(true);
  p.reset();
  expect(p.place(0, 20, 20, 5)).toBe(true);
});

/** A zoomed-out map as the fit leaves it: 400 nodes 9 px apart on screen, captions 11 px type, wider than the gaps. */
function denseMap() {
  const nodes: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) nodes.push({ x: 200 + i * 9, y: 100 + j * 9, r: 4.5 });
  return nodes;
}
const width = (s: string) => s.length * 6;

test('at the default zoom of a dense map the key files are all named: captions of key files may cover nodes, not each other', () => {
  const nodes = denseMap();
  // Twelve key files spread over the map, 45 px apart across: closer than their captions are wide.
  const keys = [0, 5, 10, 15].flatMap((i) => [2, 9, 16].map((j) => i * 20 + j)).map((i) => ({ i, text: `key-${i}.ts` }));
  const captions = nodes.map((n, i) => {
    const key = keys.find((k) => k.i === i);
    return { text: key ? key.text : `file-${i}.ts`, x: n.x, y: n.y, r: n.r, rank: key ? 1e6 - i : 0, key: !!key };
  });
  const placed = placeCaptions(captions, { nodes: nodes.map((n) => [n.x - n.r, n.y - n.r, 2 * n.r, 2 * n.r] as [number, number, number, number]), width, height: 13, gap: 2, cell: 160, perCell: 3 });
  expect(keys.every((k) => placed.some((p) => p.text === k.text))).toBe(true);
  // No two drawn captions overlap.
  for (const a of placed) for (const b of placed) {
    if (a === b) continue;
    expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
  }
  // The rest stay out of the dense centre (they would cover nodes).
  expect(placed.filter((p) => p.text.startsWith('file-')).length).toBeLessThan(10);
});

test('a file with misses is always named, even where every spot around it is taken', () => {
  const nodes = [{ x: 0, y: 0, r: 4 }, { x: 4, y: 0, r: 4 }];
  const placed = placeCaptions([
    { text: 'a-long-hotspot-name.ts', x: 0, y: 0, r: 4, rank: 2e6, key: true },
    { text: 'missed.ts', x: 4, y: 0, r: 4, rank: 1e6, key: true, must: true },
  ], { nodes: nodes.map((n) => [n.x - n.r, n.y - n.r, 2 * n.r, 2 * n.r] as [number, number, number, number]), width, height: 13, gap: 2 });
  expect(placed.map((p) => p.text).sort()).toEqual(['a-long-hotspot-name.ts', 'missed.ts']);
});

test('importance: files with misses first, then by hotspot score, then by how many edges they have; tests and other kinds never', () => {
  const ranked = keyFiles([
    { id: 'file:a', kind: 'file', path: 'a', score: 3, misses: 0 },
    { id: 'file:b', kind: 'file', path: 'b', score: 0, misses: 0 },
    { id: 'file:c', kind: 'file', path: 'c', score: 0, misses: 0 },
    { id: 'file:d', kind: 'file', path: 'd', score: 1, misses: 2 },
    { id: 'miss:1', kind: 'miss', score: 0, misses: 0 },
  ], [{ source: 'file:c', target: 'file:a' }, { source: 'file:c', target: 'file:b' }], 3);
  expect(ranked).toEqual(['d', 'a', 'c']);
  // With nothing scored (a fresh map) the most connected files are still named.
  expect(keyFiles([{ id: 'file:x', kind: 'file', path: 'x', score: 0, misses: 0 }, { id: 'file:y', kind: 'file', path: 'y', score: 0, misses: 0 }], [{ source: 'file:y', target: 'file:x' }, { source: 'file:y', target: 'file:z' }], 1)).toEqual(['y']);
});
