/**
 * The "How it works" diagram. One source for the Docs page (drawn with the theme's tokens, so it follows the theme toggle)
 * and docs/architecture.svg for the README and guide (`node scripts/architecture-svg.ts` rewrites it with fixed colours).
 * Two layouts of the same boxes and flow: `wide` (four columns) and `narrow` (three, the words wrapped), which the Docs
 * page shows where its column is too narrow for the wide one's text to stay readable.
 */

type Tone = 'plain' | 'you' | 'graph' | 'loop' | 'agent';
/** title and sub: one line each in the wide layout, the lines the narrow one wraps them to. titleY: the first title baseline. */
type Box = { x: number; y: number; w: number; h: number; title: string[]; sub: string[]; tone: Tone; titleY: number };
type Label = { x: number; y: number; text: string; anchor?: 'start' | 'middle' | 'end' };
type Layout = {
  w: number;
  h: number;
  font: { title: number; sub: number; label: number };
  boxes: Box[];
  /** Straight arrows, as [x1, y1, x2, y2]. */
  arrows: [number, number, number, number][];
  /** The return arc: from the agent tools, over the top, back into the agent's next session. */
  arc: string;
  labels: Label[];
  legend: { x: number; y: number; tone: Tone; text: string }[];
};

/** What each box says; the layouts place them. */
const TEXT = {
  sessions: ['Sessions and reviews', 'Claude Code, Codex, GitHub, Linear'],
  flag: ['Flag pushback', '“that’s not right”, “you missed X”'],
  inbox: ['Inbox', 'you confirm it was a real miss', 'you'],
  postmortem: ['Post-mortem', 'the miss, its cause, a lesson'],
  code: ['Your code', 'the project folders you choose'],
  codeMap: ['Code map', 'files, imports, tests, hotspots'],
  facts: ['Facts and docs', 'uploads, linked projects, READMEs'],
  lessons: ['Lessons', 'you approve, or the loop once earned', 'you'],
  loop: ['Learning loop', 'reads outcomes, decides, applies', 'loop'],
  graph: ['The graph: Neo4j or Postgres', 'feedback · misses · causes · lessons · facts · code map · decisions · activity', 'graph'],
  decisions: ['Decisions', 'you keep, roll back or add a note', 'you'],
  dashboard: ['Dashboard', 'every page reads the same graph'],
  work: ['Before work', 'get_task_context: lessons and code', 'agent'],
  done: ['Before “done”', 'check_before_done judges the diff', 'agent'],
} satisfies Record<string, [string, string] | [string, string, Tone]>;
type Name = keyof typeof TEXT;
const text = (name: Name) => TEXT[name] as [string, string, Tone?];

const ARC_LABEL = 'Agents read approved lessons before they start, and check against them before they say “done”';

const LEGEND: { tone: Tone; text: string }[] = [
  { tone: 'you', text: 'you decide' },
  { tone: 'graph', text: 'stored' },
  { tone: 'loop', text: 'learns on its own, every change audited' },
  { tone: 'agent', text: 'what agents get (MCP)' },
];

/** From the right of (x, y) out to arcX, up to arcY, left to toX and down into toY, with rounded corners. */
const arcPath = (x: number, y: number, arcX: number, arcY: number, toX: number, toY: number) =>
  `M ${x} ${y} H ${arcX - 12} Q ${arcX} ${y} ${arcX} ${y - 12} V ${arcY + 12} Q ${arcX} ${arcY} ${arcX - 12} ${arcY} H ${toX + 12} Q ${toX} ${arcY} ${toX} ${arcY + 12} V ${toY}`;

