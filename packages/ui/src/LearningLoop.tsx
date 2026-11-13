import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, isOutage, LOOP_MODES, loopApi, type Decision, type HoldoutArm, type LoopEvent, type LoopMetrics, type LoopMode, type LoopState, type LoopTypeState, type Rate, type TrackRecord } from './api.ts';
import { DecisionBadges } from './Decisions.tsx';
import { confidenceLine, decisionTitle, eventLabel, eventTone, knownMode, modeHint, modeLabel, modeShort, p2, rate, tierLabel, trackLabel, trackTone, typeLabel } from './loop.ts';
import { READ_ONLY_TITLE, useOwnerWrites } from './ownerAccess.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { Button, Input, Select } from './ui/controls.tsx';
import { Alert, Badge, Card, Chip, EmptyState, longTime, plural, SkeletonList, StatGrid, StatTile, tableClass, tdClass, thClass, Time } from './ui/display.tsx';
import { ScrollArea } from './ui/ScrollArea.tsx';

/** Every request fails with an Error (api.ts): the API's own words, or that it did not answer. */
const message = (e: unknown) => (e as Error).message;
// The headers are upper case: α and β would read as Latin A and B, so they keep their case.
const BAND_HEAD: ReactNode[] = ['band', 'p', 'lower', <span className="normal-case">α</span>, <span className="normal-case">β</span>, 'n'];
/** Events kept on the page; older ones are in Activity and the audit log. */
const MAX_EVENTS = 200;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const linkClass = 'text-xs font-medium text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent';

/** Why the loop runs below its mode, in words; null when it runs as set. */
export function cappedLine(s: LoopState): string | null {
  if (s.disabled) return 'LOOP_DISABLED is set in .env: nothing runs, and this page cannot turn it back on.';
  if (s.paused) return `Paused by ${s.paused.by} ${longTime(s.paused.at)}: nothing is applied until you resume.`;
  if (s.capped === 'tokenless') return 'This install has no owner token, so the loop only observes: auto-apply needs an owner who can roll back.';
  return null;
}

/** Pause or resume: the worker checks before every apply, so it takes effect at once. */
export function PauseButton({ state, onChange, onError }: { state: LoopState; onChange: (s: LoopState) => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      onChange(await (state.paused ? loopApi.resume() : loopApi.pause()));
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant={state.paused ? 'primary' : 'danger-outline'} owner disabled={busy || state.disabled} title={state.disabled ? 'LOOP_DISABLED is set in .env' : undefined} onClick={() => void toggle()}>
      {state.paused ? 'Resume learning' : 'Pause learning'}
    </Button>
  );
}

/** The global mode, saved as you pick it. */
function ModeSelect({ state, onChange, onError }: { state: LoopState; onChange: (s: LoopState) => void; onError: (e: string) => void }) {
  const writes = useOwnerWrites();
  return (
    <Select
      aria-label="loop mode"
      size="sm"
      value={state.mode}
      disabled={!writes || state.disabled}
      title={!writes ? READ_ONLY_TITLE : modeHint(state.mode)}
      onChange={(e) => { loopApi.saveSettings({ mode: e.target.value as LoopMode }).then(onChange, (err) => onError(message(err))); }}
    >
      {!knownMode(state.mode) && <option value={state.mode} disabled>mode: {modeLabel(state.mode)}</option>}
      {LOOP_MODES.map((m) => <option key={m} value={m}>mode: {m}</option>)}
    </Select>
  );
}

/**
 * Earned confidence per type against its bar: the solid bar is the lower bound the loop must clear, the lighter one
 * runs to the estimate, and the tick is τ. The numbers are in the label and in the table above.
 */
