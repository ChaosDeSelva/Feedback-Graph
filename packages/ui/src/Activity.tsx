import { useEffect, useState } from 'react';
import { ACTIVITY_KINDS, type Activity as Entry, type ActivityKind } from '@fb/core/types';
import { api, type PipelineStatus, type ProjectSummary } from './api.ts';
import { hashFocus } from './links.ts';
import { PageHeader } from './ui/PageHeader.tsx';
import { Button, Select } from './ui/controls.tsx';
import { Alert, Badge, EmptyState, SkeletonList, statusTone, type Tone } from './ui/display.tsx';
import { ActivityIcon, ChevronIcon } from './ui/icons.tsx';

const KIND_LABEL: Record<ActivityKind, string> = {
  scan_started: 'scan started',
  facts_extracted: 'facts extracted',
  scan_finished: 'scan finished',
  memory_imported: 'memory imported',
  candidate_flagged: 'feedback flagged',
  feedback_decided: 'your decision',
  postmortem_done: 'post-mortem',
  postmortem_failed: 'post-mortem failed',
  lesson_decided: 'lesson decision',
  context_served: 'context served',
  predone_check: 'pre-done check',
  doc_added: 'document added',
  doc_removed: 'document removed',
  project_deleted: 'project deleted',
  project_aliased: 'project alias',
  projects_selected: 'projects selected',
  projects_cleaned: 'unselected data removed',
  code_mapped: 'code mapped',
  cloud_synced: 'cloud sync',
  turns_requeued: 'turns re-queued',
  bundle_imported: 'bundle imported',
  session_summarized: 'session summarized',
  roots_saved: 'project roots saved',
  integration_changed: 'connection changed',
  feedback_synced: 'comments synced',
  facts_scored: 'facts scored',
  fact_relevance_set: 'fact relevance set',
  project_pinned: 'project pinned',
  links_suggested: 'links suggested',
  link_decided: 'link decision',
  doc_read: 'document read',
  comments_skipped: 'comments skipped',
  lessons_checked: 'lessons checked',
  lesson_to_fact: 'lesson to fact',
};

const KIND_TONE: Partial<Record<ActivityKind, Tone>> = {
  postmortem_failed: 'bad',
  project_deleted: 'bad',
  postmortem_done: 'ok',
  candidate_flagged: 'info',
};

/** A decision takes the color of what was decided (approved green, rejected red), as status badges do everywhere else. */
function kindTone(a: Entry): Tone {
  if (a.kind === 'feedback_decided' || a.kind === 'lesson_decided') {
    const status = (a.details as { status?: unknown }).status;
    return typeof status === 'string' ? statusTone(status) : 'neutral';
  }
  if (a.kind === 'cloud_synced') return (a.details as { ok?: unknown }).ok === false ? 'bad' : 'ok';
  return KIND_TONE[a.kind] ?? 'neutral';
}

/** Model provider names, as in a provider spec (`ollama:gemma4`, `claude-cli`; core llm/providers.ts). */
const MODEL_PROVIDERS = ['ollama', 'openai', 'openrouter', 'groq', 'anthropic', 'claude-cli', 'codex-cli', 'jev'];
/** MCP clients that log as themselves, and the Ask page's chat. */
const MCP_AGENTS = ['agent (MCP)', 'claude-code', 'codex', 'ui-chat'];

export type ActorKind = 'person' | 'operator' | 'mcp' | 'model' | 'step';
const ACTOR_HINT: Record<ActorKind, string> = {
  person: 'person: you, from this app or the CLI',
  operator: 'agent with the operator token: an agent acting for you through the admin tools',
  mcp: 'agent over MCP: an agent asking for context or reporting a miss (or the Ask page)',
  model: 'model: a language model did this step',
  step: 'pipeline step: a fixed rule or step in the worker, no model involved',
};

/** The page's legend: an example of each kind of actor. */
const LEGEND: [ActorKind, string][] = [
  ['person', 'you'], ['operator', 'operator:<name>'], ['mcp', 'claude-code, agent (MCP)'], ['model', 'provider:model'], ['step', 'skip-rules, deterministic'],
];

