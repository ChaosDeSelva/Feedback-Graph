import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ModelHealth, ModelJob } from '@fb/core';
import { ActivityEntry } from './Activity.tsx';
import { api, type Activity, type PatternReport, type PipelineStatus, type ProjectHotspot, type ProjectSummary, type SystemStatus } from './api.ts';
import { activityKindHref, chatHref, inboxTabHref, moduleHref, newChatHref } from './links.ts';
import { stageLine } from './FirstRun.tsx';
import { pct, WeeklyChart } from './Patterns.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { Button, Select } from './ui/controls.tsx';
import { AskIcon, ChevronIcon, Mark } from './ui/icons.tsx';
import { ago, Alert, Badge, Card, Skeleton, SkeletonList, StatGrid, StatTile, StatTileSkeleton, StatusBadge, tableClass, tdClass, thClass } from './ui/display.tsx';

const POLL_MS = 10_000;

type Load<T> = { data: T | null; error: string | null };

/**
 * One section's data. Each section loads on its own, so an endpoint that fails (or a store without that route) shows
 * its error in its own card and every other section still renders. `pollMs` reloads it while the page is open.
 */
function useLoad<T>(load: () => Promise<T>, pollMs?: number): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    const run = () => load().then(
      (data) => { if (live) setState({ data, error: null }); },
      (e) => { if (live) setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e) })); },
    );
    run();
    const t = pollMs ? setInterval(run, pollMs) : undefined;
    return () => { live = false; clearInterval(t); };
  }, []);
  return state;
}