function Calibration({ types }: { types: LoopTypeState[] }) {
  return (
    <ul className="grid gap-3 p-3">
      {types.map((t) => {
        const cleared = t.calibration.lower >= t.tau;
        return (
          <li key={t.type} className="grid gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
              <span className="font-medium">{typeLabel(t.type)}</span>
              <span className="text-muted tabular-nums">p {p2(t.calibration.p)} · lower {p2(t.calibration.lower)} · τ {p2(t.tau)} · n {t.calibration.n}</span>
            </div>
            <div
              role="img"
              aria-label={`${typeLabel(t.type)}: ${confidenceLine(t.calibration)}; bar τ ${p2(t.tau)}, ${cleared ? 'cleared' : 'not cleared'}`}
              className="relative h-3 rounded-sm bg-sunken ring-1 ring-line ring-inset"
            >
              <span className="absolute inset-y-0 left-0 rounded-sm bg-info/35" style={{ width: pct(t.calibration.p) }} />
              <span className={`absolute inset-y-0 left-0 rounded-sm ${cleared ? 'bg-ok' : 'bg-info'}`} style={{ width: pct(t.calibration.lower) }} />
              <span className="absolute -inset-y-1 w-0.5 bg-text" style={{ left: `calc(${pct(t.tau)} - 1px)` }} />
            </div>
            {t.bands.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">By confidence band</summary>
                <ScrollArea role="region" aria-label={`${typeLabel(t.type)} bands`} className="mt-1 overflow-x-auto">
                  <table className={`${tableClass} tabular-nums`}>
                    <thead><tr>{BAND_HEAD.map((h, i) => <th key={i} className={thClass}>{h}</th>)}</tr></thead>
                    <tbody>
                      {t.bands.map((b) => (
                        <tr key={b.band}>{[`${b.band + 1} of 5`, p2(b.p), p2(b.lower), b.alpha, b.beta, b.n].map((c, i) => <td key={i} className={`${tdClass} whitespace-nowrap`}>{c}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Each decision type's mode, bar and record; `controls` puts editors in the mode and bar cells (Settings). */
export function TypeTable({ types, controls }: { types: LoopTypeState[]; controls?: { mode: (t: LoopTypeState) => ReactNode; tau: (t: LoopTypeState) => ReactNode } }) {
  // The headers are upper case: τ would read as a Latin T, so it keeps its case.
  const head: ReactNode[] = ['type', 'tier', 'mode', <>bar <span className="normal-case">τ</span></>, 'earned p (lower)', 'your reviews', 'rollbacks', 'breaker'];
  // Cells keep to one line: on a narrow screen the table scrolls sideways rather than stacking words.
  const td = `${tdClass} whitespace-nowrap`;
  return (
    <ScrollArea role="region" aria-label="decision types table" className="overflow-x-auto">
      <table className={`${tableClass} tabular-nums`}>
        <thead><tr>{head.map((h, i) => <th key={i} className={`${thClass} whitespace-nowrap`}>{h}</th>)}</tr></thead>
        <tbody>
          {types.map((t) => (
            <tr key={t.type}>
              <td className={`${td} font-medium`}>{typeLabel(t.type)}</td>
              <td className={td}><span title={`tier ${t.tier}`}>{tierLabel(t.tier)}</span></td>
              <td className={td}>{controls ? controls.mode(t) : <>{modeLabel(t.effectiveMode)}{t.mode === null && <span className="text-muted"> (global)</span>}</>}</td>
              <td className={td}>
                {controls ? controls.tau(t) : p2(t.tau)}
                {t.tau > t.tauDefault && <span className="block text-[11px] text-muted">raised from {p2(t.tauDefault)}</span>}
              </td>
              <td className={td}>{p2(t.calibration.p)} <span className="text-muted">({p2(t.calibration.lower)})</span></td>
              <td className={td}>{t.calibration.n}</td>
              <td className={td}>{rate(t.rollbackRate.rolledBack, t.rollbackRate.of)}</td>
              <td className={td}>
                {t.breaker.tripped
                  ? <Badge tone="bad" title={t.breaker.reason ?? undefined}>tripped{t.breaker.at && <> {new Date(t.breaker.at).toLocaleDateString()}</>}</Badge>
                  : <span className="text-muted">ok</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function Round({ state }: { state: LoopState }) {
  const r = state.round;
  if (!r) return <p className="p-3 text-muted">The worker has not run a round yet.</p>;
  const running = !r.finishedAt;
  const counts: [string, number][] = [
    ['signals read', r.signalsIngested], ['targets scored', r.targetsScored], ['observed', r.decisions.observed], ['proposed', r.decisions.proposed],
    ['applied', r.decisions.applied], ['skipped', r.decisions.skipped], ['model calls', r.llmCalls],
  ];
  return (
    <div className="grid gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone={r.phase === 'aborted' ? 'bad' : running ? 'info' : 'ok'} dot>{r.phase}</Badge>
        <span>started <Time iso={r.startedAt} /></span>
        {r.finishedAt && <span>finished <Time iso={r.finishedAt} /></span>}
        <Chip>{r.id}</Chip>
      </div>
      {running && r.targetsTotal !== null && (
        <div role="progressbar" aria-label="targets scored" aria-valuemin={0} aria-valuemax={r.targetsTotal} aria-valuenow={r.targetsScored} className="h-2 overflow-hidden rounded-sm bg-sunken ring-1 ring-line ring-inset">
          <div className="h-full bg-info" style={{ width: pct(r.targetsTotal ? r.targetsScored / r.targetsTotal : 1) }} />
        </div>
      )}
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-4 gap-y-2">
        {counts.map(([k, v]) => <div key={k} className="flex flex-col-reverse"><dt className="text-xs text-muted">{k}</dt><dd className="text-[15px] leading-tight font-semibold tabular-nums">{v}</dd></div>)}
      </dl>
      {r.skipped.length > 0 && (
        <div className="text-xs">
          <span className="text-muted">Skipped because: </span>
          {r.skipped.map((s) => `${s.reason.replace(/_/g, ' ')} (${s.count})`).join(', ')}
        </div>
      )}
      {r.error && <Alert>The round stopped: {r.error}</Alert>}
    </div>
  );
}

type Conn = { state: 'connecting' } | { state: 'live' } | { state: 'down'; error: string; since: string };

function Connection({ conn }: { conn: Conn }) {
  if (conn.state === 'live') return <Badge tone="ok" dot>live</Badge>;
  if (conn.state === 'connecting') return <Badge dot>connecting…</Badge>;
  return <Badge tone="bad" dot title={conn.error}>reconnecting</Badge>;
}

const ROUND_RUNNING = /^round (reading|scoring|writing)\b/;
/**
 * The worker runs one round at a time and the API streams each of its states as a new event: a round still running is
 * superseded by any later round event (its own end, or the next round), so the page keeps one row per round, as a
 * fresh load shows. `events` newest first.
 */
export function settledRounds(events: LoopEvent[]): LoopEvent[] {
  let later = false;
  return events.filter((e) => {
    if (e.kind !== 'loop_round') return true;
    const stale = later && ROUND_RUNNING.test(e.subject);
    later = true;
    return !stale;
  });
}

const eventSubject = 'order-last min-w-0 basis-full truncate @md:order-none @md:basis-0 @md:flex-1';

function EventRow({ e }: { e: LoopEvent }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2 text-[13px] last:border-b-0">
      <Time iso={e.ts} className="w-16 shrink-0 text-xs text-muted" />
      <Badge tone={eventTone(e.kind)}>{eventLabel(e.kind)}</Badge>
      {/* Narrower than 28rem the subject gets a line of its own, so it is not cut to a few words. */}
      {e.decisionId
        ? <a href={`#decisions/${encodeURIComponent(e.decisionId)}`} className={`${eventSubject} underline decoration-line-strong underline-offset-2 hover:text-text`} title={e.subject}>{e.subject}</a>
        : <span className={eventSubject} title={e.subject}>{e.subject}</span>}
      <Chip className="ml-auto max-w-[40%] @md:ml-0">{e.actor}</Chip>
    </li>
  );
}

function HoldoutRow({ label, arm }: { label: string; arm: HoldoutArm }) {
  return (
    <tr>
      <th scope="row" className={`${tdClass} text-left font-medium whitespace-nowrap`}>{label}</th>
      {[arm.lessons, pct(arm.repeatRate), pct(arm.helpfulRate), `${pct(arm.ciLow)}–${pct(arm.ciHigh)}`].map((c, i) => <td key={i} className={`${tdClass} whitespace-nowrap`}>{c}</td>)}
    </tr>
  );
}

function Holdout({ state }: { state: LoopState }) {
  const h = state.holdout;
  if (!h) return <p className="p-3 text-muted">No comparison yet: it needs lessons served on both sides of the holdout (LOOP_HOLDOUT).</p>;
  return (
    <div>
      <p className="px-3 py-2 text-xs text-muted">{pct(h.share)} of eligible lessons are left untouched by the loop, chosen by a fixed hash. The sample is small, so read the intervals, not the point estimates.</p>
      <ScrollArea role="region" aria-label="holdout comparison table" className="overflow-x-auto">
        <table className={`${tableClass} tabular-nums`}>
          <thead><tr>{['group', 'lessons', 'repeat rate', 'helpful', 'helpful 95% interval'].map((x) => <th key={x} className={`${thClass} whitespace-nowrap`}>{x}</th>)}</tr></thead>
          <tbody>
            <HoldoutRow label="may be changed by the loop" arm={h.treated} />
            <HoldoutRow label="held out" arm={h.control} />
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

/** Why the loop believes what it believes about one lesson: served → judged → gap fixed → repeat. */
function Track({ lessonId }: { lessonId: string }) {
  const [t, setT] = useState<TrackRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setT(null);
    setError(null);
    let stale = false;
    loopApi.track(lessonId).then((x) => { if (!stale) setT(x); }, (e) => { if (!stale) setError(message(e)); });
    return () => { stale = true; };
  }, [lessonId]);
  if (error) return <Alert>{error}</Alert>;
  if (!t) return <SkeletonList rows={2} />;
  const s = t.signals;
  const judged = s.addressed + s.notAddressed + s.notApplicable + s.cannotTell;
  const steps: [string, number, string][] = [
    ['served', s.served, `in ${plural(s.sessions, 'session')}`],
    ['judged', judged, `${s.addressed} addressed, ${s.notAddressed} gaps caught, ${s.notApplicable} not applicable, ${s.cannotTell} cannot tell`],
    ['gap fixed', s.gapsFixed, 'a gap caught, then addressed in the same session'],
    ['repeat', s.repeatServed + s.repeatUnserved, `${s.repeatServed} while served, ${s.repeatUnserved} while not served`],
  ];
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href={`#lessons/${encodeURIComponent(t.lessonId)}`} className="min-w-0 font-semibold underline decoration-line-strong underline-offset-2 [overflow-wrap:anywhere]">{t.title}</a>
        <Badge>{t.projectKey ?? 'global'}</Badge>
        {s.holdout && <Badge tone="violet" title="the loop never changes it: it is in the comparison group">held out</Badge>}
      </div>
      <ol aria-label="track record" className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4">
        {steps.map(([k, v, hint]) => (
          <li key={k} className="bg-surface px-3 py-2">
            <div className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{k}</div>
            <div className="text-xl font-semibold tabular-nums">{v}</div>
            <div className="text-xs text-muted">{hint}</div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">
        After serving: you pushed back {s.ownerPushbackAfter} times · your edits {s.ownerEdits} · your rejections {s.ownerRejects}
        {s.lastServed && <> · last served <Time iso={s.lastServed} /></>}
      </p>
      {t.timeline.length > 0 && (
        <ul className="grid gap-1">
          {t.timeline.map((x, i) => (
            <li key={i} className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]">
              <Time iso={x.ts} className="w-16 shrink-0 text-xs text-muted" />
              <Badge tone={trackTone(x.kind)}>{trackLabel(x.kind)}</Badge>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{x.label}</span>
              {x.sessionId && <a href={`#sessions/${encodeURIComponent(x.sessionId)}`} className={linkClass}>session</a>}
              {x.decisionId && <a href={`#decisions/${encodeURIComponent(x.decisionId)}`} className={linkClass}>decision</a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The lesson a decision is about, if it is about one. */
const lessonOf = (d: Decision) => d.targets.find((t) => t.kind === 'lesson')?.id ?? null;

/**
 * Watching the loop work: its mode and state per type, the round it is on, events as they happen, its recent decisions,
 * how well its confidence has matched your verdicts, and why it believes what it does about a lesson.
 * `pollMs`: how often to ask for new events; the state reloads when they arrive and every `statePollMs`.
 */
export function LearningLoop({ pollMs = 3000, statePollMs = 15_000 }: { pollMs?: number; statePollMs?: number } = {}) {
  const [state, setState] = useState<LoopState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [conn, setConn] = useState<Conn>({ state: 'connecting' });
  const [gap, setGap] = useState(false);
  const [recent, setRecent] = useState<Decision[] | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [trackDraft, setTrackDraft] = useState('');

  const reload = useRef(() => {});
  reload.current = () => {
    loopApi.state().then((s) => { setState(s); setStateError(null); }, (e) => setStateError(message(e)));
    loopApi.decisions({ status: undefined, limit: 20 }).then((p) => setRecent(p.items), () => {});
  };
  useEffect(() => {
    reload.current();
    const t = setInterval(() => reload.current(), statePollMs);
    return () => clearInterval(t);
  }, [statePollMs]);

  // The event stream: a cursor survives an outage, so nothing is lost when the API answers again; a cursor the server
  // no longer holds comes back as a gap, said on the page.
  useEffect(() => {
    let live = true;
    let cursor: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const page = await loopApi.events(cursor);
        if (!live) return;
        const first = cursor === undefined;
        if (page.gap && !first) setGap(true);
        const fresh = [...page.events].reverse();
        setEvents((xs) => settledRounds(first ? fresh : [...fresh, ...xs]).slice(0, MAX_EVENTS));
        if (!first && (page.events.length || page.gap)) reload.current();
        cursor = page.next;
        setConn({ state: 'live' });
      } catch (e) {
        if (!live) return;
        setConn((c) => ({ state: 'down', error: isOutage(e) ? 'The API is not answering (it may be restarting); retrying.' : message(e), since: c.state === 'down' ? c.since : new Date().toISOString() }));
      }
      if (live) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
  }, [pollMs]);

  function showTrack(e: FormEvent) {
    e.preventDefault();
    if (trackDraft.trim()) setTrack(trackDraft.trim());
  }

  const capped = state && cappedLine(state);
  // Without a state the cards that need it say so, rather than showing a skeleton that never resolves.
  const pending = (rows: number) => (stateError ? <p className="p-3 text-xs text-muted">Not loaded: see the error above.</p> : <SkeletonList rows={rows} />);
  const withLessons = recent?.filter((d) => lessonOf(d)) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Learning loop"
        description="The loop at work: what it is doing now, what it decided, and how far its confidence is earned."
        actions={state && (
          <>
            <ModeSelect state={state} onChange={setState} onError={setError} />
            <PauseButton state={state} onChange={setState} onError={setError} />
          </>
        )}
      />
      <ScrollArea className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 md:p-5">
          {error && <Alert>{error}</Alert>}
          {stateError && <Alert>{state ? `Could not refresh the loop's state (showing the last one): ${stateError}` : `Could not load the loop's state: ${stateError}`}</Alert>}
          {capped && <p role="status" className="rounded-md border border-accent-edge/50 bg-accent-soft px-3 py-2 text-accent-text">{capped}</p>}
          <h2 className="sr-only">Where the loop stands</h2>
          {state && (
            <StatGrid className="grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 [&>:last-child]:col-span-2 xl:[&>:last-child]:col-span-1">
              <StatTile label="Running as" value={state.effectiveMode} hint={modeShort(state.effectiveMode)} />
              <StatTile label="Waiting for you" value={<a href="#decisions" className="underline decoration-line-strong underline-offset-4">{state.counts.proposed}</a>} hint="proposals in Decisions" />
              <StatTile label="Applied this week" value={state.counts.week.applied} hint={`${state.counts.week.proposed} proposed, ${state.counts.week.observed} observed`} />
              <StatTile label="Rolled back" value={state.rollbackRate.of ? pct(state.rollbackRate.rolledBack / state.rollbackRate.of) : '–'} hint={rate(state.rollbackRate.rolledBack, state.rollbackRate.of)} />
              <StatTile label="Model budget today" value={`${state.budget.llmCallsToday}/${state.budget.llmCallsPerDay}`} hint={`auto-applied ${state.budget.autoToday}/${state.budget.autoPerDay}`} />
            </StatGrid>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={state?.round && !state.round.finishedAt ? 'This round' : 'Last round'}>
              {state ? <Round state={state} /> : pending(2)}
            </Card>
            <Card title="Live" actions={<Connection conn={conn} />}>
              {conn.state === 'down' && (
                <p role="status" className="border-b border-line bg-bad-soft px-3 py-1.5 text-xs text-bad-text">
                  {conn.error} Events since {longTime(conn.since)} will show when it answers.
                </p>
              )}
              {gap && (
                <p role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-info-soft px-3 py-1.5 text-xs text-info-text">
                  Some events were missed while this page was away; the totals above are current, and Activity has every entry.
                  <Button size="sm" variant="ghost" onClick={() => setGap(false)}>Dismiss</Button>
                </p>
              )}
              <ScrollArea role="log" aria-label="loop events" className="max-h-80 overflow-y-auto">
                {events.length ? <ul className="@container">{events.map((e) => <EventRow key={e.seq} e={e} />)}</ul> : <p className="p-3 text-muted">{conn.state === 'live' ? 'Nothing yet. Events appear here as the worker records them.' : 'Waiting for the API…'}</p>}
              </ScrollArea>
            </Card>
          </div>

          <Card title="Decision types" actions={<a href="#settings/loop" className={linkClass}>Settings</a>}>
            {state ? <TypeTable types={state.types} /> : pending(3)}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <Card title="Calibration: confidence earned from your reviews">
              {state ? <Calibration types={state.types} /> : pending(3)}
            </Card>
            <Card title="Recent decisions" actions={<a href="#decisions?status=all" className={linkClass}>Audit log</a>}>
              {recent === null ? <SkeletonList rows={3} /> : recent.length === 0 ? <EmptyState compact title="No decisions yet">The loop has not decided anything. In observe mode it still records what it would have done.</EmptyState> : (
                <ScrollArea as="ul" aria-label="recent decisions" className="max-h-[27rem] overflow-y-auto">
                  {recent.map((d) => (
                    <li key={d.id} className="grid gap-1 border-b border-line px-3 py-2 last:border-b-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <DecisionBadges d={d} />
                        <span className="text-xs text-muted tabular-nums">p {p2(d.confidence.p)}</span>
                        <Time iso={d.createdAt} className="ml-auto text-xs text-muted" />
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <a href={`#decisions/${encodeURIComponent(d.id)}`} className="min-w-0 flex-1 truncate text-[13px] underline decoration-line-strong underline-offset-2" title={d.rationale}>{decisionTitle(d)}</a>
                        {lessonOf(d) && <Button size="sm" variant="ghost" onClick={() => { setTrack(lessonOf(d)); setTrackDraft(lessonOf(d)!); }}>Track record</Button>}
                      </div>
                    </li>
                  ))}
                </ScrollArea>
              )}
            </Card>
          </div>

          <Card title="Track record of a lesson" bodyClass="grid gap-3 p-3">
            <form onSubmit={showTrack} className="flex flex-wrap items-center gap-2">
              <Input aria-label="lesson id" list="loop-lessons" placeholder="lesson id" value={trackDraft} onChange={(e) => setTrackDraft(e.target.value)} className="min-w-0 flex-1 font-mono sm:max-w-md" />
              <datalist id="loop-lessons">{[...new Set(withLessons.map((d) => lessonOf(d)!))].map((id) => <option key={id} value={id} />)}</datalist>
              <Button type="submit" size="md" disabled={!trackDraft.trim()}>Show</Button>
            </form>
            {track ? <Track lessonId={track} /> : <p className="text-xs text-muted">Pick a lesson from a recent decision, or type its id.</p>}
          </Card>

          <Card title="Holdout comparison">
            {state ? <Holdout state={state} /> : pending(2)}
          </Card>
          {state && <p className="text-xs text-muted">Policy v{state.policyVersion}. Rollbacks and edits lower the loop's confidence for their type; Keep and approvals raise it.</p>}
        </div>
      </ScrollArea>
    </div>
  );
}

/** The Dashboard's view of the loop: this week's counts, the rollback rate, the budget, and Pause. */
/**
 * `waiting`: the error is an outage the page already says in its own alert, so the card only waits. While the API is
 * down the card asks again every `retryMs`, so it recovers on its own.
 */
export function LoopCard({ retryMs = 10_000, waiting }: { retryMs?: number; waiting?: (error: string) => boolean } = {}) {
  const [state, setState] = useState<LoopState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [absent, setAbsent] = useState(false);
  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = () => loopApi.state().then(
      (s) => { if (live) { setState(s); setError(null); } },
      (e) => {
        if (!live) return;
        // An API without the loop answers 404: no card rather than an error about a feature it does not have.
        if (e instanceof ApiError && e.status === 404) return setAbsent(true);
        setError(message(e));
        if (isOutage(e)) retry = setTimeout(run, retryMs);
      },
    );
    run();
    return () => { live = false; clearTimeout(retry); };
  }, []);
  if (absent) return null;
  return (
    <Card title="Learning loop" actions={<><a href="#loop" className={linkClass}>Watch it</a>{state && <PauseButton state={state} onChange={setState} onError={setError} />}</>}>
      {error && (waiting?.(error)
        ? <p className="p-3 text-[13px] text-muted">Not loaded yet: shown when the API answers.</p>
        : <div className="p-3"><Alert>{error}</Alert></div>)}
      {!state && !error && <SkeletonList rows={2} />}
      {state && (
        <div className="grid gap-2 p-3 text-[13px]">
          <p>
            Running as <b>{modeLabel(state.effectiveMode)}</b>{state.effectiveMode !== state.mode && <> (set to {modeLabel(state.mode)})</>}. This week:{' '}
            {state.counts.week.applied} applied, {state.counts.week.proposed} proposed (<a href="#decisions" className="underline underline-offset-2">{state.counts.proposed} waiting</a>), {state.counts.week.rolledBack} rolled back.
          </p>
          <p className="text-xs text-muted">Rolled back {rate(state.rollbackRate.rolledBack, state.rollbackRate.of)} · model calls today {state.budget.llmCallsToday} of {state.budget.llmCallsPerDay}</p>
          {cappedLine(state) && <p className="text-xs text-accent-text">{cappedLine(state)}</p>}
        </div>
      )}
    </Card>
  );
}


/**
 * A rate as a tile shows it: the share, then k of n and the 95% interval, which says more than the share while n is
 * small. The hint is never cut: on a phone's half-width tile the interval wraps whole to a line of its own.
 */
function RateTile({ label, r, of, many = `${of}s` }: { label: string; r: Rate; of: string; many?: string }) {
  return (
    <StatTile
      label={label}
      value={r.n ? pct(r.rate) : '–'}
      hint={r.n ? <>{r.k} of {plural(r.n, of, many)} · <span className="whitespace-nowrap">95% {pct(r.ciLow)}–{pct(r.ciHigh)}</span></> : `no ${many} yet`}
      wrap
    />
  );
}

/** One measure per week as small columns, oldest first; each names its week and value on hover and to screen readers. */
function WeekBars({ label, weeks, tone }: { label: string; weeks: { week: string; value: number; text: string }[]; tone: string }) {
  const max = Math.max(1, ...weeks.map((w) => w.value));
  return (
    <figure className="grid min-w-0 gap-1">
      <figcaption className="text-xs text-muted">{label}</figcaption>
      <ul className="flex h-10 items-end gap-0.5 border-b border-field">
        {weeks.map((w) => (
          <li key={w.week} aria-label={`${w.week}: ${w.text}`} title={`${w.week}: ${w.text}`} className="flex h-full min-w-0 flex-1 flex-col justify-end">
            {/* A quiet week keeps a hairline, so the run of weeks reads as a run. */}
            <span className={`block min-h-px rounded-t-[2px] ${w.value ? tone : 'bg-line'}`} style={{ height: `${(w.value / max) * 100}%` }} />
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Nothing measured yet that the card shows: both its rates have n 0, and no week has a proposal or a rollback. */
const noMetrics = (m: LoopMetrics) =>
  [m.gapsFixedPerServed, m.notApplicableShare].every((r) => r.n === 0) &&
  m.proposalsPerWeek.every((w) => !w.proposals) && m.rollbackRate.every((t) => !t.of);

/**
 * The Dashboard's learning-loop measures (GET /api/loop/metrics): do served lessons get gaps fixed or read as noise, what
 * the loop costs in proposals, and what had to be undone. The repeat rate and the checks that caught a gap are the
 * Quality card's, beside it, so they are not shown twice. Absent on an API without them (404); one quiet line before
 * anything is measured; an outage waits like LoopCard.
 */
export function LoopMetricsCard({ retryMs = 10_000, waiting }: { retryMs?: number; waiting?: (error: string) => boolean } = {}) {
  const [m, setM] = useState<LoopMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [absent, setAbsent] = useState(false);
  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = () => loopApi.metrics().then(
      (x) => { if (live) { setM(x); setError(null); } },
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) return setAbsent(true);
        setError(message(e));
        if (isOutage(e)) retry = setTimeout(run, retryMs);
      },
    );
    run();
    return () => { live = false; clearTimeout(retry); };
  }, []);
  if (absent) return null;
  const rolled = m?.rollbackRate.filter((t) => t.of > 0) ?? [];
  return (
    <Card title="Learning-loop metrics" actions={m && <span className="text-xs text-muted">last {m.weeks} weeks, from {m.since}</span>}>
      {error && (waiting?.(error)
        ? <p className="p-3 text-[13px] text-muted">Not loaded yet: shown when the API answers.</p>
        : <div className="p-3"><Alert>{error}</Alert></div>)}
      {!m && !error && <SkeletonList rows={2} />}
      {m && noMetrics(m) && <p className="p-3 text-[13px] text-muted">Nothing measured yet: these fill in as agents are served lessons, the done-check runs and the loop decides.</p>}
      {m && !noMetrics(m) && (
        <div className="grid gap-3 p-3">
          <StatGrid className="grid-cols-2">
            <RateTile label="Gaps fixed per serving" r={m.gapsFixedPerServed} of="serving" />
            <RateTile label="Not applicable" r={m.notApplicableShare} of="verdict" />
          </StatGrid>
          <WeekBars
            label={`Proposals per week (${m.proposalsPerWeek.reduce((n, w) => n + w.proposals, 0)} in all)`}
            tone="bg-info"
            weeks={m.proposalsPerWeek.map((w) => ({ week: w.week, value: w.proposals, text: plural(w.proposals, 'proposal') }))}
          />
          <div className="text-xs">
            <span className="text-muted">Rolled back, by type: </span>
            {rolled.length
              ? rolled.map((t) => `${typeLabel(t.type)} ${t.rolledBack} of ${t.of} (95% ${pct(t.rate.ciLow)}–${pct(t.rate.ciHigh)})`).join(' · ')
              : 'nothing applied in the window'}
          </div>
        </div>
      )}
    </Card>
  );
}
