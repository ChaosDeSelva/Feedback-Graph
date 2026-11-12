import { asIs, labelOf } from './labels.ts';
import { useEffect, useState } from 'react';
import { api, type PipelineStatus } from './api.ts';
import { activityKindHref, inboxTabHref } from './links.ts';

/** The pages that stay empty until the pipeline has run a while; the panel shows on each until it has something. */
export type FirstRunView = 'inbox' | 'lessons' | 'graph';

const STAGE_LABEL: Record<NonNullable<PipelineStatus['stage']>['name'], string> = {
  sync: 'Syncing GitHub and Linear',
  ingest: 'Reading transcripts',
  classify: 'Classifying turns',
  postmortem: 'Writing a post-mortem',
  scan: 'Scanning a project',
  docs: 'Reading an upload',
  waiting: 'Waiting for new work',
};

const POLL_MS = 10_000;

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The worker's step alone ("Classifying turns"): what a screen reader announces, once per change of step. */
export function stageName(p: Pick<PipelineStatus, 'stage'>): string {
  if (!p.stage) return 'The worker is not reporting (offline, or older than this page)';
  return labelOf(STAGE_LABEL, p.stage.name, asIs);
}

/** ": 3 of 50, for 2m 10s (turn-9)": what follows the step, changing on every poll, so it is shown but never announced. */
export function stageDetail(p: Pick<PipelineStatus, 'stage' | 'progress'>, now = Date.now()): string {
  if (!p.stage) return '';
  // Nothing counted yet (a stage that just started, or found nothing) reads as the stage alone, never "0 of 0".
  const counted = p.progress && !(p.progress.done === 0 && (p.progress.total === 0 || p.progress.total === null));
  const count = counted ? `: ${p.progress!.done}${p.progress!.total === null ? '' : ` of ${p.progress!.total}`}` : '';
  const current = p.stage.current ? ` (${p.stage.current})` : '';
  return `${count}, for ${duration(now - Date.parse(p.stage.startedAt))}${current}`;
}

/** "Classifying turns: 3 of 50, for 2m 10s (turn-9)": the worker's step, its count, how long it has run, the item. */
export const stageLine = (p: Pick<PipelineStatus, 'stage' | 'progress'>, now = Date.now()) => stageName(p) + stageDetail(p, now);

/** "Now: <step><detail>", where only the step is a live region: a poll that changes the count or the time stays quiet. */
function NowLine({ p, now, className }: { p: PipelineStatus; now: number; className: string }) {
  return <span className={className}>Now: <span role="status">{stageName(p)}</span>{stageDetail(p, now)}</span>;
}

/** Whether `view` has nothing to show yet, by the pipeline's counts (unknown counts never hide the panel). */
function empty(view: FirstRunView, p: PipelineStatus): boolean {
  if (view === 'inbox') return !p.inbox || p.inbox.pending === 0;
  // The graph draws evidence chains from post-mortems, which are what lessons come from.
  return !p.lessons || p.lessons.proposed + p.lessons.approved === 0;
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? 'unknown' : String(v));

