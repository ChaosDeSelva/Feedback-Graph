import { FACT_RANK_FLOOR, pathAffinity, SIMILARITY_FLOOR, thresholdsSnapshot, TUNE_MARGIN, type Activity, type Decision, type ProjectThresholds } from '@fb/core';
import { holdsStill, primaryOf, SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';

/** context_served entries replayed per project, newest first. */
export const REPLAY_ENTRIES = 300;
/** Entries younger than this are left out: their session may still be editing. */
const SETTLE_MS = 86_400_000;
/** Entries older than this are left out: the code and its facts have moved on. */
const WINDOW_MS = 30 * 86_400_000;
/** The replay needs this many labelled facts from this many sessions before a floor moves. */
export const REPLAY_FACTS_MIN = 30;
export const REPLAY_SESSIONS_MIN = 10;
/** And at least this many facts between the old floor and the new one: the change rests on them. */
export const BAND_MIN = 5;
/** Floors are tried in steps of this, within TUNE_MARGIN of the default. */
const STEP = 0.01;
/** Sessions named as evidence (the rest are counted in features). */
const EVIDENCE_SESSIONS = 20;

type Floors = { similarity: number; factRank: number };
/** One fact as a replayed get_task_context saw it, and whether its session went on to edit near it. */
export type ReplayFact = { score: number; rankingScore: number; relevant: boolean };
type ServedFact = { id?: unknown; path?: unknown; score?: unknown; rankingScore?: unknown };
type ServedDetails = { facts?: ServedFact[]; factsBelow?: ServedFact[]; floors?: Partial<Floors> };

const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The project's floors as served now: its own, else the defaults. */
const effective = (t: ProjectThresholds): Floors => ({ similarity: t.similarityFloor ?? SIMILARITY_FLOOR, factRank: t.factRankFloor ?? FACT_RANK_FLOOR });

/**
 * A fact is relevant to a session that edited files in its folder or its service (pathAffinity above 1). A
 * project-wide fact (no folder) says nothing either way and is left out.
 */
export function factLabel(path: string, edited: string[]): boolean | null {
  if (!path || path === '.' || !path.includes('/')) return null;
  return pathAffinity(path, edited) > 1;
}

/**
 * The value of a floor at `v` against the replay: each fact it keeps counts 1 - p0 when relevant and -p0 when not,
 * where p0 is the precision at the current floor. So the current floor scores 0, and a floor scores above 0 exactly
 * when the facts it adds are more precise than what is served now, or the facts it drops less precise.
 */
export function floorGain(facts: ReplayFact[], key: 'score' | 'rankingScore', v: number, p0: number): number {
  return facts.filter((f) => f[key] >= v).reduce((g, f) => g + (f.relevant ? 1 - p0 : -p0), 0);
}

/** The precision of the facts both floors keep; 0 when they keep none. */
export const precisionAt = (facts: ReplayFact[], key: 'score' | 'rankingScore', v: number, other: { key: 'score' | 'rankingScore'; v: number }) => {
  const kept = facts.filter((f) => f[key] >= v && f[other.key] >= other.v);
  return kept.length ? kept.filter((f) => f.relevant).length / kept.length : 0;
};

/**
 * The best floor for one of the two (`key`) over `facts` (those the other floor keeps): the value within TUNE_MARGIN of
 * `base` (the default) with the highest floorGain, if it gains and BAND_MIN facts lie between it and `cur`; else `cur`
 * (gain 0).
 */
export function bestFloor(facts: ReplayFact[], key: 'score' | 'rankingScore', base: number, cur: number): { floor: number; gain: number } {
  const kept = facts.filter((f) => f[key] >= cur);
  const p0 = kept.length ? kept.filter((f) => f.relevant).length / kept.length : 0;
  let best = { floor: cur, gain: 0 };
  const steps = Math.round(TUNE_MARGIN / STEP);
  // Nearest the current floor first, so of equal gains the smallest move wins.
  const values = Array.from({ length: 2 * steps + 1 }, (_, i) => round2(base + (i - steps) * STEP)).sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b);
  for (const v of values) {
    const band = facts.filter((f) => f[key] >= Math.min(v, cur) && f[key] < Math.max(v, cur)).length;
    const gain = round3(floorGain(facts, key, v, p0));
    if (band >= BAND_MIN && gain > best.gain) best = { floor: v, gain };
  }
  return best;
}

