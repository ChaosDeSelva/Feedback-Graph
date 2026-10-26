import { plural } from './display.tsx';

/**
 * force-graph renders nodeLabel/linkLabel strings as HTML (the hover tooltip's innerHTML). Labels carry untrusted
 * text (feedback, lesson titles from transcripts and model output, file paths), so every interpolated value is escaped.
 */
export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const evidenceNodeLabel = (n: { kind: string; label: string }) => `${escapeHtml(n.kind)}: ${escapeHtml(n.label)}`;

export const codeNodeLabel = (n: { kind: string; label: string; score: number; misses: number }) =>
  n.kind === 'file' || n.kind === 'test'
    ? `${escapeHtml(n.label)} · score ${n.score.toFixed(2)} · ${plural(n.misses, 'miss', 'misses')}`
    : `${escapeHtml(n.kind)}: ${escapeHtml(n.label)}`;

/** Zoom at which every file is captioned; below it only files with misses are, so a zoomed-out map stays legible. */
export const CAPTION_ZOOM = 1.2;

/**
 * The caption drawn under a file node, or null for none at this zoom: `short` (its shortest unique path suffix) when
 * given, else its base name; the full path is on hover. Top hotspots (`top`) and files with misses are captioned at
 * every zoom, the rest once zoomed in.
 */
export function codeNodeCaption(n: { kind: string; label: string; misses: number }, scale: number, o: { top?: boolean; short?: string } = {}): string | null {
  if (n.kind !== 'file' && n.kind !== 'test') return null;
  if (!o.top && n.misses === 0 && scale < CAPTION_ZOOM) return null;
  return o.short || n.label.split('/').pop() || n.label;
}

/**
 * For each path, the fewest trailing segments that no other path ends with (`tools/read/handler.ts` beside
 * `tools/write/handler.ts` becomes `read/handler.ts`), so twenty `index.ts` nodes read apart.
 */
export function shortestSuffixes(paths: string[]): Map<string, string> {
  const split = [...new Set(paths)].map((p) => ({ p, segs: p.split('/') }));
  const tail = (segs: string[], k: number) => segs.slice(-k).join('/');
  const out = new Map<string, string>();
  for (const { p, segs } of split) {
    let k = 1;
    // Another path shares this suffix when it ends with it on a segment boundary.
    const clash = (s: string) => split.some((o) => o.p !== p && (o.p === s || o.p.endsWith(`/${s}`)));
    while (k < segs.length && clash(tail(segs, k))) k++;
    out.set(p, tail(segs, k));
  }
  return out;
}

type Box = [number, number, number, number];
const overlaps = ([bx, by, bw, bh]: Box, x: number, y: number, w: number, h: number) => x < bx + bw && bx < x + w && y < by + bh && by < y + h;

/**
 * Labels drawn this frame, so a later one that would overlap an earlier one is skipped (earlier ones win). Nodes are
 * blocked too, so no caption covers another node; and with `perCell`, at most that many captions sit in each `cell`
 * square (by the caption's centre), so the dense centre of a big map shows a few names, not a pile of them.
 */
export class LabelPlacer {
  private boxes: Box[] = [];
  private nodes: Box[] = [];
  private cells = new Map<string, number>();
  private cell: number;
  private perCell: number;
  constructor(o: { cell?: number; perCell?: number } = {}) {
    this.cell = o.cell ?? 0;
    this.perCell = o.perCell ?? Infinity;
  }
  /** Starts a frame; `o` changes the area cap (its cell is in drawing units, so it follows the zoom). */
  reset(o: { cell?: number; perCell?: number } = {}) {
    this.boxes = [];
    this.nodes = [];
    this.cells.clear();
    if (o.cell !== undefined) this.cell = o.cell;
    if (o.perCell !== undefined) this.perCell = o.perCell;
  }
  /** A node's box (left, top, width, height): no caption may cover it. */
  block(x: number, y: number, w: number, h: number) {
    this.nodes.push([x, y, w, h]);
  }
  /** Takes the box when it overlaps no caption taken so far, whatever nodes it covers and however full its area is. */
  placeOver(x: number, y: number, w: number, h: number): boolean {
    if (this.boxes.some((b) => overlaps(b, x, y, w, h))) return false;
    this.boxes.push([x, y, w, h]);
    return true;
  }
  /** Takes the box whatever it overlaps (a caption that must be drawn); returns it. */
  force(x: number, y: number, w: number, h: number): Box {
    this.boxes.push([x, y, w, h]);
    return [x, y, w, h];
  }
  /** Takes the box (left, top, width, height) when it overlaps no caption taken so far and no node, and its area has room. */
  place(x: number, y: number, w: number, h: number): boolean {
    if (this.boxes.some((b) => overlaps(b, x, y, w, h)) || this.nodes.some((b) => overlaps(b, x, y, w, h))) return false;
    const key = this.cell > 0 ? `${Math.floor((x + w / 2) / this.cell)}:${Math.floor((y + h / 2) / this.cell)}` : '';
    const n = this.cells.get(key) ?? 0;
    if (this.cell > 0 && n >= this.perCell) return false;
    this.cells.set(key, n + 1);
    this.boxes.push([x, y, w, h]);
    return true;
  }
}