/** Four columns, 1240 wide: docs/architecture.svg, and the Docs page where its column is 976px or wider. */
function wideLayout(): Layout {
  const W = 1240;
  const H = 690;
  const GAP = 40;
  const BW = 264;
  const COL = [24, 24 + BW + GAP, 24 + 2 * (BW + GAP), 24 + 3 * (BW + GAP)];
  const BH = 72;
  const TALL = 84;
  const ROW = [104, 244, 384, 536];
  const box = (c: number, r: number, name: Name, span = 1): Box => {
    const [title, sub, tone = 'plain'] = text(name);
    const h = r === 2 ? TALL : BH;
    return { x: COL[c]!, y: ROW[r]!, w: BW * span + GAP * (span - 1), h, title: [title], sub: [sub], tone, titleY: ROW[r]! + h / 2 - 6 };
  };
  const mid = (c: number) => COL[c]! + BW / 2;
  const rowTop = (r: number) => ROW[r]!;
  const rowBottom = (r: number) => ROW[r]! + (r === 2 ? TALL : BH);
  const rowMid = (r: number) => ROW[r]! + (r === 2 ? TALL / 2 : BH / 2);
  const right = (c: number) => COL[c]! + BW;
  const ARC_Y = 50;
  let lx = COL[0]!;
  const legend = LEGEND.map((l) => {
    const at = { ...l, x: lx, y: H - 32 };
    lx += 24 + l.text.length * 7.6 + 40;
    return at;
  });
  return {
    w: W,
    h: H,
    font: { title: 19, sub: 14, label: 15 },
    boxes: [
      box(0, 0, 'sessions'), box(1, 0, 'flag'), box(2, 0, 'inbox'), box(3, 0, 'postmortem'),
      box(0, 1, 'code'), box(1, 1, 'codeMap'), box(2, 1, 'facts'), box(3, 1, 'lessons'),
      box(0, 2, 'loop'), box(1, 2, 'graph', 3),
      box(0, 3, 'decisions'), box(1, 3, 'dashboard'), box(2, 3, 'work'), box(3, 3, 'done'),
    ],
    arrows: [
      [right(0), rowMid(0), COL[1]!, rowMid(0)],
      [right(1), rowMid(0), COL[2]!, rowMid(0)],
      [right(2), rowMid(0), COL[3]!, rowMid(0)],
      [mid(3), rowBottom(0), mid(3), rowTop(1)],
      [right(0), rowMid(1), COL[1]!, rowMid(1)],
      [mid(1), rowBottom(1), mid(1), rowTop(2)],
      [mid(2), rowBottom(1), mid(2), rowTop(2)],
      [mid(3), rowBottom(1), mid(3), rowTop(2)],
      [right(0), rowMid(2) - 12, COL[1]!, rowMid(2) - 12],
      [COL[1]!, rowMid(2) + 12, right(0), rowMid(2) + 12],
      [mid(0) - 40, rowBottom(2), mid(0) - 40, rowTop(3)],
      [mid(0) + 40, rowTop(3), mid(0) + 40, rowBottom(2)],
      [mid(1), rowBottom(2), mid(1), rowTop(3)],
      [mid(2), rowBottom(2), mid(2), rowTop(3)],
      [mid(3), rowBottom(2), mid(3), rowTop(3)],
    ],
    arc: arcPath(right(3), rowMid(3), W - 14, ARC_Y, mid(0), rowTop(0)),
    labels: [
      { x: W / 2, y: ARC_Y - 12, text: ARC_LABEL },
      { x: mid(0) - 48, y: rowBottom(2) + 39, text: 'records', anchor: 'end' },
      { x: mid(0) + 48, y: rowBottom(2) + 39, text: 'your calls tune it', anchor: 'start' },
    ],
    legend,
  };
}

/** Words to lines of at most `max` characters: an estimate from the font's average character width, as nothing is measured here. */
export function wrapWords(words: string, max: number): string[] {
  const lines: string[] = [];
  for (const word of words.split(' ')) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= max) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** The narrow layout's width: a 460px column draws its 14px text at 11px (460 / 580 × 14). */
export const NARROW_WIDTH = 580;

/**
 * Three columns, the words wrapped, top to bottom: the Docs page below a 976px column (about 768–1366px windows, where the
 * wide one's text fell to 5–10px, and phones, where it scrolls). The same boxes and arrows, but for Before "done", which
 * follows Before work rather than reading the graph beside it.
 */
