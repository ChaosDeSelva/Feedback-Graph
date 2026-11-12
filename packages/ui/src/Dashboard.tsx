import { asIs, labelOf } from './labels.ts';
import { Component, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ModelHealth, ModelJob, WorkQueue, WorkQueues } from '@fb/core';
import type { ChatProvider } from '@fb/core/chat';
import { ActivityEntry } from './Activity.tsx';
import { ProviderSelect } from './Chat.tsx';
import { api, errorMessage, isOutage, type Activity, type PatternReport, type PipelineStatus, type ProjectHotspot, type ProjectSummary, type SystemStatus } from './api.ts';
import { activityKindHref, chatHref, inboxTabHref, moduleHref, newChatHref } from './links.ts';
import { stageLine } from './FirstRun.tsx';
import { GettingStarted } from './GettingStarted.tsx';
import { LoopCard, LoopMetricsCard } from './LearningLoop.tsx';
import { pct, WeeklyChart } from './Patterns.tsx';
import { READ_ONLY_TITLE, useOwnerWrites } from './ownerAccess.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { Button, Select } from './ui/controls.tsx';
import { AskIcon, ChevronIcon, Mark } from './ui/icons.tsx';
import { ago, Alert, Badge, Card, Skeleton, SkeletonList, StatGrid, StatTile, StatTileSkeleton, StatusBadge, tableClass, tdClass, thClass, Time } from './ui/display.tsx';
import { ScrollArea } from './ui/ScrollArea.tsx';
import { InfoTip } from './ui/InfoTip.tsx';

const POLL_MS = 10_000;

/** `outage`: the API did not answer or answered 5xx (see `shared` below). */
type Load<T> = { data: T | null; error: string | null; outage: boolean };

/**
 * One section's data. Each section loads on its own, so an endpoint that refuses (or a store without that route) shows
 * its error in its own card and every other section still renders. `pollMs` reloads it while the page is open; a
 * section that loads once is asked again every `retryMs` while the API is down, so the page recovers on its own.
 */
function useLoad<T>(load: () => Promise<T>, pollMs?: number, retryMs = POLL_MS): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, error: null, outage: false });
  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = () => load().then(
      (data) => { if (live) setState({ data, error: null, outage: false }); },
      (e) => {
        if (!live) return;
        setState((s) => ({ data: s.data, error: errorMessage(e), outage: isOutage(e) }));
        if (!pollMs && isOutage(e)) retry = setTimeout(run, retryMs);
      },
    );
    run();
    const t = pollMs ? setInterval(run, pollMs) : undefined;
    return () => { live = false; clearInterval(t); clearTimeout(retry); };
  }, []);
  return state;
}

