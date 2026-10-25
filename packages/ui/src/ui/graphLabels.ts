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

/** Labels drawn this frame, so a later one that would overlap an earlier one is skipped (earlier ones win). */
export class LabelPlacer {
  private boxes: [number, number, number, number][] = [];
  reset() { this.boxes = []; }
  /** Takes the box (left, top, width, height) when it overlaps none taken so far. */
  place(x: number, y: number, w: number, h: number): boolean {
    if (this.boxes.some(([bx, by, bw, bh]) => x < bx + bw && bx < x + w && y < by + bh && by < y + h)) return false;
    this.boxes.push([x, y, w, h]);
    return true;
  }
}

export const evidenceLinkLabel = (l: { type: string }) => escapeHtml(l.type);
export const codeLinkLabel = evidenceLinkLabel;