/** The landing page: where everything stands, each part linked to the page that has the detail. */
export function Dashboard() {
  const status = useLoad(api.status, POLL_MS);
  const pipeline = useLoad(api.pipeline, POLL_MS);
  const patterns = useLoad(() => api.patterns());
  const projects = useLoad(api.projects);
  const hotspots = useLoad(() => api.topHotspots(undefined, 8));
  const struggles = useLoad(() => api.topHotspots(undefined, 8, false, true));
  const activity = useLoad(() => api.activity({ limit: 10 }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Dashboard" description="Ask about a project, then where everything stands: the worker, the pipeline, quality, your projects, hotspots and recent activity." />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 md:p-5">
          <Ask projects={projects.data} hotspots={hotspots.data} />
          <Now load={status} />
          <Pipeline load={pipeline} />
          <Quality load={patterns} />
          <Projects load={projects} globalLessons={pipeline.data?.lessons?.global ?? null} />
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Struggles load={struggles} />
            <RecentActivity load={activity} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The section's error, or a placeholder until it loads, or its content. */
function Body<T>({ load, loading, children }: { load: Load<T>; loading: ReactNode; children: (data: T) => ReactNode }) {
  if (load.error) return <div className="p-3"><Alert>{load.error}</Alert></div>;
  if (load.data === null) return <>{loading}</>;
  const data = load.data;
  return <Contained render={() => children(data)} />;
}

/** An answer of an unexpected shape (an older API) breaks only its own section, never the page. */
class Contained extends Component<{ render: () => ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  // A fresh answer (a poll) gets another try.
  componentDidUpdate(prev: { render: () => ReactNode }) { if (this.state.error && prev.render !== this.props.render) this.setState({ error: null }); }
  render() {
    return this.state.error ? <div className="p-3"><Alert>This section could not be shown: {this.state.error}</Alert></div> : <Run render={this.props.render} />;
  }
}

// A boundary catches only what its children throw, so the section renders one level down.
const Run = ({ render }: { render: () => ReactNode }) => <>{render()}</>;

const LinkAction = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} className="text-xs font-medium text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{children}</a>
);

const JOB_LABEL: Partial<Record<ModelJob, string>> = { classify: 'classifier', postmortem: 'post-mortem', scan: 'scan', summary: 'summaries', docs: 'docs reader' };

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
                      <Badge tone={m.ok ? 'ok' : 'bad'} dot>{JOB_LABEL[job] ?? job}</Badge>
                      {m.provider && <span className="font-mono text-[12px] text-muted">{m.provider}</span>}
                      {!m.ok && <span className="w-full text-xs text-bad-text [overflow-wrap:anywhere]">{m.reason ?? 'unavailable'}{m.since ? ` (since ${new Date(m.since).toLocaleTimeString()})` : ''}</span>}
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
        <Alert>{load.error}</Alert>
      ) : (
        <StatGrid className="grid-cols-2 lg:grid-cols-5">
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
          <div className="overflow-x-auto">
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
                        <span className="inline-flex items-center gap-2" title={p.lastScan.finishedAt ?? p.lastScan.requestedAt}>
                          <StatusBadge status={p.lastScan.status} />
                          <span className="text-xs text-muted">{ago(p.lastScan.finishedAt ?? p.lastScan.requestedAt)}</span>
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
          </div>
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
            <div className="overflow-x-auto">
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
                      <td className={`${tdClass} text-right tabular-nums ${h.misses ? 'font-semibold' : 'text-muted'}`}>{h.misses}</td>
                      <td className={`${tdClass} text-right font-semibold tabular-nums`}>{h.score.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
const STARTERS = [
  'I want to add a new page: what do we already have that I should reuse?',
  'Where should a new API endpoint go, and which patterns should it follow?',
  'What do agents keep getting wrong in this project?',
  'Which files are riskiest to change, and why?',
];
const RECENT_CHATS = 5;
const SUGGESTED = 3;

/**
 * The page's first thing: one question box. Pick a project, type, press Enter: it opens a new chat on the Ask page
 * (`#ask/new?project=…&q=…`), which starts it. Under it, questions suggested by the hotspots and the latest chats.
 */
function Ask({ projects, hotspots }: { projects: ProjectSummary[] | null; hotspots: ProjectHotspot[] | null }) {
  const [project, setProject] = useState('');
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const chats = useLoad(() => api.chats());
  const chosen = project || projects?.[0]?.key || '';
  const ready = !!chosen && !!text.trim();
  const go = () => {
    if (!ready) return;
    location.hash = newChatHref(chosen, text.trim());
  };
  const shown = new Set(projects?.map((p) => p.key));
  const suggested = (Array.isArray(hotspots) ? hotspots : []).filter((h) => shown.has(h.projectKey)).slice(0, SUGGESTED);
  const recent = (Array.isArray(chats.data) ? chats.data : []).slice(0, RECENT_CHATS);
  const listLabel = 'flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase';
  return (
    <section aria-label="Ask" className="grid justify-items-center gap-5 px-1 pt-6 pb-2 md:pt-10">
      <div className="grid justify-items-center gap-3 text-center">
        <Mark size={40} />
        <h2 className="text-[22px] font-semibold tracking-[-0.02em] [font-stretch:92%] md:text-[26px]">What do you want to build?</h2>
        <p className="max-w-xl text-[13px] text-muted">Ask about a project. The answer cites what Feedback Graph knows and ends with a prompt to paste into your agent.</p>
      </div>
      <form
        className="grid w-full max-w-2xl gap-2 rounded-lg border border-field bg-surface p-2 shadow-card focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20"
        onSubmit={(e) => { e.preventDefault(); go(); }}
      >
        <textarea
          ref={box}
          aria-label="question"
          rows={2}
          value={text}
          placeholder={projects?.length ? 'e.g. I want to add a modal: what do we already have?' : 'Choose the projects to read in Settings first'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }}
          className="min-w-0 resize-none bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-text placeholder:text-muted focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <Select aria-label="ask project" size="sm" value={chosen} onChange={(e) => setProject(e.target.value)} disabled={!projects?.length} className="w-auto max-w-[16rem]">
            {!projects?.length && <option value="">choose projects in Settings</option>}
            {projects?.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
          </Select>
          <span className="ml-auto hidden text-[11px] text-muted sm:inline">Enter to ask · Shift+Enter for a new line</span>
          <Button type="submit" variant="primary" size="sm" aria-label="Ask" disabled={!ready}>
            Ask <ChevronIcon size={12} />
          </Button>
        </div>
      </form>
      <div className="flex max-w-3xl flex-wrap justify-center gap-2">
        {STARTERS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => { setText(q); box.current?.focus(); }}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-[12.5px] shadow-card transition-colors hover:border-line-strong hover:bg-hover"
          >
            {q}
          </button>
        ))}
      </div>
      {(suggested.length > 0 || recent.length > 0) && (
        <div className="grid w-full max-w-4xl gap-6 pt-2 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="grid content-start gap-2">
            <div className={listLabel}><AskIcon size={12} /> Suggested questions</div>
            {suggested.length ? (
              <ul aria-label="suggested questions" className="grid gap-1">
                {suggested.map((h) => {
                  const q = `Before I change ${h.path}, what should I know?`;
                  return (
                    <li key={`${h.projectKey}:${h.path}`}>
                      <button type="button" onClick={() => { location.hash = newChatHref(h.projectKey, q); }} className="grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover">
                        <span className="text-[13.5px] font-medium [overflow-wrap:anywhere]">{q}</span>
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
                      <span className="text-xs text-muted">{c.projectKey} · {ago(c.updatedAt)}{c.pending ? ' · answering' : ''}</span>
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
