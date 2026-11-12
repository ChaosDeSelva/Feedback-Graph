import { LOOP_MODES, type LoopConfig, type LoopMode } from '../config.ts';
import type { DocsStore } from '../store.ts';
import { LOOP_DECISION_TYPES, type DecisionTarget, type DecisionTier, type DecisionType } from '../types.ts';

/**
 * The learning loop's state shared by the worker (which runs it) and the api (which shows and sets it), kept in the
 * store's cursors: its settings, the day's budget, each type's circuit breaker, the rounds the live page follows and
 * the calls a rollback suppressed. The LOOP_* settings themselves are config.loop.
 */

/** Stamped on every decision and calibration bucket: hand weights or feature changes bump it (policy.ts). */
export const LOOP_POLICY_VERSION = 1;
/** What a decision made by the loop is attributed to (Activity actor, decidedBy). */
export const LOOP_ACTOR = `loop:${LOOP_POLICY_VERSION}`;
/** The breaker's own actor, when it drops a type to propose. */
export const LOOP_BREAKER_ACTOR = 'loop:breaker';

/** The owner's choice: housekeeping applies on its own, agent-facing changes once earned. */
export const LOOP_DEFAULT_MODE: LoopMode = 'auto';
const rank = (m: LoopMode) => LOOP_MODES.indexOf(m);
const atMost = (m: LoopMode, cap: LoopMode): LoopMode => (rank(m) > rank(cap) ? cap : m);
const isMode = (v: unknown): v is LoopMode => typeof v === 'string' && (LOOP_MODES as readonly string[]).includes(v);
const isType = (v: string): v is DecisionType => (LOOP_DECISION_TYPES as readonly string[]).includes(v);

/**
 * Per type: its tier; τ, the bar the 10th percentile of its calibrated Beta must clear to apply on its own (raised by
 * the owner, never lowered); the prior every bucket starts from; and minLabels, the owner labels a bucket needs first.
 * Housekeeping starts trusted (Beta(4,1): cold-start lower .56 clears τ .5) and loses that with rollbacks; agent-facing
 * starts at Beta(1,4) and earns it, band by band, from 20 of your reviews in that band; tier P never applies on its own.
 */
export type LoopTypeInfo = { tier: DecisionTier; tauDefault: number; prior: { alpha: number; beta: number }; minLabels: number };
const H: LoopTypeInfo = { tier: 'H', tauDefault: 0.5, prior: { alpha: 4, beta: 1 }, minLabels: 0 };
const A = (tauDefault: number): LoopTypeInfo => ({ tier: 'A', tauDefault, prior: { alpha: 1, beta: 4 }, minLabels: 20 });
const P: LoopTypeInfo = { tier: 'P', tauDefault: 1, prior: { alpha: 1, beta: 4 }, minLabels: 20 };
export const LOOP_TYPE_INFO: Record<DecisionType, LoopTypeInfo> = {
  link_misses: H, merge_duplicates: H, rank_weight: H, retire_lesson: H,
  reject_lesson: A(0.85), approve_lesson: A(0.9), reword_lesson: A(0.88), narrow_scope: A(0.85), record_fact: A(0.88),
  triage_inbox: P, tune_threshold: P, resolve_conflict: P, remove_source: P,
};

/** Scores fall in 5 calibration bands: [0, .2) is 0 ... [.8, 1] is 4. */
export const LOOP_BANDS = 5;
export const bandOf = (score: number) => Math.max(0, Math.min(LOOP_BANDS - 1, Math.floor(score * LOOP_BANDS)));

type Cursors = Pick<DocsStore, 'getCursor' | 'setCursor'>;
const parse = (raw: string | null): unknown => {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);

// ── Settings ───────────────────────────────────────────────────────────