export const evidenceLinkLabel = (l: { type: string }) => escapeHtml(l.type);
export const codeLinkLabel = evidenceLinkLabel;

/**
 * The files named at every zoom, most important first: files with misses (most misses first), then by hotspot score,
 * then by how many drawn edges they have, so a fresh map with nothing scored still names its most connected files.
 * Test files and other kinds of node never; at most `n`.
 */
export function keyFiles(nodes: { id: string; kind: string; path?: string; score: number; misses: number }[], links: { source: unknown; target: unknown }[], n: number): string[] {
  const end = (x: unknown) => (typeof x === 'object' && x !== null ? (x as { id: string }).id : String(x));
  const degree = new Map<string, number>();
  for (const l of links) for (const id of [end(l.source), end(l.target)]) degree.set(id, (degree.get(id) ?? 0) + 1);
  return nodes
    .filter((x) => x.kind === 'file' && x.path)
    .map((x) => ({ path: x.path!, misses: x.misses, score: x.score, degree: degree.get(x.id) ?? 0 }))
    .sort((a, b) => b.misses - a.misses || b.score - a.score || b.degree - a.degree || (a.path < b.path ? -1 : 1))
    .slice(0, n)
    .map((x) => x.path);
}

/** A caption to place under (or beside) its node at x, y of radius r. key: a key file's; must: drawn whatever it overlaps. */
export type CaptionWish = { text: string; x: number; y: number; r: number; rank: number; key?: boolean; must?: boolean };
export type PlacedCaption = { text: string; x: number; y: number; w: number; h: number; key: boolean };

/**
 * Where each caption goes this frame, highest rank first. A key file's caption is tried below its node, then above,
 * right and left: it may cover other nodes (it is drawn on a halo) but never another caption, and one marked `must` (a
 * file with misses) is drawn even when all four are taken. Any other caption goes below its node only if it covers no
 * caption and no node and its area (`cell`, `perCell`) has room, so a zoomed-out map names its key files, not a pile.
 */
export function placeCaptions(wishes: CaptionWish[], o: { nodes: Box[]; width: (text: string) => number; height: number; gap: number; cell?: number; perCell?: number }): PlacedCaption[] {
  const placer = new LabelPlacer({ cell: o.cell, perCell: o.perCell });
  for (const b of o.nodes) placer.block(...b);
  const out: PlacedCaption[] = [];
  const h = o.height;
  for (const c of [...wishes].sort((a, b) => b.rank - a.rank)) {
    const w = o.width(c.text);
    const below: Box = [c.x - w / 2, c.y + c.r + o.gap, w, h];
    if (!c.key) {
      if (placer.place(...below)) out.push({ text: c.text, x: below[0], y: below[1], w, h, key: false });
      continue;
    }
    const spots: Box[] = [
      below,
      [c.x - w / 2, c.y - c.r - o.gap - h, w, h],
      [c.x + c.r + o.gap, c.y - h / 2, w, h],
      [c.x - c.r - o.gap - w, c.y - h / 2, w, h],
    ];
    const spot = spots.find((s) => placer.placeOver(...s)) ?? (c.must ? placer.force(...below) : null);
    if (spot) out.push({ text: c.text, x: spot[0], y: spot[1], w, h, key: true });
  }
  return out;
}
