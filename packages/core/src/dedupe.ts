import { INBOX_MERGE_MINUTES, INBOX_SEMANTIC_COSINE, INBOX_SEMANTIC_DAYS, INBOX_WORD_OVERLAP } from './thresholds.ts';
import type { AgentReport, CandidateOrigin } from './types.ts';

/**
 * One miss, two reports: the detector flags the developer's pushback from the transcript, and the agent may also call
 * report_feedback about it. A report within REPORT_MERGE_MINUTES of a flagged turn in the same project, with similar
 * words or from the same session, is the same miss and becomes one Inbox item that keeps both provenances. So is one
 * whose embedding is within INBOX_SEMANTIC_COSINE of the item's, within INBOX_SEMANTIC_DAYS (0.9.1): a reworded
 * complaint, or the same one the next day.
 */

/** The agent usually reports after fixing the work, so its report can come well after the turn it is about (thresholds.ts). */
export const REPORT_MERGE_MINUTES = INBOX_MERGE_MINUTES;

const STOP = new Set(['the', 'and', 'you', 'this', 'that', 'for', 'with', 'are', 'was', 'were', 'its', "it's", 'not', 'but', 'have', 'has', 'please', 'also']);
/** Two reports are similar when this share of the shorter one's words appears in the other (thresholds.ts). */
const MIN_OVERLAP = INBOX_WORD_OVERLAP;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length >= 3 && !STOP.has(w)));
}

/** Whether two texts say mostly the same thing: at least two meaningful words each, and most of the shorter one's shared. */
export function similarReports(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  if (small.size < 2) return false;
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return shared / small.size >= MIN_OVERLAP;
}

/** embedding: the text's, when it was embedded (a report or flagged item made before 0.9.1 has none). */
export type ReportLike = { ts: string; text: string; sessionId?: string | null; embedding?: number[] | null };

/** How far apart in time two reports of one miss may be: by words (minutes), and by meaning (days). */
export const REPORT_SEMANTIC_DAYS = INBOX_SEMANTIC_DAYS;
/** The widest window a store reads candidates in for matchReport: by meaning when the report has an embedding. */
export const reportWindowMs = (report: Pick<ReportLike, 'embedding'>) => (report.embedding?.length ? REPORT_SEMANTIC_DAYS * 86_400_000 : REPORT_MERGE_MINUTES * 60_000);

/** The cosine of two embeddings of one model (same length); null when they cannot be compared. */
export function embeddingCosine(a: number[] | null | undefined, b: number[] | null | undefined): number | null {
  if (!a?.length || !b?.length || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : null;
}

/** The item that is the same miss as `report` (see the file comment), closest in time; null when none is. */
export function matchReport<T extends ReportLike>(report: ReportLike, items: T[], minutes = REPORT_MERGE_MINUTES): T | null {
  const t0 = Date.parse(report.ts);
  if (Number.isNaN(t0)) return null;
  let best: { item: T; gap: number } | null = null;
  for (const item of items) {
    const gap = Math.abs(Date.parse(item.ts) - t0);
    if (Number.isNaN(gap)) continue; // an unreadable time never matches
    const sameSession = !!report.sessionId && report.sessionId === item.sessionId;
    const byWords = gap <= minutes * 60_000 && (sameSession || similarReports(report.text, item.text));
    const cos = byWords ? null : embeddingCosine(report.embedding, item.embedding);
    const byMeaning = cos !== null && cos >= INBOX_SEMANTIC_COSINE && gap <= REPORT_SEMANTIC_DAYS * 86_400_000;
    if (!byWords && !byMeaning) continue;
    if (!best || gap < best.gap) best = { item, gap };
  }
  return best?.item ?? null;
}

/**
 * Who flagged an Inbox item and what the agent reported, from what a store keeps on it: `manual` (created by
 * report_feedback), `detected` (a report the detector then found in the transcript) and the stored report. Items
 * reported before reports were stored keep their words in their own turn.
 */
export function candidateProvenance(k: {
  manual: boolean;
  detected: boolean;
  agentReport: AgentReport | null;
  turnText: string | null | undefined;
  turnWhatWasDone: string | null | undefined;
  createdAt: string;
}): { origins: CandidateOrigin[]; agentReport: AgentReport | null } {
  const agentReport =
    k.agentReport ?? (k.manual ? { text: k.turnText ?? '', whatWasDone: k.turnWhatWasDone ?? '', reportedAt: k.createdAt, sessionId: null } : null);
  const origins: CandidateOrigin[] = [];
  if (!k.manual || k.detected) origins.push('detector');
  if (agentReport) origins.push('agent');
  return { origins, agentReport };
}