export const LOOP_SETTINGS_CURSOR = 'loop-settings';
/** mode null: follows the global mode. tau null: τ is tauDefault. */
export type LoopTypeSettings = { mode: LoopMode | null; tau: number | null };
/** seededFrom: where the first mode came from: LOOP_MODE, else the default (LOOP_DEFAULT_MODE). */
export type LoopSettings = {
  mode: LoopMode;
  types: Partial<Record<DecisionType, LoopTypeSettings>>;
  paused: { at: string; by: string } | null;
  seededFrom: 'LOOP_MODE' | 'default';
};
/** What of config.loop decides the mode: LOOP_MODE seeds it, LOOP_DISABLED=1 stops the loop, LOOP_TYPES limits it. */
export type LoopModeConfig = Pick<LoopConfig, 'disabled'> & Partial<Pick<LoopConfig, 'types'>>;

export const seedLoopSettings = (c: Partial<Pick<LoopConfig, 'mode'>>): LoopSettings =>
  ({ mode: c.mode ?? LOOP_DEFAULT_MODE, types: {}, paused: null, seededFrom: c.mode ? 'LOOP_MODE' : 'default' });

/** Stored settings; null when none are stored (or not readable). Types this build does not know are left out. */
export function parseLoopSettings(raw: string | null): LoopSettings | null {
  const o = obj(parse(raw));
  if (!o || !isMode(o.mode)) return null;
  const types: LoopSettings['types'] = {};
  for (const [k, v] of Object.entries(obj(o.types) ?? {})) {
    const t = obj(v);
    if (!isType(k) || !t) continue;
    types[k] = { mode: isMode(t.mode) ? t.mode : null, tau: typeof t.tau === 'number' && t.tau >= LOOP_TYPE_INFO[k].tauDefault && t.tau <= 1 ? t.tau : null };
  }
  const p = obj(o.paused);
  return {
    mode: o.mode, types,
    paused: p && typeof p.at === 'string' && typeof p.by === 'string' ? { at: p.at, by: p.by } : null,
    seededFrom: o.seededFrom === 'LOOP_MODE' ? 'LOOP_MODE' : 'default',
  };
}

/** The stored settings; on first read, seeded from LOOP_MODE (null: LOOP_DEFAULT_MODE) and stored. */
export async function readLoopSettings(cursors: Cursors, c: Partial<Pick<LoopConfig, 'mode'>>): Promise<LoopSettings> {
  const stored = parseLoopSettings(await cursors.getCursor(LOOP_SETTINGS_CURSOR));
  if (stored) return stored;
  const seeded = seedLoopSettings(c);
  await writeLoopSettings(cursors, seeded);
  return seeded;
}

export const writeLoopSettings = (cursors: Cursors, s: LoopSettings) => cursors.setCursor(LOOP_SETTINGS_CURSOR, JSON.stringify(s));

/** A type's τ: its default, or the owner's higher one. */
export const typeTau = (type: DecisionType, s: LoopSettings) => Math.max(LOOP_TYPE_INFO[type].tauDefault, s.types[type]?.tau ?? 0);

export type LoopCap = 'tokenless' | 'disabled' | 'paused' | null;
/**
 * tokenless: no API_TOKEN and no FG_OWNER_TOKEN, so owner actions are read-only: an owner who cannot approve or roll
 * back gets observe at most.
 */
export type LoopRuntime = { tokenless: boolean };

/** What runs after LOOP_DISABLED, a pause and the tokenless cap; capped says which one lowered the mode. */
export function effectiveLoopMode(s: LoopSettings, c: LoopModeConfig, r: LoopRuntime): { mode: LoopMode; capped: LoopCap } {
  if (c.disabled) return { mode: 'off', capped: 'disabled' };
  if (s.paused) return { mode: 'off', capped: 'paused' };
  if (r.tokenless && rank(s.mode) > rank('observe')) return { mode: 'observe', capped: 'tokenless' };
  return { mode: s.mode, capped: null };
}

/**
 * One type's mode: its override (else the global mode) under the same caps; off when LOOP_TYPES leaves it out; a
 * tripped breaker caps it at propose, and tier P never applies on its own.
 */
