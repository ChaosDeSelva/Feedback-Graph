import { LOOP_MODES, type Decision, type DecisionConfidence, type DecisionStatus, type DecisionTier, type DecisionType, type LoopEventKind, type LoopMode, type LoopState, type LoopTypeState, type RollbackReason, type TargetSnapshot, type TrackKind } from './api.ts';
import type { Tone } from './ui/display.tsx';

/**
 * Words and colors for the learning loop's enums. Every lookup takes a plain string and falls back for a value this
 * build does not know (a newer server's type or status), so an unknown one reads as itself rather than breaking a page.
 */
const lookup = <K extends string, V>(map: Record<K, V>, key: string, fallback: V): V => (Object.hasOwn(map, key) ? map[key as K] : fallback);
const words = (s: string) => s.replace(/_/g, ' ');

const TYPE_LABEL: Record<DecisionType, string> = {
  link_misses: 'link misses',
  merge_duplicates: 'merge duplicates',
  rank_weight: 'ranking weight',
  retire_lesson: 'retire lesson',
  reject_lesson: 'reject lesson',
  approve_lesson: 'approve lesson',
  reword_lesson: 'reword lesson',
  narrow_scope: 'narrow scope',
  record_fact: 'record fact',
  triage_inbox: 'triage Inbox',
  tune_threshold: 'tune threshold',
};
export const typeLabel = (t: string) => lookup(TYPE_LABEL, t, words(t));
/**
 * A DecisionSummary's label (`<type in words> · <target>`, as the API and CLI write it) with the type as this page names
 * it, so a cascade or a dependency reads "ranking weight" like the list and the header, not "rank weight".
 */
export const summaryLabel = (s: { type: string; label: string }) => `${typeLabel(s.type)}${s.label.slice(words(s.type).length)}`;

const STATUS_TONE: Record<DecisionStatus, Tone> = {
  observed: 'neutral', proposed: 'info', applying: 'info', applied: 'ok', rejected: 'bad', rolled_back: 'bad', overridden: 'accent', expired: 'neutral',
};
export const decisionTone = (s: string): Tone => lookup(STATUS_TONE, s, 'neutral');
export const statusLabel = (s: string) => words(s);

/** A mode this build knows. A select shows any other (a newer server's) as itself, never as its first option ("off"). */
export const knownMode = (m: string): m is LoopMode => (LOOP_MODES as readonly string[]).includes(m);
export const modeLabel = (m: string) => (knownMode(m) ? m : `unknown (${m})`);
const MODE_RANK: Record<LoopMode, number> = { off: 0, observe: 1, propose: 2, auto: 3 };
const atMost = (m: LoopMode, cap: LoopMode) => (MODE_RANK[m] > MODE_RANK[cap] ? cap : m);

/**
 * What a type runs as when it follows the global mode `mode`, after the caps core's effectiveTypeMode applies: LOOP_DISABLED
 * or a pause (off), a tokenless install (observe), a tripped breaker and tier P (propose), and a type LOOP_TYPES leaves out.
 */
export function modeUnderGlobal(mode: string, s: Pick<LoopState, 'mode' | 'capped'>, t: Pick<LoopTypeState, 'tier' | 'mode' | 'effectiveMode' | 'breaker'>): string {
  if (!knownMode(mode)) return modeLabel(mode);
  if (s.capped === 'disabled' || s.capped === 'paused') return 'off';
  // Off although neither it nor the global mode is, and nothing caps the loop: LOOP_TYPES does not run it.
  if (t.effectiveMode === 'off' && (t.mode ?? s.mode) !== 'off') return 'off';
  let m = mode;
  if (s.capped === 'tokenless') m = atMost(m, 'observe');
  if (t.breaker.tripped || t.tier === 'P') m = atMost(m, 'propose');
  return m;
}

const MODE_HINT: Record<LoopMode, string> = {
  off: 'nothing runs',
  observe: 'records what it would do, changes nothing',
  propose: 'every decision waits for you',
  auto: 'housekeeping applies itself; agent-facing changes apply once they have earned your trust, the rest wait for you',
};
export const modeHint = (m: string) => lookup(MODE_HINT, m, 'a mode this page does not know');
/** The mode hint in a few words, for a tile that has one line for it; the full one is `modeHint`. */
const MODE_SHORT: Record<LoopMode, string> = { off: 'nothing runs', observe: 'changes nothing', propose: 'everything waits for you', auto: 'applies what it has earned' };
export const modeShort = (m: string) => lookup(MODE_SHORT, m, 'unknown mode');

const TIER_LABEL: Record<DecisionTier, string> = { H: 'housekeeping', A: 'agent-facing', P: 'always proposed' };
export const tierLabel = (t: string) => lookup(TIER_LABEL, t, t);