/**
 * The replay of one project's context_served entries: each fact served, or just under the floors (factsBelow), served
 * under the floors the project has now, labelled by the files its session edited. Sessions with no edited file, and
 * entries from before scores were recorded or under other floors, are left out.
 */
async function replay(ctx: LoopTypeContext, projectKey: string, cur: Floors): Promise<{ facts: ReplayFact[]; sessions: string[]; entries: number }> {
  const entries = await ctx.store.activity.list({ projectKey, kind: 'context_served', limit: REPLAY_ENTRIES, unlabelled: true, noSandbox: true });
  const facts: ReplayFact[] = [];
  const sessions = new Set<string>();
  let used = 0;
  for (const e of entries) {
    const age = ctx.now - Date.parse(e.ts);
    const d = e.details as ServedDetails;
    const session = e.targets.find((t) => !/^(lesson|miss|fact|doc):/.test(t));
    if (age < SETTLE_MS || age > WINDOW_MS || !session || d.floors?.similarity !== cur.similarity || d.floors?.factRank !== cur.factRank) continue;
    const edited = (await ctx.store.codegraph.sessionFiles(session)).filter((f) => f.edited).map((f) => f.path);
    if (!edited.length) continue;
    let any = false;
    // A fact served is counted as served (a named file's own one, which has no score, not at all), never also as one a
    // lower floor would add: entries recorded before factsBelow left served facts out still list them there.
    const served = new Set((d.facts ?? []).map((f) => f.id).filter((id): id is string => typeof id === 'string'));
    for (const f of [...(d.facts ?? []), ...(d.factsBelow ?? []).filter((f) => typeof f.id !== 'string' || !served.has(f.id))]) {
      const relevant = typeof f.path === 'string' ? factLabel(f.path, edited) : null;
      if (relevant === null || !num(f.score) || !num(f.rankingScore)) continue;
      facts.push({ score: f.score, rankingScore: f.rankingScore, relevant });
      any = true;
    }
    if (any) { sessions.add(session); used++; }
  }
  return { facts, sessions: [...sessions].sort(), entries: used };
}

/** The projects the round's get_task_context calls served context in. */
const servedProjects = (entries: readonly Activity[]) =>
  [...new Set(entries.filter((e) => e.kind === 'context_served' && e.projectKey).map((e) => e.projectKey!))].sort();

/**
 * tune_threshold (tier P, always the owner's call): a project's own SIMILARITY_FLOOR and FACT_RANK_FLOOR, each within
 * TUNE_MARGIN of the default, from a replay of the facts its get_task_context calls served (or would have served just
 * under the floors) against the files their sessions then edited. A floor moves only where the facts it adds or drops
 * are measurably more or less precise than what is served now (floorGain).
 */