/** "1000+ turns to classify · 2 post-mortems queued": what is still waiting, or null when nothing is known to be. */
function backlogLine(p: PipelineStatus): string | null {
  const parts = [
    p.classify && p.classify.backlog > 0 && `${p.classify.backlog}${p.classify.capped ? '+' : ''} turn${p.classify.backlog === 1 && !p.classify.capped ? '' : 's'} to classify`,
    p.postmortems && p.postmortems.queued > 0 && `${p.postmortems.queued} post-mortem${p.postmortems.queued === 1 ? '' : 's'} queued`,
    p.scans && p.scans.queued + p.scans.running > 0 && `${p.scans.queued + p.scans.running} scan${p.scans.queued + p.scans.running === 1 ? '' : 's'} queued or running`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** What an empty page says: where it stands, truthfully as progress is made, and what fills it. */
function emptyLine(view: FirstRunView, p: PipelineStatus): [string, string] {
  if (view === 'inbox') {
    const started = (p.inbox?.confirmed ?? 0) > 0 || (p.lessons?.proposed ?? 0) + (p.lessons?.approved ?? 0) > 0;
    return [started ? 'Nothing waiting for you in the Inbox.' : 'Nothing in the Inbox yet.', 'Pushback the classifier finds in your sessions shows up here to confirm.'];
  }
  if (view === 'lessons') return ['No lessons yet.', 'One is proposed when a miss you confirmed in the Inbox gets its post-mortem.'];
  return ['No evidence chains yet.', 'A chain is drawn when a miss you confirmed in the Inbox gets its post-mortem.'];
}

/**
 * The pipeline line on Inbox, Lessons and Graph: the stage now and the backlog, which opens to every stage, each linked
 * to its page. A fresh install keeps these pages empty for a while (transcripts are read, then classified, then you
 * confirm, then a post-mortem proposes a lesson): an empty page also says so in one line, and until a lesson is
 * approved points at the Dashboard's Getting started steps, so it never fills a phone's first screen. `project` (with
 * `force`, from an empty state filtered to it) asks for that project's counts and always says what the page is waiting for.
 */
export function FirstRun({ view, project, force = false, now = Date.now }: { view: FirstRunView; project?: string; force?: boolean; now?: () => number }) {
  const [p, setP] = useState<PipelineStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let live = true;
    setP(null);
    const load = () => api.pipeline(project || undefined).then((r) => live && setP(r), () => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [project]);
  if (!p) return null;
  const isEmpty = force || empty(view, p);
  const backlog = backlogLine(p);
  const [where, what] = emptyLine(view, p);
  const s = p.scans;
  const rows: { label: string; value: string; href: string; hint: string }[] = [
    { label: 'Sessions read', value: n(p.sessions), href: '#sessions', hint: 'Agent transcripts read from the projects you selected' },
    {
      label: 'Turns to classify',
      value: p.classify ? `${p.classify.backlog}${p.classify.capped ? '+' : ''}` : 'unknown',
      href: activityKindHref('candidate_flagged'),
      hint: 'Your messages waiting for the local classifier to look for pushback',
    },
    { label: 'Inbox, waiting on you', value: n(p.inbox?.pending), href: '#inbox', hint: 'Flagged pushback for you to confirm or reject' },
    { label: 'Post-mortems queued', value: n(p.postmortems?.queued), href: inboxTabHref('confirmed'), hint: 'Feedback waiting for a post-mortem, which proposes a lesson' },
    {
      label: 'Lessons',
      value: p.lessons ? `${p.lessons.proposed} proposed, ${p.lessons.approved} approved` : 'unknown',
      href: '#lessons',
      hint: 'Agents only get lessons you approve',
    },
    {
      label: 'Project scans',
      value: s ? [`${s.done} done`, s.running && `${s.running} running`, s.queued && `${s.queued} queued`, s.failed && `${s.failed} failed`, s.never && `${s.never} never`].filter(Boolean).join(', ') : 'unknown',
      href: '#projects',
      hint: 'Facts about each project, from a scan you start on the Projects page',
    },
  ];
  return (
    <section aria-label="pipeline" className="shrink-0 border-b border-line bg-sunken px-4 py-1.5 text-xs text-muted md:px-6">
      {isEmpty && (
        <p className="mb-1 max-w-3xl">
          <span className="font-semibold text-text">{project ? `${project}: ` : ''}{where}</span> {what}
          {(p.lessons?.approved ?? 0) === 0 && <> <a href="#dashboard" className="font-medium text-accent-text underline decoration-accent/40 underline-offset-2">Getting started</a> on the Dashboard has the next step.</>}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="font-medium text-text">Pipeline</span>
        <NowLine p={p} now={now()} className="min-w-0 truncate" />
        {backlog && <span className="tabular-nums">{backlog}</span>}
        <button type="button" aria-label={expanded ? 'hide stages' : 'show stages'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="ml-auto underline decoration-line-strong underline-offset-2 hover:text-text">
          {expanded ? 'hide' : 'stages'}
        </button>
      </div>
      {expanded && (
        <>
          <p className="mt-1 max-w-3xl">
            Transcripts are read, the classifier flags pushback for you to confirm, and each confirmed item gets a post-mortem that proposes a lesson. On a big
            history this takes a while.{project ? ' Counts are for this project; turns to classify and the stage are across all of them.' : ''}
          </p>
          <ol className="mt-2 mb-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((r) => (
              <li key={r.label}>
                <a href={r.href} title={r.hint} className="flex items-baseline justify-between gap-3 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-[13px] hover:border-accent">
                  <span className="text-muted">{r.label}</span>
                  <span className="font-medium text-text tabular-nums">{r.value}</span>
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