const EVENT_LABEL: Record<LoopEventKind, string> = {
  decision_made: 'decision made',
  decision_applied: 'applied',
  decision_rolled_back: 'rolled back',
  decision_noted: 'note',
  loop_settings_changed: 'settings changed',
  loop_paused: 'paused',
  loop_round: 'round',
};
export const eventLabel = (k: string) => lookup(EVENT_LABEL, k, words(k));
const EVENT_TONE: Partial<Record<LoopEventKind, Tone>> = { decision_applied: 'ok', decision_rolled_back: 'bad', loop_paused: 'accent', decision_made: 'info' };
export const eventTone = (k: string): Tone => lookup(EVENT_TONE as Record<LoopEventKind, Tone>, k, 'neutral');

const REASON_LABEL: Record<RollbackReason, string> = {
  wrong_evidence: 'wrong evidence',
  too_broad: 'too broad',
  wording: 'wording',
  not_now: 'not now',
  other: 'other',
};
export const reasonLabel = (r: string) => lookup(REASON_LABEL, r, words(r));

const TRACK_LABEL: Record<TrackKind, string> = { served: 'served', judged: 'judged', gap_fixed: 'gap fixed', repeat: 'repeat', owner: 'you', decision: 'decision' };
export const trackLabel = (k: string) => lookup(TRACK_LABEL, k, words(k));
const TRACK_TONE: Partial<Record<TrackKind, Tone>> = { gap_fixed: 'ok', repeat: 'bad', owner: 'accent', decision: 'info' };
export const trackTone = (k: string): Tone => lookup(TRACK_TONE as Record<TrackKind, Tone>, k, 'neutral');

/** The loop wrote it (`loop:<policy version>`, `loop:breaker`). */
export const isLoopActor = (actor: string | null | undefined) => !!actor?.startsWith('loop:');

/** 0.934 → "0.93". */
export const p2 = (n: number) => n.toFixed(2);
/** "1 of 10 (10%)", or "none yet" before anything counts. */
export const rate = (n: number, of: number) => (of ? `${n} of ${of} (${Math.round((100 * n) / of)}%)` : 'none yet');
/** "p 0.93 (lower 0.90), earned from 34 of your reviews". */
export const confidenceLine = (c: Pick<DecisionConfidence, 'p' | 'lower' | 'n'>) => `p ${p2(c.p)} (lower ${p2(c.lower)}), earned from ${c.n} of your review${c.n === 1 ? '' : 's'}`;

/** A one-line name for a decision: its type and its primary target. */
export function decisionTitle(d: Pick<Decision, 'type' | 'targets'>): string {
  const t = d.targets.find((x) => x.role === 'primary') ?? d.targets[0];
  return t ? `${typeLabel(d.type)} · ${t.id}` : typeLabel(d.type);
}

export type DiffRow = { target: string; field: string; before: unknown; after: unknown; now: unknown; nowKnown: boolean };

/**
 * Field by field, every field a decision changed (before ≠ after) and every field that changed since (after ≠ now),
 * per target. `nowKnown` is false where the target is gone or the server sent no current copy.
 */
export function fieldDiff(before: TargetSnapshot[], after: TargetSnapshot[], current: TargetSnapshot[]): DiffRow[] {
  const ids = [...new Set([...before, ...after].map((s) => s.id))];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return ids.flatMap((id) => {
    const b = before.find((s) => s.id === id)?.fields ?? {};
    const a = after.find((s) => s.id === id)?.fields ?? {};
    const now = current.find((s) => s.id === id);
    const n = now?.fields ?? {};
    const fields = [...new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(n)])].sort();
    return fields
      .filter((f) => !same(b[f], a[f]) || (!!now && !same(a[f], n[f])))
      .map((f) => ({ target: id, field: f, before: b[f], after: a[f], now: n[f], nowKnown: !!now }));
  });
}

/** A field's value as text: absent reads as "–", a list of strings (paths) as a list, other objects as JSON. */
export function showValue(v: unknown): string {
  if (v === undefined || v === null) return '–';
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? v.join(', ') : '(none)';
  return JSON.stringify(v);
}

const CSV_COLUMNS = ['id', 'type', 'status', 'projectKey', 'mode', 'tier', 'p', 'lower', 'n', 'band', 'targets', 'createdAt', 'appliedAt', 'decidedAt', 'decidedBy', 'model', 'policyVersion', 'rationale'] as const;
const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** The decisions as CSV, one row each; snapshots and evidence stay in the JSON export. */
export function decisionsCsv(ds: Decision[]): string {
  const rows = ds.map((d) => [
    d.id, d.type, d.status, d.projectKey, d.mode, d.tier, d.confidence.p, d.confidence.lower, d.confidence.n, d.confidence.band,
    d.targets.map((t) => `${t.role}:${t.kind}:${t.id}`).join(' '), d.createdAt, d.appliedAt, d.decidedAt, d.decidedBy, d.model, d.policyVersion, d.rationale,
  ].map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n');
}
