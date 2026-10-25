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

/** The caption drawn under a file node (its base name; the full path is on hover), or null for none at this zoom. */
export function codeNodeCaption(n: { kind: string; label: string; misses: number }, scale: number): string | null {
  if (n.kind !== 'file' && n.kind !== 'test') return null;
  if (n.misses === 0 && scale < CAPTION_ZOOM) return null;
  return n.label.split('/').pop() || n.label;
}

export const evidenceLinkLabel = (l: { type: string }) => escapeHtml(l.type);
export const codeLinkLabel = evidenceLinkLabel;