function narrowLayout(): Layout {
  const W = NARROW_WIDTH;
  const GAP = 23;
  const BW = 158;
  const COL = [20, 20 + BW + GAP, 20 + 2 * (BW + GAP)];
  const font = { title: 18, sub: 14, label: 15 };
  // Characters a line holds, from the average width of a semibold 18px and a regular 14px character, 8px in from each side.
  const titleChars = (w: number) => Math.floor((w - 16) / 9.9);
  const subChars = (w: number) => Math.floor((w - 16) / 7);
  const place: [Name, number, number, number?][] = [
    ['sessions', 0, 0], ['flag', 1, 0], ['inbox', 2, 0],
    ['code', 0, 1], ['postmortem', 2, 1],
    ['codeMap', 0, 2], ['facts', 1, 2], ['lessons', 2, 2],
    ['graph', 0, 3, 3],
    ['loop', 0, 4], ['dashboard', 1, 4], ['work', 2, 4],
    ['decisions', 0, 5], ['done', 2, 5],
  ];
  const sized = place.map(([name, c, r, span = 1]) => {
    const [title, sub, tone = 'plain'] = text(name);
    const w = BW * span + GAP * (span - 1);
    const t = wrapWords(title, titleChars(w));
    const s = wrapWords(sub, subChars(w));
    // Title baselines 31 below the top and 22 apart; the subtitle's 24 below the title's and 18 apart; 14 under the last.
    return { c, r, w, title: t, sub: s, tone, h: 31 + (t.length - 1) * 22 + 24 + (s.length - 1) * 18 + 14 };
  });
  // The arc's label wraps to two lines above the arc; the loop's two labels sit in the taller gap under row 4.
  const ARC_Y = 62;
  const ROW: number[] = [];
  const rowH: number[] = [];
  for (let r = 0, y = ARC_Y + 54; r < 6; r++) {
    ROW.push(y);
    rowH.push(Math.max(...sized.filter((b) => b.r === r).map((b) => b.h)));
    y += rowH[r]! + (r === 4 ? 64 : 36);
  }
  // A box shorter than its row is as tall as the row, its words centred.
  const boxes: Box[] = sized.map((b) => ({ x: COL[b.c]!, y: ROW[b.r]!, w: b.w, h: rowH[b.r]!, title: b.title, sub: b.sub, tone: b.tone, titleY: ROW[b.r]! + (rowH[b.r]! - b.h) / 2 + 31 }));
  const mid = (c: number) => COL[c]! + BW / 2;
  const rowTop = (r: number) => ROW[r]!;
  const rowBottom = (r: number) => ROW[r]! + rowH[r]!;
  const rowMid = (r: number) => ROW[r]! + rowH[r]! / 2;
  const right = (c: number) => COL[c]! + BW;
  const legendY = rowBottom(5) + 44;
  const arcLines = wrapWords(ARC_LABEL, 50);
  return {
    w: W,
    h: legendY + 26 + 24,
    font,
    boxes,
    arrows: [
      [right(0), rowMid(0), COL[1]!, rowMid(0)],
      [right(1), rowMid(0), COL[2]!, rowMid(0)],
      [mid(2), rowBottom(0), mid(2), rowTop(1)],
      [mid(0), rowBottom(1), mid(0), rowTop(2)],
      [mid(2), rowBottom(1), mid(2), rowTop(2)],
      [mid(0), rowBottom(2), mid(0), rowTop(3)],
      [mid(1), rowBottom(2), mid(1), rowTop(3)],
      [mid(2), rowBottom(2), mid(2), rowTop(3)],
      [mid(0) - 28, rowBottom(3), mid(0) - 28, rowTop(4)],
      [mid(0) + 28, rowTop(4), mid(0) + 28, rowBottom(3)],
      [mid(1), rowBottom(3), mid(1), rowTop(4)],
      [mid(2), rowBottom(3), mid(2), rowTop(4)],
      [mid(0) - 28, rowBottom(4), mid(0) - 28, rowTop(5)],
      [mid(0) + 28, rowTop(5), mid(0) + 28, rowBottom(4)],
      [mid(2), rowBottom(4), mid(2), rowTop(5)],
    ],
    arc: arcPath(right(2), rowMid(5), W - 14, ARC_Y, mid(0), rowTop(0)),
    labels: [
      ...arcLines.map((line, i) => ({ x: W / 2, y: ARC_Y - 12 - (arcLines.length - 1 - i) * 20, text: line })),
      { x: mid(0) - 34, y: rowBottom(4) + 37, text: 'records', anchor: 'end' },
      { x: mid(0) + 34, y: rowBottom(4) + 37, text: 'your calls tune it', anchor: 'start' },
    ],
    // Two rows, the longest entry first, so the second column clears it.
    legend: [
      { ...LEGEND[2]!, x: COL[0]!, y: legendY },
      { ...LEGEND[0]!, x: 380, y: legendY },
      { ...LEGEND[3]!, x: COL[0]!, y: legendY + 26 },
      { ...LEGEND[1]!, x: 380, y: legendY + 26 },
    ],
  };
}

type Palette = Record<'canvas' | 'text' | 'muted' | 'line' | 'arrow', string> & Record<Tone, { fill: string; stroke: string }>;

const TOKENS: Palette = {
  canvas: 'var(--color-canvas)',
  text: 'var(--color-text)',
  muted: 'var(--color-muted)',
  line: 'var(--color-line-strong)',
  arrow: 'var(--color-faint)',
  plain: { fill: 'var(--color-surface)', stroke: 'var(--color-line-strong)' },
  you: { fill: 'var(--color-accent-soft)', stroke: 'var(--color-accent-edge)' },
  graph: { fill: 'var(--color-info-soft)', stroke: 'var(--color-info)' },
  loop: { fill: 'var(--color-violet-soft)', stroke: 'var(--color-violet)' },
  agent: { fill: 'var(--color-ok-soft)', stroke: 'var(--color-ok)' },
};

