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