export function effectiveTypeMode(type: DecisionType, s: LoopSettings, c: LoopModeConfig, r: LoopRuntime & { breaker?: LoopBreaker | null }): LoopMode {
  const global = effectiveLoopMode(s, c, r);
  if (global.capped === 'disabled' || global.capped === 'paused' || (c.types && !c.types.includes(type))) return 'off';
  let m = s.types[type]?.mode ?? s.mode;
  if (r.tokenless) m = atMost(m, 'observe');
  if (r.breaker?.tripped) m = atMost(m, 'propose');
  if (LOOP_TYPE_INFO[type].tier === 'P') m = atMost(m, 'propose');
  return m;
}

// ── Budget ─────────────────────────────────────────────────────────────

export const LOOP_BUDGET_CURSOR = 'loop-budget';
/** The day's spend (UTC day): model calls, and tier A decisions applied on their own, in all and per project. */
export type LoopBudget = { day: string; llmCalls: number; auto: number; autoByProject: Record<string, number> };
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export function parseLoopBudget(raw: string | null, now: number): LoopBudget {
  const day = utcDay(now);
  const o = obj(parse(raw));
  if (!o || o.day !== day) return { day, llmCalls: 0, auto: 0, autoByProject: {} };
  const by = Object.fromEntries(Object.entries(obj(o.autoByProject) ?? {}).map(([k, v]) => [k, count(v)]));
  return { day, llmCalls: count(o.llmCalls), auto: count(o.auto), autoByProject: by };
}
export const readLoopBudget = async (cursors: Cursors, now: number) => parseLoopBudget(await cursors.getCursor(LOOP_BUDGET_CURSOR), now);
export const writeLoopBudget = (cursors: Cursors, b: LoopBudget) => cursors.setCursor(LOOP_BUDGET_CURSOR, JSON.stringify(b));

// ── Circuit breaker ────────────────────────────────────────────────────

export const LOOP_BREAKER_PREFIX = 'loop-breaker:';
/**
 * Tripped: the type is held at propose until the owner sets its mode again (which resets it). at: when it tripped, or
 * when the owner reset it; the breaker then counts only rollbacks and applies after that, so the rollbacks that tripped
 * it do not trip it again.
 */
export type LoopBreaker = { tripped: boolean; at: string | null; reason: string | null };
export const LOOP_BREAKER_RESET: LoopBreaker = { tripped: false, at: null, reason: null };

export function parseLoopBreaker(raw: string | null): LoopBreaker {
  const o = obj(parse(raw));
  if (!o) return LOOP_BREAKER_RESET;
  return o.tripped === true ? { tripped: true, at: strOrNull(o.at), reason: strOrNull(o.reason) } : { ...LOOP_BREAKER_RESET, at: strOrNull(o.at) };
}
export const readLoopBreaker = async (cursors: Cursors, type: DecisionType) => parseLoopBreaker(await cursors.getCursor(LOOP_BREAKER_PREFIX + type));
export const writeLoopBreaker = (cursors: Cursors, type: DecisionType, b: LoopBreaker) => cursors.setCursor(LOOP_BREAKER_PREFIX + type, JSON.stringify(b));
/** The owner set the type's mode: its breaker no longer holds it, and counts afresh from now. */
export const resetLoopBreaker = (cursors: Cursors, type: DecisionType, now = Date.now()) =>
  writeLoopBreaker(cursors, type, { ...LOOP_BREAKER_RESET, at: new Date(now).toISOString() });

// ── Rounds (the live page) ─────────────────────────────────────────────