/** What kind of actor wrote an entry: you, an agent (operator token or MCP), a model, or a step of the pipeline. */
export function actorKind(actor: string): ActorKind {
  if (actor === 'you') return 'person';
  if (actor.startsWith('operator')) return 'operator';
  if (MCP_AGENTS.includes(actor)) return 'mcp';
  if (MODEL_PROVIDERS.includes(actor.split(':')[0]) || actor.startsWith('fake:')) return 'model';
  return 'step';
}
export const actorHint = (actor: string) => ACTOR_HINT[actorKind(actor)];

/** Prose (anything with a space in it) reads in the text font; ids, paths and hashes stay monospaced. */
const isProse = (s: string) => /\s/.test(s.trim());

const time = (ts: string) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type Item = { statement?: string; title?: string; missed?: string; why?: string; kind?: string; status?: string; path?: string; ref?: string };

/** One value in an activity's details: lists of facts/verdicts get their own "why", everything else stays compact. */
function Value({ v }: { v: unknown }) {
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="text-muted">none</span>;
    return (
      <ul className="grid gap-1">
        {v.map((x: unknown, i) => {
          if (typeof x !== 'object' || x === null) return <li key={i} className={`[overflow-wrap:anywhere] ${isProse(String(x)) ? '' : 'font-mono'}`}>{String(x)}</li>;
          const it = x as Item;
          const head = it.statement ?? it.title ?? it.missed ?? it.ref ?? it.path;
          return (
            <li key={i} className="rounded-sm border border-line bg-surface px-2 py-1.5">
              <span className="text-muted">{[it.kind, it.status].filter(Boolean).join(' · ')}{it.kind || it.status ? ' · ' : ''}</span>
              <span className="[overflow-wrap:anywhere]">{head ?? JSON.stringify(x)}</span>
              {it.why && <div className="text-muted">why: {it.why}</div>}
            </li>
          );
        })}
      </ul>
    );
  }
  if (v && typeof v === 'object') return <pre className="overflow-x-auto font-mono whitespace-pre-wrap">{JSON.stringify(v, null, 2)}</pre>;
  const text = v === null || v === undefined ? '–' : String(v);
  return <span className={`[overflow-wrap:anywhere] ${typeof v === 'string' && isProse(v) ? '' : 'font-mono'}`}>{text}</span>;
}

/** Column layout shared by the rows and the Activity page's header row. */
export const ACTIVITY_COLS = 'grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-3 @3xl:grid-cols-[1rem_minmax(0,1fr)_9.5rem_9rem_6.5rem]';