export const tuneThreshold: LoopType = {
  type: 'tune_threshold',
  weights: { bias: -1, facts: 1, sessions: 1, gain: 2 },
  groups: { evidence: ['facts', 'sessions', 'gain'], scope: ['shift'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const projects = servedProjects(ctx.entries);
    for (const key of projects) {
      if (!ctx.inScope(key)) { skip(skipped, SKIP.outOfScope); continue; }
      const open = (await ctx.store.decisions.forTarget(key)).some((x) => x.type === 'tune_threshold' && ['observed', 'proposed', 'applying'].includes(x.status));
      if (open) { skip(skipped, SKIP.alreadyDecided); continue; }
      const c = await thresholdCandidate(ctx, key, await ctx.store.facts.projectThresholds(key));
      if (c) candidates.push(c);
      else skip(skipped, SKIP.belowFloor);
    }
    return { candidates, scanned: projects.length, skipped };
  },

  /** Found only for projects served in a round: an observed move is replayed again as the project's floors are now. */
  async recheck(ctx: LoopTypeContext, observed: readonly Decision[]): Promise<(LoopCandidate | string)[]> {
    const out: (LoopCandidate | string)[] = [];
    for (const d of observed) {
      const key = primaryOf(d);
      out.push(ctx.inScope(key) ? holdsStill(await thresholdCandidate(ctx, key, await ctx.store.facts.projectThresholds(key))) : SKIP.outOfScope);
    }
    return out;
  },
};

/** The call for one project, or null: too little replay, or neither floor gains. */
export async function thresholdCandidate(ctx: LoopTypeContext, projectKey: string, own: ProjectThresholds): Promise<LoopCandidate | null> {
  const cur = effective(own);
  const r = await replay(ctx, projectKey, cur);
  if (r.facts.length < REPLAY_FACTS_MIN || r.sessions.length < REPLAY_SESSIONS_MIN) return null;
  const sim = bestFloor(r.facts.filter((f) => f.rankingScore >= cur.factRank), 'score', SIMILARITY_FLOOR, cur.similarity);
  const rank = bestFloor(r.facts.filter((f) => f.score >= cur.similarity), 'rankingScore', FACT_RANK_FLOOR, cur.factRank);
  const similarity = sim.floor;
  const factRank = rank.floor;
  if (similarity === cur.similarity && factRank === cur.factRank) return null;
  const next: ProjectThresholds = { similarityFloor: similarity === SIMILARITY_FLOOR ? null : similarity, factRankFloor: factRank === FACT_RANK_FLOOR ? null : factRank };
  const p = (s: number, f: number) => precisionAt(r.facts, 'score', s, { key: 'rankingScore', v: f });
  const before = p(cur.similarity, cur.factRank);
  const after = p(similarity, factRank);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const moves = [
    ...(similarity !== cur.similarity ? [`similarity floor ${cur.similarity} -> ${similarity}`] : []),
    ...(factRank !== cur.factRank ? [`fact rank floor ${cur.factRank} -> ${factRank}`] : []),
  ];
  return {
    projectKey,
    targets: [{ kind: 'project', id: projectKey, role: 'primary' }],
    before: [thresholdsSnapshot(projectKey, own)],
    after: [thresholdsSnapshot(projectKey, next)],
    // The sessions the replay rests on, under the move they support: another move on the same sessions is another call.
    evidence: r.sessions.slice(0, EVIDENCE_SESSIONS).map((s) => ({ kind: 'session' as const, id: s, role: `replayed for ${moves.join(', ')}`, weight: round3(1 / r.sessions.length), observedAt: new Date(ctx.now).toISOString() })),
    features: {
      facts: Math.min(r.facts.length, 200) / 200,
      sessions: Math.min(r.sessions.length, 50) / 50,
      gain: round3(Math.min(1, ((sim.gain + rank.gain) / r.facts.length) * 10)),
      shift: round3((Math.abs(similarity - SIMILARITY_FLOOR) + Math.abs(factRank - FACT_RANK_FLOOR)) / (2 * TUNE_MARGIN)),
      precisionBefore: round3(before),
      precisionAfter: round3(after),
    },
    subject: `${projectKey}: ${moves.join(', ')}`,
    rationale: `Replayed ${r.facts.length} facts from ${r.entries} get_task_context calls in ${r.sessions.length} sessions of ${projectKey} against the files each session then edited: ${moves.join(' and ')} moves the precision of what is served from ${pct(before)} to ${pct(after)}. A fact counts as relevant when its session edited a file in its folder or service; project-wide facts are left out. This changes what every agent in ${projectKey} is given, so it waits for you.`,
  };
}