export const LOOP_ROUND_CURSOR = 'loop-round';
export const LOOP_ROUNDS_CURSOR = 'loop-rounds';
/** Rounds kept for GET /api/loop/events. */
export const LOOP_ROUNDS_KEPT = 50;
export const LOOP_ROUND_PHASES = ['reading', 'scoring', 'writing', 'done', 'aborted'] as const;
export type LoopRoundPhase = (typeof LOOP_ROUND_PHASES)[number];
/** skipped: why candidates made no decision (suppressed, owner_touched, budget, below_floor...), with counts. */
export type LoopRound = {
  id: string; startedAt: string; finishedAt: string | null; phase: LoopRoundPhase;
  signalsIngested: number; targetsScored: number; targetsTotal: number | null;
  decisions: { observed: number; proposed: number; applied: number; skipped: number };
  skipped: { reason: string; count: number }[];
  llmCalls: number; error: string | null;
};
/**
 * The `loop_round` events: each write of a round gets the next seq and moves it to the end, so a reader polling after
 * a seq sees every round that progressed since. seq is the ring's counter (not an Activity cursor).
 */
export type LoopRoundRing = { seq: number; rounds: { seq: number; round: LoopRound }[] };

export function parseLoopRounds(raw: string | null): LoopRoundRing {
  const o = obj(parse(raw));
  if (!o || !Array.isArray(o.rounds)) return { seq: 0, rounds: [] };
  return { seq: count(o.seq), rounds: o.rounds as LoopRoundRing['rounds'] };
}
export const readLoopRounds = async (cursors: Cursors) => parseLoopRounds(await cursors.getCursor(LOOP_ROUNDS_CURSOR));
/** The current round, or the last one; null before the first. */
export const readLoopRound = async (cursors: Cursors) => (obj(parse(await cursors.getCursor(LOOP_ROUND_CURSOR))) as LoopRound | null);

/** Record a round as it now is: the current-round cursor and the ring. Only the worker writes rounds. */
export async function writeLoopRound(cursors: Cursors, round: LoopRound): Promise<number> {
  const ring = await readLoopRounds(cursors);
  const seq = ring.seq + 1;
  const rounds = [...ring.rounds.filter((r) => r.round.id !== round.id), { seq, round }].slice(-LOOP_ROUNDS_KEPT);
  await cursors.setCursor(LOOP_ROUNDS_CURSOR, JSON.stringify({ seq, rounds }));
  await cursors.setCursor(LOOP_ROUND_CURSOR, JSON.stringify(round));
  return seq;
}

// ── Suppression ────────────────────────────────────────────────────────

export const LOOP_SUPPRESS_PREFIX = 'loop-suppress:';
/** How long a rolled-back call is not made again, unless its evidence grows by half. */
export const LOOP_SUPPRESS_DAYS = 30;
export const LOOP_SUPPRESS_GROWTH = 1.5;
/** until: ISO time; evidence: how many evidence pointers the rolled-back decision rested on. */
export type LoopSuppression = { until: string; evidence: number };

/** The call a decision makes, whatever it rests on: its type and its targets' ids. */
export const suppressionKey = (type: DecisionType, targets: Pick<DecisionTarget, 'id'>[]) =>
  `${LOOP_SUPPRESS_PREFIX}${type}|${targets.map((t) => t.id).sort().join('|')}`;

/** After a rollback: the same call is not made again for LOOP_SUPPRESS_DAYS. */
export const suppress = (cursors: Cursors, type: DecisionType, targets: Pick<DecisionTarget, 'id'>[], evidence: number, now: number) =>
  cursors.setCursor(suppressionKey(type, targets), JSON.stringify({ until: new Date(now + LOOP_SUPPRESS_DAYS * 86_400_000).toISOString(), evidence } satisfies LoopSuppression));

export function parseSuppression(raw: string | null): LoopSuppression | null {
  const o = obj(parse(raw));
  return o && typeof o.until === 'string' ? { until: o.until, evidence: count(o.evidence) } : null;
}

/** Whether a call with this much evidence is still suppressed. */
export const isSuppressed = (s: LoopSuppression | null, evidence: number, now: number) =>
  !!s && Date.parse(s.until) > now && evidence < s.evidence * LOOP_SUPPRESS_GROWTH;