export function ActivityEntry({ a, open: initial = false }: { a: Entry; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  const details = Object.entries(a.details);
  return (
    <li className="@container border-b border-line last:border-b-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${ACTIVITY_COLS} w-full items-start px-3 py-2 text-left transition-colors hover:bg-sunken`}>
        <ChevronIcon size={12} className={`mt-1 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0">
          <span className="block text-[13px] [overflow-wrap:anywhere]">{a.subject}</span>
          <span className="block text-xs text-muted [overflow-wrap:anywhere]">{a.why}</span>
          <span className="mt-1 block @3xl:hidden"><Badge tone={kindTone(a)}>{KIND_LABEL[a.kind] ?? a.kind}</Badge></span>
        </span>
        <span className="hidden min-w-0 @3xl:block">
          <Badge tone={kindTone(a)}>{KIND_LABEL[a.kind] ?? a.kind}</Badge>
        </span>
        <span className="max-w-36 min-w-0 text-right text-xs @3xl:contents">
          <span title={actorHint(a.actor)} className="block truncate font-mono text-[11.5px] text-muted @3xl:text-left">{a.actor}</span>
          <span className="block text-muted tabular-nums @3xl:text-right">{time(a.ts)}</span>
        </span>
      </button>
      {open && (
        <dl className="grid gap-x-4 gap-y-2 border-t border-line bg-sunken px-3 py-2.5 pl-10 text-xs @xl:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-muted">what</dt><dd>{KIND_LABEL[a.kind] ?? a.kind}{a.projectKey ? ` · ${a.projectKey}` : ''}</dd>
          {details.map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="min-w-0"><Value v={v} /></dd></div>
          ))}
          {a.targets.length > 0 && <><dt className="text-muted">touched</dt><dd className="min-w-0 font-mono [overflow-wrap:anywhere]">{a.targets.join(', ')}</dd></>}
        </dl>
      )}
    </li>
  );
}

export function Activity() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState('');
  // A link to one kind (#activity/candidate_flagged, from the Dashboard) opens filtered to it.
  const [kind, setKind] = useState<ActivityKind | ''>(() => {
    const k = hashFocus('activity');
    return ACTIVITY_KINDS.includes(k as ActivityKind) ? (k as ActivityKind) : '';
  });
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.projects().then(setProjects, (e) => setError(String(e))); }, []);
  useEffect(() => {
    setRows(null);
    // A slow answer for filters you have left must not fill the list for the ones you picked.
    let stale = false;
    api.activity({ project: project || undefined, kind: kind || undefined, limit: 300 })
      .then((r) => { if (!stale) setRows(r); }, (e) => { if (!stale) { setError(String(e)); setRows([]); } });
    return () => { stale = true; };
  }, [project, kind]);

  const filtered = !!(project || kind);

  // Turns waiting for the classifier are not entries yet: filtered to what the classifier flags, say how many wait.
  const [classify, setClassify] = useState<PipelineStatus['classify']>(null);
  useEffect(() => {
    if (kind !== 'candidate_flagged') return;
    let live = true;
    api.pipeline().then((p) => { if (live) setClassify(p.classify ?? null); }, () => {});
    return () => { live = false; };
  }, [kind]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Activity"
        description="Every fact, lesson and decision, with the model or person behind it and why."
        actions={
          <>
            <Select aria-label="project" value={project} onChange={(e) => setProject(e.target.value)} className="w-40">
              <option value="">all projects</option>
              {projects.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
            </Select>
            <Select aria-label="kind" value={kind} onChange={(e) => setKind(e.target.value as ActivityKind | '')} className="w-44">
              <option value="">everything</option>
              {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
        {error && <Alert className="mb-3">{error}</Alert>}
        {kind === 'candidate_flagged' && classify && (
          <p role="status" className="mb-3 rounded-md border border-line bg-sunken px-3 py-2 text-[13px]">
            {classify.backlog === 0 && !classify.capped
              ? 'No turns are waiting for the classifier.'
              : `${classify.backlog}${classify.capped ? '+' : ''} turns are waiting for the classifier. Each one it flags as pushback shows up below and in the Inbox.`}
          </p>
        )}
        {/* Who "By" names: the same words as each actor's tooltip, once for the page. */}
        <ul aria-label="who did it" className="mb-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
          {LEGEND.map(([k, example]) => <li key={k} title={ACTOR_HINT[k]}><span className="font-mono">{example}</span> {ACTOR_HINT[k].split(':')[0]}</li>)}
        </ul>
        <div className="@container rounded-md border border-line bg-surface shadow-card">
          <div className={`${ACTIVITY_COLS} sticky top-0 z-[1] rounded-t-md border-b border-line bg-sunken px-3 py-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase`}>
            <span />
            <span>Event</span>
            <span className="hidden @3xl:block">Kind</span>
            <span className="hidden @3xl:block">By</span>
            <span className="text-right">When</span>
          </div>
          {rows === null ? (
            <SkeletonList rows={8} />
          ) : rows.length === 0 ? (
            filtered ? (
              <EmptyState icon={<ActivityIcon />} title="No entries match these filters" action={<Button onClick={() => { setProject(''); setKind(''); }}>Clear filters</Button>}>
                Try another project or kind, or clear the filters to see everything.
              </EmptyState>
            ) : (
              <EmptyState icon={<ActivityIcon />} title="Nothing logged yet">
                The worker records every scan, flag, decision and post-mortem here as it happens.
              </EmptyState>
            )
          ) : (
            <ul>{rows.map((a) => <ActivityEntry key={a.id} a={a} />)}</ul>
          )}
        </div>
      </div>
    </div>
  );
}
