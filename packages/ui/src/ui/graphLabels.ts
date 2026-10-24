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

export const evidenceLinkLabel = (l: { type: string }) => escapeHtml(l.type);
export const codeLinkLabel = evidenceLinkLabel;