/** The landing page: where everything stands, each part linked to the page that has the detail. */
export function Dashboard({ retryMs }: { retryMs?: number } = {}) {
  const status = useLoad(api.status, POLL_MS);
  const pipeline = useLoad(api.pipeline, POLL_MS);
  const patterns = useLoad(() => api.patterns(), undefined, retryMs);
  const projects = useLoad(api.projects, undefined, retryMs);
  const hotspots = useLoad(() => api.topHotspots(undefined, 8), undefined, retryMs);
  const struggles = useLoad(() => api.topHotspots(undefined, 8, false, true), undefined, retryMs);
  const activity = useLoad(() => api.activity({ limit: 10 }), undefined, retryMs);
  // An API that is down fails every section with the same words: the page says it in one alert (keyed by its text, so
  // a poll that fails again does not mount it anew and announce it again), and those sections only wait. A failure only
  // one section has stays in that section.
  const said = [status, pipeline, patterns, projects, hotspots, struggles, activity].filter((l) => l.outage && l.error).map((l) => l.error!);
  const shared = new Set(said.filter((e, i) => said.indexOf(e) !== i));
  // One function per page, so the boundary never mistakes a re-render for a fresh answer.
  const loopCard = useMemo(() => () => <DashboardLoopCard retryMs={retryMs} />, [retryMs]);
  const loopMetrics = useMemo(() => () => <DashboardLoopMetrics retryMs={retryMs} />, [retryMs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Dashboard" description="Ask about a project, then where everything stands: the worker, the pipeline, quality, your projects, hotspots and recent activity." />
      <ScrollArea className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 md:p-5">
          {[...shared].map((e) => <Alert key={e}>{e}</Alert>)}
          <SharedOutage.Provider value={shared}>
            <GettingStarted status={status.data} pipeline={pipeline.data} />
            <Ask projects={projects.data} hotspots={hotspots.data} />
            <Now load={status} />
            <Pipeline load={pipeline} />
            <Contained render={loopCard} />
            <Contained render={loopMetrics} />
            <Quality load={patterns} />
            <Projects load={projects} globalLessons={pipeline.data?.lessons?.global ?? null} />
            <Struggles load={struggles} />
            <RecentActivity load={activity} />
          </SharedOutage.Provider>
        </div>
      </ScrollArea>
    </div>
  );
}

/** The section's error, or a placeholder until it loads, or its content. */
function Body<T>({ load, loading, children }: { load: Load<T>; loading: ReactNode; children: (data: T) => ReactNode }) {
  if (load.error) return <SectionError load={load} />;
  if (load.data === null) return <>{loading}</>;
  const data = load.data;
  return <Contained render={() => children(data)} />;
}

const SharedOutage = createContext<Set<string>>(new Set());

/** A section's own failure shows here; one the page's alert already says (an API outage) leaves the section waiting. */
function SectionError({ load }: { load: Load<unknown> }) {
  const shared = useContext(SharedOutage);
  return load.outage && shared.has(load.error!)
    ? <p className="p-3 text-[13px] text-muted">Not loaded yet: shown when the API answers.</p>
    : <div className="p-3"><Alert>{load.error}</Alert></div>;
}

/** An answer of an unexpected shape (an older API) breaks only its own section, never the page. */
class Contained extends Component<{ render: () => ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: errorMessage(e) }; }
  // A fresh answer (a poll) gets another try.
  componentDidUpdate(prev: { render: () => ReactNode }) { if (this.state.error && prev.render !== this.props.render) this.setState({ error: null }); }
  render() {
    return this.state.error ? <div className="p-3"><Alert>This section could not be shown: {this.state.error}</Alert></div> : <Run render={this.props.render} />;
  }
}

/** The Learning loop card, waiting quietly through an outage the page's alert already says. */
function DashboardLoopCard({ retryMs }: { retryMs?: number }) {
  const shared = useContext(SharedOutage);
  return <LoopCard retryMs={retryMs} waiting={(e) => shared.has(e)} />;
}

/** The learning-loop metrics, waiting quietly through the same outage. */
function DashboardLoopMetrics({ retryMs }: { retryMs?: number }) {
  const shared = useContext(SharedOutage);
  return <LoopMetricsCard retryMs={retryMs} waiting={(e) => shared.has(e)} />;
}

// A boundary catches only what its children throw, so the section renders one level down.
const Run = ({ render }: { render: () => ReactNode }) => <>{render()}</>;

const LinkAction = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} className="text-xs font-medium text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{children}</a>
);

const JOB_LABEL: Record<ModelJob, string> = { classify: 'classifier', postmortem: 'post-mortem', scan: 'scan', summary: 'summaries', docs: 'docs reader', chat: 'chat' };