/** styles.css's light and dark values, for the file GitHub shows. */
const LIGHT: Palette = {
  canvas: '#f2f1ec',
  text: '#1d1e20',
  muted: '#66675f',
  line: '#cbc8bd',
  arrow: '#8a897f',
  plain: { fill: '#ffffff', stroke: '#cbc8bd' },
  you: { fill: '#fdf2d3', stroke: '#c58a00' },
  graph: { fill: '#e3ecfb', stroke: '#2f6bd8' },
  loop: { fill: '#eee7fb', stroke: '#7c4ddb' },
  agent: { fill: '#e2f3e8', stroke: '#1f9d55' },
};
const DARK: Palette = {
  canvas: '#161615',
  text: '#ecebe5',
  muted: '#a3a299',
  line: '#43433f',
  arrow: '#77766f',
  plain: { fill: '#1e1e1c', stroke: '#43433f' },
  you: { fill: '#2f2814', stroke: '#a87400' },
  graph: { fill: '#172642', stroke: '#4f84e6' },
  loop: { fill: '#2a2140', stroke: '#9b7cf0' },
  agent: { fill: '#16301f', stroke: '#34ad69' },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TONES: Tone[] = ['plain', 'you', 'graph', 'loop', 'agent'];

const rules = (p: Palette) =>
  [
    `.fga-bg{fill:${p.canvas}}`,
    `.fga-t{fill:${p.text}}`,
    `.fga-s{fill:${p.muted}}`,
    `.fga-a{stroke:${p.arrow};fill:none}`,
    `.fga-h{fill:${p.arrow}}`,
    ...TONES.map((t) => `.fga-${t}{fill:${p[t].fill};stroke:${p[t].stroke}}`),
  ].join('');

const DESCRIPTION =
  'Sessions and reviews flow through pushback flagging, your Inbox and a post-mortem into lessons that you approve (or the learning loop, once your reviews have earned it), alongside the code map and facts, all stored in one graph. ' +
  'Agents get approved lessons before work and a check before done. The learning loop reads outcomes from the graph, records each decision for you to keep or roll back, and your calls tune it.';

/**
 * The diagram as SVG markup. `tokens` uses the app's CSS variables (the Docs page); `static` carries light and dark colours
 * itself (docs/architecture.svg). Class names are prefixed, since an inline SVG's style applies to the whole page; the
 * narrow layout's ids differ from the wide one's, as the Docs page holds both.
 */
export function architectureSvg(colors: 'tokens' | 'static', layout: 'wide' | 'narrow' = 'wide'): string {
  const L = layout === 'wide' ? wideLayout() : narrowLayout();
  const id = layout === 'wide' ? 'fga' : 'fga-narrow';
  const style = colors === 'tokens' ? rules(TOKENS) : `${rules(LIGHT)}@media (prefers-color-scheme: dark){${rules(DARK)}}`;
  const font = `font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif`;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.w} ${L.h}" role="img" aria-labelledby="${id}-title ${id}-desc" style="${font}">`,
    `<title id="${id}-title">How Feedback Graph works</title>`,
    `<desc id="${id}-desc">${esc(DESCRIPTION)}</desc>`,
    `<style>${style}</style>`,
    `<defs><marker id="${id}-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="fga-h"/></marker></defs>`,
  ];
  if (colors === 'static') out.push(`<rect class="fga-bg" width="${L.w}" height="${L.h}" rx="12"/>`);
  out.push(`<path d="${L.arc}" class="fga-a" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#${id}-head)"/>`);
  for (const [x1, y1, x2, y2] of L.arrows) {
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="fga-a" stroke-width="1.6" marker-end="url(#${id}-head)"/>`);
  }
  for (const b of L.boxes) {
    const cx = b.x + b.w / 2;
    const subY = b.titleY + (b.title.length - 1) * 22 + 24;
    const lines = [
      ...b.title.map((t, i) => `<text x="${cx}" y="${b.titleY + i * 22}" text-anchor="middle" class="fga-t" font-size="${L.font.title}" font-weight="600">${esc(t)}</text>`),
      ...b.sub.map((t, i) => `<text x="${cx}" y="${subY + i * 18}" text-anchor="middle" class="fga-s" font-size="${L.font.sub}">${esc(t)}</text>`),
    ];
    out.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" class="fga-${b.tone}" stroke-width="1.5"/>`, ...lines.slice(0, -1), `${lines.at(-1)}</g>`);
  }
  for (const l of L.labels) {
    out.push(`<text x="${l.x}" y="${l.y}" text-anchor="${l.anchor ?? 'middle'}" class="fga-s" font-size="${L.font.label}" font-style="italic">${esc(l.text)}</text>`);
  }
  for (const l of L.legend) {
    out.push(
      `<rect x="${l.x}" y="${l.y - 13}" width="16" height="16" rx="3" class="fga-${l.tone}" stroke-width="1.5"/>`,
      `<text x="${l.x + 24}" y="${l.y}" class="fga-s" font-size="${L.font.label}">${esc(l.text)}</text>`,
    );
  }
  out.push('</svg>');
  return out.join('\n');
}