function Now({ load }: { load: Load<SystemStatus> }) {
  return (
    <Card title="Now">
      <Body load={load} loading={<div className="grid gap-2 p-3"><Skeleton className="h-3 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>}>
        {(s) => {
          // A job turned off on purpose (SUMMARY_LLM=off) is not a model to watch.
          const models = (Object.entries(s.models ?? {}) as [ModelJob, ModelHealth][]).filter(([, m]) => !m.off);
          return (
            <div className="grid gap-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">Worker</span>
                <Badge tone={s.workerHealthy ? 'ok' : 'bad'} dot>{s.workerHealthy ? 'running' : 'offline'}</Badge>
                <p className="min-w-0 text-[13px]">{s.workerHealthy ? stageLine({ stage: s.stage ?? null, progress: s.progress ?? null }) : 'The worker has not reported in the last few minutes.'}</p>
              </div>
              {(models.length > 0 || s.ollama) && (
                <ul className="grid gap-1.5 text-[13px] sm:grid-cols-2">
                  {models.map(([job, m]) => (
                    <li key={job} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      {/* A job turned off on purpose (its Codex runner's safety flag) is neutral: red is for failures. */}
                      <Badge tone={m.ok ? 'ok' : m.disabled ? 'neutral' : 'bad'} dot>{labelOf(JOB_LABEL, job, asIs)}</Badge>
                      {m.provider && <span className="font-mono text-[12px] text-muted">{m.provider}</span>}
                      {!m.ok && <span className={`w-full text-xs [overflow-wrap:anywhere] ${m.disabled ? 'text-muted' : 'text-bad-text'}`}>{m.disabled ? `Codex runner off on this machine (${m.reason ?? 'no reason recorded'}): paused until it is re-enabled or another model is chosen` : m.reason ?? 'unavailable'}{m.since ? ` (since ${new Date(m.since).toLocaleTimeString()})` : ''}</span>}
                    </li>
                  ))}
                  {s.ollama && (
                    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <Badge tone={s.ollama.ok ? 'ok' : 'bad'} dot>embeddings</Badge>
                      <span className="font-mono text-[12px] text-muted">ollama</span>
                      {!s.ollama.ok && <span className="w-full text-xs text-bad-text [overflow-wrap:anywhere]">{s.ollama.reason ?? `not answering at ${s.ollama.url}`}</span>}
                    </li>
                  )}
                </ul>
              )}
              {s.worker && <p className="text-xs text-muted">Worker {s.worker.version}, last heartbeat {ago(s.worker.lastBeat)}{s.worker.lastError ? `; last error: ${s.worker.lastError}` : ''}</p>}
            </div>
          );
        }}
      </Body>
    </Card>
  );
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? '–' : String(v));

/** How long since an ISO time, roughly: `40 s`, `14 min`, `3 h`, `2 d` (as fg status says it). */
export function waitedFor(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

const QUEUE_NAME: Record<keyof WorkQueues, string> = { scans: 'Scan queue', classify: 'Classify queue', postmortems: 'Post-mortem queue', chats: 'Ask queue' };

/**
 * One queue in a line: "Scan queue: 7 waiting, oldest 2 h; running shard 12/40 of acme for 14 min". Null when nothing
 * waits or runs in it.
 */
export function queueLine(name: keyof WorkQueues, q: WorkQueue | null | undefined): string | null {
  if (!q || (!q.waiting && !q.running.length)) return null;
  const head = q.waiting
    ? `${q.waiting}${q.capped ? '+' : ''} waiting${q.oldestAt ? `, oldest ${q.capped ? 'at least ' : ''}${waitedFor(q.oldestAt)}` : ''}`
    : 'none waiting';
  const runs = q.running.map((r) => `running ${r.shards ? `shard ${Math.min(r.shards.done + 1, r.shards.total)}/${r.shards.total} of ` : ''}${r.what} for ${waitedFor(r.since)}`);
  return `${QUEUE_NAME[name]}: ${[head, ...runs].join('; ')}`;
}

/** Back-pressure under the tiles: a line per queue with work in it (none from an API without queues). */
function QueueLines({ queues }: { queues: WorkQueues | undefined }) {
  const lines = queues ? (Object.keys(QUEUE_NAME) as (keyof WorkQueues)[]).map((k) => queueLine(k, queues[k])).filter((l): l is string => !!l) : [];
  if (!lines.length) return null;
  return (
    <ul aria-label="queues" className="grid gap-0.5 text-[13px] text-muted">
      {lines.map((l) => <li key={l} className="[overflow-wrap:anywhere]">{l}</li>)}
    </ul>
  );
}

function Pipeline({ load }: { load: Load<PipelineStatus> }) {
  const tile = (href: string, label: string, value: string, hint: string) => (
    <a key={label} href={href} className="block min-w-0 bg-surface hover:bg-sunken [&>div]:bg-transparent">
      <StatTile label={label} value={value} hint={hint} />
    </a>
  );
  return (
    <div className="grid gap-1.5">
      <div className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Pipeline</div>
      {load.error ? (
        <SectionError load={load} />
      ) : (
        // Five across only where each tile has room for its label and hint (the main pane is the width less the sidebar).
        <StatGrid className="grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
          {load.data ? (() => {
            const p = load.data;
            const s = p.scans;
            return (
              <>
                {tile('#inbox', 'inbox, waiting on you', num(p.inbox?.pending), 'flagged pushback to confirm')}
                {/* Turns to classify: what the classifier flags, with the backlog on top. Post-mortems: the confirmed items waiting for one. */}
                {tile(activityKindHref('candidate_flagged'), 'turns to classify', p.classify ? `${p.classify.backlog}${p.classify.capped ? '+' : ''}` : '–', 'waiting for the classifier')}
                {tile(inboxTabHref('confirmed'), 'post-mortems queued', num(p.postmortems?.queued), 'confirmed feedback to explain')}
                {tile('#lessons', 'lessons', p.lessons ? `${p.lessons.proposed} / ${p.lessons.approved}` : '–', 'proposed / approved')}
                {tile('#projects', 'scans', s ? `${s.done} / ${s.queued} / ${s.running} / ${s.failed}` : '–', 'done / queued / running / failed')}
              </>
            );
          })() : Array.from({ length: 5 }, (_, i) => <StatTileSkeleton key={i} />)}
        </StatGrid>
      )}
      {load.data && <QueueLines queues={load.data.queues} />}
    </div>
  );
}

function Quality({ load }: { load: Load<PatternReport> }) {
  return (
    <Card title="Quality" actions={<LinkAction href="#patterns">Patterns</LinkAction>}>
      <Body load={load} loading={<div className="p-3"><Skeleton className="h-24 w-full" /></div>}>
        {(r) => {
          const weekly = r.weekly ?? [];
          const feedback = weekly.reduce((n, w) => n + w.feedback, 0);
          const repeats = weekly.reduce((n, w) => n + w.repeats, 0);
          const pd = r.preDone ?? { checks: 0, withGaps: 0, gapsFound: 0 };
          return (
            <div className="grid items-start gap-3 p-3 md:grid-cols-[16rem_minmax(0,1fr)]">
              <StatGrid className="grid-cols-2 md:grid-cols-1">
                <StatTile label="repeat rate" value={pct(repeats, feedback)} hint={`${repeats} of ${feedback} feedback was a miss seen before`} />
                <StatTile label="checks that caught a gap" value={pct(pd.withGaps, pd.checks)} hint={`of ${pd.checks} pre-done checks`} />
              </StatGrid>
              {weekly.length > 0 ? <WeeklyChart weekly={weekly} /> : <p className="py-6 text-muted">No confirmed feedback yet. Confirm items in the Inbox to start the trend.</p>}
            </div>
          );
        }}
      </Body>
    </Card>
  );
}

/** Projects listed before "Show all". */
const PROJECT_ROWS = 10;

function Projects({ load, globalLessons }: { load: Load<ProjectSummary[]>; globalLessons: number | null }) {
  return (
    <Card title="Projects" actions={<LinkAction href="#projects">All projects</LinkAction>}>
      <Body load={load} loading={<SkeletonList rows={3} />}>
        {(list) => list.length === 0 ? (
          <p className="p-3 py-6 text-muted">Nothing to list yet. Choose the folders to read in <a href="#settings" className="font-semibold underline underline-offset-2">Settings</a>.</p>
        ) : <ProjectsTable list={list} globalLessons={globalLessons} />}
      </Body>
    </Card>
  );
}

function ProjectsTable({ list, globalLessons }: { list: ProjectSummary[]; globalLessons: number | null }) {
  const [all, setAll] = useState(false);
  const sorted = [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return (
          <ScrollArea role="region" aria-label="projects table" className="overflow-x-auto">
            <table className={`${tableClass} text-[13px]`}>
              <thead>
                <tr>
                  <th className={thClass}>project</th>
                  {['sessions', 'feedback', 'lessons', 'facts'].map((h) => <th key={h} className={`${thClass} w-[5.5rem] text-right`}>{h}</th>)}
                  <th className={thClass}>last scan</th>
                  <th className={`${thClass} w-[4.5rem] text-right`} title="confirmed links to other projects">links</th>
                </tr>
              </thead>
              <tbody>
                {(all ? sorted : sorted.slice(0, PROJECT_ROWS)).map((p) => (
                  <tr key={p.key} className="last:[&>td]:border-b-0 hover:bg-sunken">
                    <td className={`${tdClass} whitespace-nowrap`}>
                      <span className="font-medium">{p.key}</span>
                      {p.pinned && <Badge tone="accent" className="ml-2">pinned</Badge>}
                    </td>
                    {[p.sessions, p.feedback, p.lessons, p.facts].map((n, i) => <td key={i} className={`${tdClass} text-right tabular-nums ${n ? '' : 'text-muted'}`}>{n}</td>)}
                    <td className={`${tdClass} whitespace-nowrap`}>
                      {p.lastScan ? (
                        <span className="inline-flex items-center gap-2">
                          <StatusBadge status={p.lastScan.status} />
                          <Time iso={p.lastScan.finishedAt ?? p.lastScan.requestedAt} className="text-xs text-muted" />
                        </span>
                      ) : <span className="text-muted">never</span>}
                    </td>
                    <td aria-label="links" className={`${tdClass} text-right tabular-nums ${p.links ? '' : 'text-muted'}`}>{p.links ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(sorted.length > PROJECT_ROWS || !!globalLessons) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-xs text-muted">
                {sorted.length > PROJECT_ROWS && (
                  <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? `Show the first ${PROJECT_ROWS}` : `Show all ${sorted.length}`}</Button>
                )}
                {!!globalLessons && (
                  <span>
                    <a href="#lessons" className="underline decoration-line-strong underline-offset-2 hover:text-text">{globalLessons} global {globalLessons === 1 ? 'lesson' : 'lessons'}</a>
                    {' '}serve every project; no row above counts them.
                  </span>
                )}
              </div>
            )}
          </ScrollArea>
  );
}

/** The files agents keep getting wrong: only those a confirmed miss touched (a busy file is a hotspot, not a struggle). */
function Struggles({ load }: { load: Load<ProjectHotspot[]> }) {
  return (
    <Card title="Where agents struggle" actions={<LinkAction href="#patterns">Patterns</LinkAction>}>
      <Body load={load} loading={<SkeletonList rows={4} />}>
        {(hot) => hot.length === 0 ? (
          <p className="p-3 py-6 text-muted">
            No files with misses yet: no confirmed miss has touched a mapped file. The busiest files are in each project's{' '}
            <a href="#projects" className="font-semibold underline underline-offset-2">hotspots</a>.
          </p>
        ) : (
          <div className="grid gap-3">
            <ScrollArea role="region" aria-label="files with misses table" className="overflow-x-auto">
              <table className={`${tableClass} text-[13px]`}>
                <thead>
                  <tr>
                    <th className={thClass}>file</th>
                    <th className={`${thClass} w-[4.5rem] text-right`}>misses</th>
                    <th className={`${thClass} w-[4.5rem] text-right`}>score</th>
                  </tr>
                </thead>
                <tbody>
                  {hot.map((h) => (
                    <tr key={`${h.projectKey}:${h.path}`} className="last:[&>td]:border-b-0 hover:bg-sunken">
                      <td className={`${tdClass} min-w-0`}>
                        <div className="text-xs text-muted">{h.projectKey}</div>
                        {/* Opens the file's module panel on the Projects page. */}
                        <a href={moduleHref(h.projectKey, h.path)} className="font-mono text-[12px] [overflow-wrap:anywhere] text-accent-text hover:underline">{h.path}</a>
                      </td>
                      <td className={`${tdClass} text-right font-semibold tabular-nums`}>{h.misses}</td>
                      <td className={`${tdClass} text-right font-semibold tabular-nums`}>{h.score.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          </div>
        )}
      </Body>
    </Card>
  );
}

function RecentActivity({ load }: { load: Load<Activity[]> }) {
  return (
    <Card title="Recent activity" actions={<LinkAction href="#activity">All activity</LinkAction>}>
      <Body load={load} loading={<SkeletonList rows={4} />}>
        {(rows) => rows.length === 0
          ? <p className="p-3 py-6 text-muted">Nothing has happened yet. Every scan, flag, decision and post-mortem shows up here.</p>
          : <ul>{rows.map((a) => <ActivityEntry key={a.id} a={a} />)}</ul>}
      </Body>
    </Card>
  );
}

/** Starter questions: a click puts one in the box to finish, it does not send it. */
/** What Ask does, behind the info button beside its heading. */
export const ASK_INTRO = 'Ask about a project. The answer cites what Feedback Graph knows and ends with a prompt to paste into your agent.';

const STARTERS = [
  'I want to add a new page: what do we already have that I should reuse?',
  'Where should a new API endpoint go, and which patterns should it follow?',
  'What do agents keep getting wrong in this project?',
  'Which files are riskiest to change, and why?',
];
const RECENT_CHATS = 5;
const SUGGESTED = 3;

/**
 * A file path on one line that never breaks mid-name: the folders truncate (…) and the file name stays whole, so a long
 * path reads `src/very/lo…/orders.ts` (a file name wider than the line truncates too). The full path is the tooltip;
 * give the control holding it an aria-label, since a screen reader would read the two parts apart.
 */
export function PathLine({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <span title={path} className="flex min-w-0 font-mono text-[12.5px]">
      {cut > 0 && <span className="min-w-0 truncate">{path.slice(0, cut)}</span>}
      <span className="max-w-full shrink-0 truncate">{path.slice(cut)}</span>
    </span>
  );
}

/**
 * The page's first thing: one question box. Pick a project, type, press Enter: it opens a new chat on the Ask page
 * (`#ask/new?project=…&q=…`), which starts it. Under it, questions suggested by the hotspots and the latest chats.
 */
function Ask({ projects, hotspots }: { projects: ProjectSummary[] | null; hotspots: ProjectHotspot[] | null }) {
  const [project, setProject] = useState('');
  const [text, setText] = useState('');
  // The model to answer with, as on the Ask page; null: the default model.
  const [provider, setProvider] = useState<ChatProvider | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const chats = useLoad(() => api.chats());
  const chosen = project || projects?.[0]?.key || '';
  // Asking starts a chat, an owner action: on a read-only install the box, starters and suggestions are off.
  const writes = useOwnerWrites();
  const ready = writes && !!chosen && !!text.trim();
  const go = () => {
    if (!ready) return;
    location.hash = newChatHref(chosen, text.trim(), provider ?? undefined);
  };
  const shown = new Set(projects?.map((p) => p.key));
  const suggested = (Array.isArray(hotspots) ? hotspots : []).filter((h) => shown.has(h.projectKey)).slice(0, SUGGESTED);
  const recent = (Array.isArray(chats.data) ? chats.data : []).slice(0, RECENT_CHATS);
  const listLabel = 'flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase';
  return (
    <section aria-label="Ask" className="grid justify-items-center gap-5 pt-6 pb-2 md:pt-10">
      <div className="flex w-full items-center gap-3">
        <Mark size={40} />
        <h2 className="min-w-0 text-[22px] font-semibold tracking-[-0.02em] [font-stretch:92%] md:text-[26px]">What do you want to build?</h2>
        <InfoTip label="About Ask" text={ASK_INTRO} />
      </div>
      <form
        className="grid w-full gap-2 rounded-lg border border-field bg-surface p-2 shadow-card focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20"
        onSubmit={(e) => { e.preventDefault(); go(); }}
      >
        <textarea
          ref={box}
          aria-label="question"
          rows={2}
          value={text}
          disabled={!writes}
          title={writes ? undefined : READ_ONLY_TITLE}
          placeholder={!writes ? 'Read-only: Ask needs an owner sign-in' : projects?.length ? 'e.g. I want to add a modal: what do we already have?' : 'Choose the projects to read in Settings first'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }}
          className="min-w-0 resize-none bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-text placeholder:text-muted focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="ask project" size="sm" value={chosen} onChange={(e) => setProject(e.target.value)} disabled={!projects?.length} className="w-auto max-w-[16rem]">
            {!projects?.length && <option value="">choose projects in Settings</option>}
            {projects?.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
          </Select>
          <ProviderSelect label="ask provider" value={provider} onChange={setProvider} />
          <span className="ml-auto hidden text-[11px] text-muted sm:inline">Enter to ask · Shift+Enter for a new line</span>
          <Button type="submit" variant="primary" size="sm" aria-label="Ask" owner disabled={!ready}>
            Ask <ChevronIcon size={12} />
          </Button>
        </div>
      </form>
      {/* One row, as wide as the box: each starter truncates (its full text is the title and the name); a phone scrolls it. */}
      <ScrollArea role="group" aria-label="starter questions" className="-m-1 flex w-[calc(100%+0.5rem)] gap-2 overflow-x-auto p-1">
        {STARTERS.map((q) => (
          <button
            key={q}
            type="button"
            aria-label={q}
            onClick={() => { setText(q); box.current?.focus(); }}
            disabled={!writes}
            title={writes ? q : READ_ONLY_TITLE}
            className="min-w-[12rem] flex-1 basis-0 truncate rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-[12.5px] shadow-card transition-colors enabled:hover:border-line-strong enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-0"
          >
            {q}
          </button>
        ))}
      </ScrollArea>
      {(suggested.length > 0 || recent.length > 0) && (
        // The page's full width, so its edges line up with the cards below it.
        <div className="grid w-full gap-6 pt-2 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="grid content-start gap-2">
            <div className={listLabel}><AskIcon size={12} /> Suggested questions</div>
            {suggested.length ? (
              <ul aria-label="suggested questions" className="grid gap-1">
                {suggested.map((h) => {
                  const q = `Before I change ${h.path}, what should I know?`;
                  return (
                    <li key={`${h.projectKey}:${h.path}`}>
                      <button type="button" aria-label={`${q} ${h.projectKey}: a hotspot${h.misses ? `, ${h.misses} past ${h.misses === 1 ? 'miss' : 'misses'}` : ''}`} onClick={() => { location.hash = newChatHref(h.projectKey, q); }} disabled={!writes} title={writes ? undefined : READ_ONLY_TITLE} className="grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60">
                        <span className="flex min-w-0 items-baseline gap-1.5 text-[13.5px] font-medium"><span className="shrink-0">Before I change</span><PathLine path={h.path} /></span>
                        <span className="text-xs text-muted">{h.projectKey} · a hotspot{h.misses ? `, ${h.misses} past ${h.misses === 1 ? 'miss' : 'misses'}` : ''}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-2 text-xs text-muted">Questions about your hotspots show here once a project is mapped.</p>
            )}
          </div>
          <div className="grid content-start gap-2">
            <div className={listLabel}>Recent chats <a href="#ask" className="ml-auto font-normal tracking-normal normal-case underline underline-offset-2 hover:text-text">all</a></div>
            {recent.length ? (
              <ul aria-label="recent chats" className="grid gap-1">
                {recent.map((c) => (
                  <li key={c.id}>
                    <a href={chatHref(c.id)} className="grid gap-0.5 rounded-md px-2 py-1.5 hover:bg-hover">
                      <span className="truncate text-[13.5px] font-medium">{c.title}</span>
                      <span className="text-xs text-muted">{c.projectKey} · <Time iso={c.updatedAt} />{c.pending ? ' · answering' : ''}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 text-xs text-muted">No chats yet: your questions are kept here, one conversation per topic.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
