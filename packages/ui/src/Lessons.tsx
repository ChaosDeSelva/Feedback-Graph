import { useEffect, useId, useState, type ReactNode } from 'react';
import { ActivityEntry } from './Activity.tsx';
import { hashFocus } from './links.ts';
import type { FactKind, LessonCheck, LessonCheckName, LessonFrom } from '@fb/core';
import { FACT_KINDS, LESSON_CHECKS, LESSON_FROM } from '@fb/core/types';
import { EVERYDAY_FROM } from '@fb/core/relevance';
import { api, type Activity, type Lesson, type LessonDetail, type LessonEdit, type LessonQuality, type LessonQualityReport, type LessonStatus } from './api.ts';
import { afterDiscard, useUnsavedChanges } from './unsaved.ts';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, Input, Select, Tabs, Textarea } from './ui/controls.tsx';
import { Alert, Badge, Card, CauseBadge, causeLabel, causeTone, EmptyState, plural, SectionLabel, SkeletonDetail, SkeletonList, StatusBadge, tableClass, tdClass, TONE_FILL } from './ui/display.tsx';
import { LessonIcon } from './ui/icons.tsx';

const TABS: LessonStatus[] = ['proposed', 'approved', 'rejected', 'revoked', 'superseded'];

/** The lesson check's generic flag (a rule naming nothing concrete), if it has one. */
const genericOf = (l: Lesson) => l.checks?.find((c) => c.name === 'generic');
/** Generic lessons last (the rest keep their order): the owner reaches the concrete ones first. */
const genericLast = (ls: Lesson[]) => [...ls.filter((l) => !genericOf(l)), ...ls.filter((l) => genericOf(l))];

type Draft = Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope'>;

const EMPTY: Record<LessonStatus, { title: string; children: string }> = {
  proposed: { title: 'No lessons to review', children: 'Each feedback item you confirm in the Inbox gets a post-mortem, and its proposed lesson waits here.' },
  approved: { title: 'No approved lessons yet', children: 'Approve a proposed lesson and agents start receiving it with their task context.' },
  rejected: { title: 'Nothing rejected', children: 'Lessons rejected during review stay here, so you can put them back up for review.' },
  revoked: { title: 'Nothing revoked', children: 'Previously approved lessons you withdrew stay here and are no longer served.' },
  superseded: { title: 'Nothing superseded', children: 'When a newer lesson replaces an older one, the older one moves here.' },
};

/** Short names for what the lesson check found (worker postmortem/lessonCheck.ts); the reason is in each chip's title. */
const CHECK_LABEL: Record<LessonCheckName, string> = {
  'non-repo-path': 'path outside the repo',
  'bad-path': 'bad path dropped',
  'needs-path': 'needs a path',
  'universal-from-nit': 'rule from a nit',
  'meta-lesson': 'about feedback',
  platitude: 'platitude',
  'broken-rule': 'rule repaired',
  'looks-like-a-fact': 'looks like a fact',
  'not-pushback': 'not pushback',
  'wrong-session': 'wrong session',
  'source-pr-unmerged': 'source PR never merged',
  'self-review': 'self-review',
  'path-missing': 'path not in repo',
  'duplicate-of': 'duplicate',
  'contradicts-evidence': 'cause contradicted',
  'unlinked-ticket': 'another project\'s ticket',
  generic: 'generic',
  bundled: 'two lessons in one',
  'ambiguous-path': 'ambiguous path',
  'no-miss': 'no miss found',
  'filler-applies-when': 'vague "applies when"',
  'may-hold-secret': 'may hold a secret',
};
/** Where a lesson came from, in words; the tooltip says it in full. `from` (where its feedback came from) first. */
const SOURCE_LABEL: Record<string, [label: string, title: string]> = {
  github: ['GitHub review', 'from a GitHub pull request comment or review, through a post-mortem'],
  linear: ['Linear comment', 'from a Linear issue comment, through a post-mortem'],
  session: ['session pushback', 'from your pushback in an agent session, through a post-mortem'],
  postmortem: ['post-mortem', 'from a post-mortem'],
  memory: ['memory file', 'imported from a Claude Code memory file'],
  manual: ['by you', 'written by you'],
  demo: ['demo', 'a demo lesson from fg demo seed; fg demo remove takes it back'],
};
function SourceLabel({ source }: { source: string }) {
  const [label, title] = Object.hasOwn(SOURCE_LABEL, source) ? SOURCE_LABEL[source] : [source, source];
  return <span title={title}>{label}</span>;
}

/** The store lists at most this many lessons per request (listLessons' default limit). */
const LIST_CAP = 500;

/**
 * One confirm for many decisions: names every lesson, takes an optional note (kept on each lesson as the decision's
 * note). Approving is not a removal, so this is a plain dialog; Reject is the red button.
 */
function BulkDialog({ action, lessons, onCancel, onDone }: {
  action: 'approved' | 'rejected';
  lessons: Lesson[];
  onCancel: () => void;
  onDone: (results: { id: string; ok: boolean; error?: string }[]) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const verb = action === 'approved' ? 'Approve' : 'Reject';
  const label = `${verb} ${plural(lessons.length, 'lesson')}`;
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const { results } = await api.decideLessons(lessons.map((l) => ({ id: l.id, status: action, ...(note.trim() && { note: note.trim() }) })));
      onDone(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-text/30 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && !busy) onCancel(); }}
        className="w-full max-w-md rounded-md border border-line bg-surface text-[13px] shadow-pop"
      >
        <div className="grid gap-3 p-4">
          <h2 id={titleId} className="font-semibold">{label}?</h2>
          <p className="text-muted">
            {action === 'approved'
              ? 'Agents start getting each of them with their task context straight away. Each is recorded as approved by you. If cloud sync is enabled, they are eligible for the next scheduled sync. Approval does not trigger a sync; use Sync now to send them.'
              : 'Agents never get them. They move to Rejected, where you can put any back up for review.'}
          </p>
          <ul aria-label="lessons" className="grid max-h-48 gap-1 overflow-y-auto">
            {lessons.map((l) => <li key={l.id} className="rounded-sm border border-line bg-sunken px-2 py-1 [overflow-wrap:anywhere]">{l.title}</li>)}
          </ul>
          <label className="grid gap-1 text-xs font-medium text-muted">
            Note (optional, kept on each lesson)
            <Input aria-label="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={action === 'rejected' ? 'why, e.g. platitudes' : 'why'} maxLength={4000} />
          </label>
          {error && <Alert>{error}</Alert>}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 rounded-b-md border-t border-line bg-sunken px-4 py-3">
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant={action === 'approved' ? 'primary' : 'danger'} onClick={() => void go()} disabled={busy}>{busy ? 'Saving…' : label}</Button>
        </footer>
      </div>
    </div>
  );
}

const checkLabel = (name: string) => CHECK_LABEL[name as LessonCheckName] ?? name.replace(/-/g, ' ');

/** The lesson check's findings as chips; the reason is the tooltip (and is listed on the lesson itself). */
function CheckChips({ checks, max }: { checks: LessonCheck[]; max?: number }) {
  const shown = max ? checks.slice(0, max) : checks;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((c) => <Badge key={c.name} tone="bad" title={c.why}>{checkLabel(c.name)}</Badge>)}
      {checks.length > shown.length && <Badge title={checks.slice(shown.length).map((c) => checkLabel(c.name)).join(', ')}>+{checks.length - shown.length}</Badge>}
    </span>
  );
}

/** How often everyday coding needs the fact a lesson becomes; everyday is where the scan's rubric starts it. */
const FACT_RELEVANCE: { label: string; value: number }[] = [
  { label: 'everyday: needed in most changes', value: EVERYDAY_FROM },
  { label: 'sometimes: needed for some changes', value: 0.55 },
  { label: 'rare: setup or tooling, served only when the task is about it', value: 0.15 },
];

/**
 * Converting a lesson that states how the code is (not what to do) into a project fact: you pick its kind and how often
 * it is needed. Not a removal, so a plain dialog rather than the red ConfirmDialog.
 */
function ToFactDialog({ lesson, onCancel, onDone }: { lesson: Lesson; onCancel: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<FactKind>('convention');
  const [relevance, setRelevance] = useState(EVERYDAY_FROM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  async function convert() {
    setBusy(true);
    setError(null);
    try {
      await api.lessonToFact(lesson.id, { kind, relevance });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-text/30 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && !busy) onCancel(); }}
        className="w-full max-w-md rounded-md border border-line bg-surface text-[13px] shadow-pop"
      >
        <div className="grid gap-3 p-4">
          <h2 id={titleId} className="font-semibold">Convert this lesson to a project fact?</h2>
          <p className="text-muted">
            Agents get the rule with the project facts, and no scan replaces it. The lesson moves to Rejected, noted
            "converted to a fact".
          </p>
          <blockquote className="rounded-sm border border-line bg-sunken px-2.5 py-2 [overflow-wrap:anywhere]">{lesson.rule}</blockquote>
          <label className="grid gap-1 text-xs font-medium text-muted">
            Kind
            <Select aria-label="fact kind" value={kind} onChange={(e) => setKind(e.target.value as FactKind)}>
              {FACT_KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
            </Select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted">
            How often it is needed
            <Select aria-label="fact relevance" value={String(relevance)} onChange={(e) => setRelevance(Number(e.target.value))}>
              {FACT_RELEVANCE.map((r) => <option key={r.value} value={String(r.value)}>{r.label}</option>)}
            </Select>
          </label>
          {error && <Alert>{error}</Alert>}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 rounded-b-md border-t border-line bg-sunken px-4 py-3">
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void convert()} disabled={busy}>{busy ? 'Converting…' : 'Convert'}</Button>
        </footer>
      </div>
    </div>
  );
}

/** An agent holding the operator token (FG_OPERATOR_TOKEN, with lesson_decide in OPERATOR_ALLOW) decided it, not you. */
function AgentDecided({ lesson }: { lesson: Pick<Lesson, 'status' | 'decidedBy'> }) {
  if (!lesson.decidedBy?.startsWith('operator') || lesson.status === 'proposed') return null;
  return (
    <Badge tone="accent" title={`${lesson.status} by ${lesson.decidedBy} with the operator token, not from this page`}>
      {lesson.status} by agent
    </Badge>
  );
}

const percent = (n: number, of: number) => `${of ? Math.round((100 * n) / of) : 0}%`;
const share = (n: number, of: number) => `${n} (${percent(n, of)})`;
const said = (n: number, what: string, of: number) => `${n} ${what} (${percent(n, of)})`;

/**
 * How you judged the lessons the post-mortem wrote: approved as written, approved after an edit, rejected. The
 * post-mortem learns from the last two (they are shown to it as examples), so this is the number to watch go up.
 * Nothing when none were decided in 90 days or the server cannot tell.
 */
function Judged({ report }: { report: LessonQualityReport | null }) {
  const [last30, last90] = report?.windows ?? [];
  if (!last30 || !last90?.decided) return null;
  const projects = Object.entries(report!.projects ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const cells = (q: LessonQuality | undefined) =>
    q ? [String(q.decided), share(q.asWritten, q.decided), share(q.edited, q.decided), share(q.rejected, q.decided), share(q.byOperator ?? 0, q.decided)] : ['', '', '', '', ''];
  return (
    <details aria-label="how your lessons were judged" className="text-xs text-muted">
      <summary className="cursor-pointer tabular-nums" title="Of the post-mortem's lessons you decided. The ones you edited or rejected, and some you approved as written, are shown to the post-mortem as examples. Decisions an agent made with the operator token count as yours; how many is said apart.">
        {last30.decided
          ? <>Last 30 days: {last30.decided} decided · {said(last30.asWritten, 'as written', last30.decided)} · {said(last30.edited, 'after an edit', last30.decided)} · {said(last30.rejected, 'rejected', last30.decided)}
              {!!last30.byOperator && <> · {said(last30.byOperator, 'by an agent with the operator token', last30.decided)}</>}</>
          : <>Last 30 days: none decided ({last90.decided} in 90 days)</>}
        {report!.capped && ' (capped)'}
      </summary>
      <table className={`${tableClass} mt-2 tabular-nums`}>
        <thead><tr>{['project', 'days', 'decided', 'as written', 'after edit', 'rejected', 'by operator'].map((h) => <th key={h} className={tdClass}>{h}</th>)}</tr></thead>
        <tbody>
          {[['all', report!.windows] as const, ...projects].flatMap(([k, ws]) => ws.map((q) => (
            <tr key={`${k}-${q.days}`}>{[k, `${q.days} days`, ...cells(q)].map((c, i) => <td key={i} className={tdClass}>{c}</td>)}</tr>
          )))}
        </tbody>
      </table>
    </details>
  );
}

export function Lessons() {
  const [judged, setJudged] = useState<LessonQualityReport | null>(null);
  useEffect(() => { api.lessonQuality().then(setJudged, () => setJudged(null)); }, []);
  const [status, setStatus] = useState<LessonStatus>('proposed');
  // Filters the server applies: where the feedback came from, and one check flag.
  const [source, setSource] = useState<LessonFrom | ''>('');
  const [pr, setPr] = useState('');
  const [author, setAuthor] = useState('');
  const [flag, setFlag] = useState<LessonCheckName | ''>('');
  const [items, setItems] = useState<Lesson[]>([]);
  // The rows ticked for a bulk decision (proposed lessons only), and the decision being confirmed.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<'approved' | 'rejected' | null>(null);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<LessonDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [history, setHistory] = useState<Activity[]>([]);
  // Narrowing a global lesson: the project it will serve (it has none to go back to), and the projects to choose from.
  const [narrowTo, setNarrowTo] = useState('');
  const [projectKeys, setProjectKeys] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // On a phone the list and the lesson take turns; this is true while the lesson is showing.
  const [open, setOpen] = useState(false);

  // A link to one lesson (#lessons/<id>, from a module panel) opens it in the tab of its status.
  const [focus] = useState(() => hashFocus('lessons'));
  useEffect(() => {
    if (focus) api.lesson(focus).then((d) => { if (d?.lesson) setStatus(d.lesson.status); }).catch(() => {});
  }, [focus]);

  useEffect(() => {
    setLoaded(false);
    setOpen(false);
    setError(null);
    setPicked(new Set());
    // The answer for a tab you have left must not fill the one you are on.
    let stale = false;
    api.lessons(status, { pr: pr || undefined, author: author || undefined, ...(flag && { flag }), ...(source && { source }) }).then((l) => {
      if (stale) return;
      const sorted = genericLast(l);
      const at = focus ? sorted.findIndex((x) => x.id === focus) : -1;
      setItems(sorted);
      setSelected(Math.max(0, at));
      setOpen(at >= 0);
      setLoaded(true);
    }, (e) => { if (!stale) { setError(String(e)); setLoaded(true); } });
    return () => { stale = true; };
  }, [status, flag, source, pr, author]);

  const current = items[selected];
  useEffect(() => {
    setDetail(null);
    setDraft(null);
    setHistory([]);
    setError(null);
    setNarrowTo('');
    if (!current) return;
    // Answers for a lesson you have moved past are dropped, so you never approve one while reading another.
    let stale = false;
    api.activity({ target: current.id, limit: 50 }).then((h) => { if (!stale) setHistory(h); }, () => {});
    api.lesson(current.id).then((d) => {
      if (stale) return;
      setDetail(d);
      setDraft({ title: d.lesson.title, rule: d.lesson.rule, appliesWhen: d.lesson.appliesWhen, scope: d.lesson.scope });
    }, (e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [current?.id]);

  // Edits live only here until Approve (or Save, on an approved lesson): moving to another lesson, tab or page asks before dropping them.
  const edited = !!detail && !!draft && detail.lesson.id === current?.id &&
    (['title', 'rule', 'appliesWhen', 'scope'] as const).some((k) => draft[k] !== detail.lesson[k]);
  useUnsavedChanges(edited, 'Your edits to this lesson are not saved.');
  const narrowing = !!detail && !!draft && detail.lesson.scope === 'global' && draft.scope !== 'global';
  useEffect(() => {
    if (narrowing && projectKeys === null) api.projects().then((ps) => setProjectKeys(ps.map((p) => p.key)), () => setProjectKeys([]));
  }, [narrowing, projectKeys]);
  /** The edited fields of the draft, with the project a narrowed global lesson serves; null (and why) when it has none. */
  function edits(): LessonEdit | null {
    if (!detail || !draft) return null;
    const patch: LessonEdit = {};
    for (const k of ['title', 'rule', 'appliesWhen', 'scope'] as const) {
      if (draft[k] !== detail.lesson[k]) (patch as Record<string, unknown>)[k] = draft[k];
    }
    if (narrowing) {
      if (!narrowTo) {
        setError('Choose the project this lesson will serve: as a global lesson it has none to go back to.');
        return null;
      }
      patch.projectKey = narrowTo;
    }
    return patch;
  }
  const [revoking, setRevoking] = useState(false);
  const [converting, setConverting] = useState(false);
  useEffect(() => { setRevoking(false); setConverting(false); }, [current?.id]);

  /** The lesson became a fact (and was rejected): it leaves this tab like any decision. */
  function converted() {
    if (!current) return;
    setConverting(false);
    setItems((xs) => xs.filter((x) => x.id !== current.id));
    setSelected((i) => Math.min(i, items.length - 2));
  }

  // Edits to an approved lesson are saved as they are: no status change, so agents keep getting it (now as edited).
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!current || !detail || !draft || detail.lesson.id !== current.id) return;
    setError(null);
    const patch = edits();
    if (!patch) return;
    setSaving(true);
    try {
      await api.updateLesson(current.id, patch);
      setDetail({ ...detail, lesson: { ...detail.lesson, ...patch } });
      setItems((xs) => xs.map((x) => (x.id === current.id ? { ...x, ...patch } : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /** The bulk decision went through: the decided lessons leave this tab; any that failed say why. */
  function bulkDone(results: { id: string; ok: boolean; error?: string }[]) {
    setBulk(null);
    const done = new Set(results.filter((r) => r.ok).map((r) => r.id));
    const failed = results.filter((r) => !r.ok);
    const at = current?.id;
    const rest = items.filter((x) => !done.has(x.id));
    setItems(rest);
    setPicked(new Set(failed.map((r) => r.id)));
    const keep = at ? rest.findIndex((x) => x.id === at) : -1;
    setSelected(keep >= 0 ? keep : Math.max(0, Math.min(selected, rest.length - 1)));
    setError(failed.length ? `${plural(failed.length, 'lesson')} could not be decided (still selected): ${failed.map((r) => `${r.id}: ${r.error ?? 'failed'}`).join('; ')}` : null);
  }
  const pickedLessons = items.filter((l) => picked.has(l.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  /** The flags on the lessons listed, with how many carry each: what "select all with flag" offers. */
  const flagCounts = LESSON_CHECKS.map((n) => [n, items.filter((l) => l.checks?.some((c) => c.name === n)).length] as const).filter(([, c]) => c > 0);
  const bulkable = status === 'proposed' && items.length > 0;
  // Deciding the lesson open with unsaved edits drops them: ask first, as moving away does.
  const openBulk = (action: 'approved' | 'rejected') => (current && picked.has(current.id) ? afterDiscard(() => setBulk(action)) : setBulk(action));

  async function decide(next: 'approved' | 'rejected' | 'revoked' | 'proposed') {
    if (!current || !detail || !draft || detail.lesson.id !== current.id) return;
    setError(null);
    let patch: LessonEdit = { status: next };
    if (next === 'approved') {
      const changed = edits();
      if (!changed) return;
      patch = { ...patch, ...changed };
    }
    try {
      await api.updateLesson(current.id, patch);
      setItems((xs) => xs.filter((x) => x.id !== current.id));
      setSelected((i) => Math.min(i, items.length - 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Lessons" description="Rules drawn from confirmed misses. Agents only ever see the ones you approve." actions={<Judged report={judged} />} />
      <SplitPane
        listLabel="lessons"
        listWidth="24rem"
        listHeader={
          <>
            <Tabs label="status" value={status} options={TABS} onChange={(s) => { if (s !== status) afterDiscard(() => setStatus(s)); }} />
            {loaded && <span className="ml-auto text-xs text-muted tabular-nums">{plural(items.length, 'lesson')}</span>}
            <div className="flex w-full flex-wrap gap-2">
              <Input aria-label="PR number" placeholder="PR number" type="number" min="1" value={pr} onChange={(e) => { const value = e.target.value; afterDiscard(() => setPr(value)); }} />
              <Input aria-label="feedback author" placeholder="Feedback author" value={author} onChange={(e) => { const value = e.target.value; afterDiscard(() => setAuthor(value)); }} />
              <Select aria-label="source" size="sm" value={source} onChange={(e) => { const v = e.target.value as LessonFrom | ''; afterDiscard(() => setSource(v)); }}>
                <option value="">all sources</option>
                {LESSON_FROM.map((f) => <option key={f} value={f}>{SOURCE_LABEL[f]?.[0] ?? f}</option>)}
              </Select>
              <Select aria-label="flag" size="sm" value={flag} onChange={(e) => { const v = e.target.value as LessonCheckName | ''; afterDiscard(() => setFlag(v)); }}>
                <option value="">any check</option>
                {LESSON_CHECKS.map((n) => <option key={n} value={n}>{checkLabel(n)}</option>)}
              </Select>
            </div>
            {bulkable && (
              <div className="flex w-full flex-wrap items-center gap-2">
                <Select
                  aria-label="select all with flag"
                  size="sm"
                  value=""
                  onChange={(e) => {
                    const n = e.target.value;
                    if (n) setPicked((p) => new Set([...p, ...items.filter((l) => l.checks?.some((c) => c.name === n)).map((l) => l.id)]));
                  }}
                >
                  <option value="">select all with flag…</option>
                  {flagCounts.map(([n, c]) => <option key={n} value={n}>{checkLabel(n)} ({c})</option>)}
                </Select>
                <Button size="sm" className="min-w-[5.5rem]" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((l) => l.id)))}>
                  {picked.size === items.length ? 'Clear' : 'Select all'}
                </Button>
                {/* Always there, disabled until a row is ticked: the bar never grows, so the rows never move under the cursor. */}
                <span className="min-w-[5.5rem] text-xs text-muted tabular-nums">{picked.size ? `${picked.size} selected` : 'none selected'}</span>
                <Button size="sm" variant="primary" disabled={!picked.size} onClick={() => openBulk('approved')}>Approve selected</Button>
                <Button size="sm" disabled={!picked.size} onClick={() => openBulk('rejected')}>Reject selected</Button>
              </div>
            )}
            {loaded && items.length >= LIST_CAP && <span className="w-full text-xs text-muted">Showing the newest {LIST_CAP}: narrow the list with the filters to reach the rest.</span>}
            {bulk && <BulkDialog action={bulk} lessons={pickedLessons} onCancel={() => setBulk(null)} onDone={bulkDone} />}
          </>
        }
        detailOpen={open && items.length > 0}
        onBack={() => setOpen(false)}
        notice={error && <Alert>{error}</Alert>}
        list={
          !loaded ? <SkeletonList /> : items.length === 0 ? (
            source || flag || pr || author ? (
              <EmptyState compact icon={<LessonIcon />} title={`No ${status} lessons match this filter`} action={<Button size="sm" onClick={() => afterDiscard(() => { setSource(''); setFlag(''); setPr(''); setAuthor(''); })}>Clear filters</Button>}>
                {`Other ${status} lessons may come from another source or carry other checks.`}
              </EmptyState>
            ) : <EmptyState compact icon={<LessonIcon />} {...EMPTY[status]} />
          ) : (
            <ul>
              {items.map((l, i) => (
                <li key={l.id} className="flex">
                  {bulkable && (
                    <label className="grid shrink-0 cursor-pointer place-items-start border-b border-line pt-3 pl-3">
                      <input type="checkbox" aria-label={`select ${l.title}`} checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
                    </label>
                  )}
                  <div className="min-w-0 flex-1">
                  <ListRow selected={i === selected} onClick={() => { const go = () => { setSelected(i); setOpen(true); }; if (i === selected) go(); else afterDiscard(go); }}>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="truncate">{l.projectKey ?? 'global'} · <SourceLabel source={l.from ?? l.source} /></span>
                      {l.cause && (
                        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
                          <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE_FILL[causeTone(l.cause)]}`} />
                          <span className="truncate">{causeLabel(l.cause)}</span>
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug">{l.title}</div>
                    {!!l.checks?.length && <div className="mt-1"><CheckChips checks={l.checks} max={3} /></div>}
                    {genericOf(l) && <div className="mt-1 text-xs text-muted">{genericOf(l)!.why}</div>}
                    {l.decidedBy?.startsWith('operator') && l.status !== 'proposed' && <div className="mt-1"><AgentDecided lesson={l} /></div>}
                    {l.decisionNote && l.status !== 'proposed' && <div className="mt-1 text-xs text-muted">{l.decisionNote}</div>}
                  </ListRow>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      >
        <div className="flex min-h-full flex-col">
          <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-5 md:px-6">
            {error && <Alert className="mb-4">{error}</Alert>}
            {detail && draft ? (
              <div className="flex min-w-0 flex-col gap-5">
                <header className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge>{detail.lesson.projectKey ?? 'global'}</Badge>
                    <StatusBadge status={detail.lesson.status} />
                    <AgentDecided lesson={detail.lesson} />
                    {detail.lesson.decisionNote && detail.lesson.status !== 'proposed' && <Badge title="the note on its last decision">{detail.lesson.decisionNote}</Badge>}
                  </div>
                  <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">{detail.lesson.title}</h2>
                </header>

                {!!detail.lesson.checks?.length && (
                  <section aria-label="what the lesson check found" className="grid gap-1.5 rounded-md border border-line bg-sunken px-3 py-2.5">
                    <SectionLabel>{detail.lesson.status === 'proposed' ? 'Before you approve' : 'What the lesson check found'}</SectionLabel>
                    <ul className="grid gap-1">
                      {detail.lesson.checks.map((c) => (
                        <li key={c.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
                          <Badge tone="bad">{checkLabel(c.name)}</Badge>
                          <span className="min-w-0 text-muted [overflow-wrap:anywhere]">{c.why}</span>
                        </li>
                      ))}
                    </ul>
                    {detail.lesson.status === 'proposed' && detail.lesson.checks.some((c) => c.name === 'looks-like-a-fact') && (
                      <p className="text-xs text-muted">If it is how the code is, convert it to a project fact (below) instead of approving it as a rule.</p>
                    )}
                  </section>
                )}

                {detail.feedback && (
                  <section className="grid gap-1.5">
                    <SectionLabel>{feedbackSpeaker(detail.feedback.external)}</SectionLabel>
                    <blockquote className="rounded-md border border-accent bg-accent-soft px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] shadow-[inset_3px_0_0_var(--color-accent)]">
                      {detail.feedback.text}
                    </blockquote>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      {detail.feedback.external ? (
                        <>
                          {detail.feedback.external.reviewState && (
                            // The review's verdict on the pull request, not a decision on this lesson: neutral, never green.
                            <span className="rounded-sm border border-line px-1.5 py-0.5">review: {detail.feedback.external.reviewState.toLowerCase().replace('_', ' ')}</span>
                          )}
                          {detail.feedback.external.url && (
                            <a href={detail.feedback.external.url} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:text-text">
                              on {detail.feedback.external.source === 'github' ? 'GitHub' : 'Linear'}
                            </a>
                          )}
                          <span className="min-w-0 [overflow-wrap:anywhere]">likely session <span className="font-mono">{detail.feedback.sessionId}</span></span>
                        </>
                      ) : (
                        <span className="min-w-0 [overflow-wrap:anywhere]">session <span className="font-mono">{detail.feedback.sessionId}</span></span>
                      )}
                      <StatusBadge status={detail.feedback.status} />
                    </div>
                  </section>
                )}

                {detail.miss && (
                  <section className="grid gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <SectionLabel>What was missed</SectionLabel>
                      <CauseBadge cause={detail.miss.cause} />
                    </div>
                    <p className="text-[13.5px] [overflow-wrap:anywhere]">{detail.miss.missed}</p>
                    <p className="text-muted">{detail.miss.causeExplanation}</p>
                  </section>
                )}

                {detail.contextItems.length > 0 && (
                  <Card title="Context that would have prevented it">
                    <ul>
                      {detail.contextItems.map((c) => (
                        <li key={`${c.kind}:${c.ref}`} className="grid gap-1.5 border-b border-line px-3 py-2.5 last:border-b-0">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="min-w-0 font-mono [overflow-wrap:anywhere] text-accent-text">{c.kind} · {c.ref}</span>
                            <Badge tone={c.wasAvailable ? 'bad' : 'neutral'}>{c.wasAvailable ? 'was available to the agent' : 'not loaded in the session'}</Badge>
                          </div>
                          <pre className="overflow-x-auto rounded-sm bg-sunken px-2.5 py-2 font-mono text-xs whitespace-pre-wrap">{c.excerpt}</pre>
                          <p className="text-xs text-muted">{c.why}</p>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}

                {detail.fixCommits.length > 0 && (
                  <Card title="Fix commits">
                    <table className={tableClass}>
                      <tbody>
                        {detail.fixCommits.map((c) => (
                          <tr key={c.sha} className="last:[&>td]:border-b-0">
                            <td className={`${tdClass} w-20 font-mono text-xs text-accent-text`}>{c.sha.slice(0, 7)}</td>
                            <td className={tdClass}>{c.subject}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}

                <Card title="Lesson for future agents" bodyClass="grid gap-3 p-3">
                  <Field label="Title">
                    <Input aria-label="title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="w-full" />
                  </Field>
                  <Field label="Rule">
                    <Textarea aria-label="rule" value={draft.rule} onChange={(e) => setDraft({ ...draft, rule: e.target.value })} rows={3} className="w-full" />
                  </Field>
                  <Field label="Applies when">
                    <Input aria-label="applies when" value={draft.appliesWhen} onChange={(e) => setDraft({ ...draft, appliesWhen: e.target.value })} placeholder="applies when…" className="w-full" />
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted">Scope</span>
                    <Select aria-label="scope" size="sm" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as Draft['scope'] })}>
                      <option value="task">task</option>
                      <option value="project">project</option>
                      <option value="global">global</option>
                    </Select>
                    {narrowing && (
                      <Select aria-label="project" size="sm" value={narrowTo} onChange={(e) => setNarrowTo(e.target.value)}>
                        <option value="">choose a project…</option>
                        {(projectKeys ?? []).map((k) => <option key={k} value={k}>{k}</option>)}
                      </Select>
                    )}
                    <span className="text-xs text-muted">{narrowing ? 'a global lesson has no project of its own: choose the one it serves' : 'prefer the narrowest scope the evidence supports'}</span>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-xs font-medium text-muted">Paths (agents get it when they edit these)</span>
                    {detail.lesson.paths.length
                      ? <ul className="flex flex-wrap gap-1">{detail.lesson.paths.map((p) => <li key={p}><code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] [overflow-wrap:anywhere]">{p}</code></li>)}</ul>
                      : <span className="text-xs text-muted">No paths: applies anywhere in its project{detail.lesson.scope === 'global' ? ' (or any project, as a global lesson)' : ''}.</span>}
                  </div>
                </Card>

                {history.length > 0 && (
                  <Card title="History">
                    <ul>{history.map((a) => <ActivityEntry key={a.id} a={a} />)}</ul>
                  </Card>
                )}
              </div>
            ) : current ? (
              <SkeletonDetail />
            ) : null}
          </div>
          {detail && draft && status !== 'superseded' && (
            <div className="sticky bottom-0 border-t border-line bg-surface/95 backdrop-blur">
              <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 py-2.5 md:px-6">
                {status === 'proposed' && (
                  <>
                    <Button variant="primary" onClick={() => decide('approved')}>Approve</Button>
                    <Button onClick={() => decide('rejected')}>Reject</Button>
                    <Button
                      onClick={() => setConverting(true)}
                      disabled={edited}
                      title={edited ? 'save or undo your edits first: the fact takes the saved rule' : 'file the rule as a project fact you wrote, and reject the lesson'}
                    >
                      Convert to fact
                    </Button>
                    {converting && <ToFactDialog lesson={detail.lesson} onCancel={() => setConverting(false)} onDone={converted} />}
                    <span className="text-xs text-muted">Approve saves your edits above. If cloud sync is enabled, approval is shared on the next scheduled sync. Approval does not trigger a sync; use Sync now to send it.</span>
                  </>
                )}
                {status === 'approved' && (
                  <>
                    <Button variant="primary" disabled={!edited || saving} onClick={() => void save()}>Save</Button>
                    <Button variant="danger-outline" onClick={() => setRevoking(true)}>Revoke</Button>
                    <ConfirmDialog
                      open={revoking}
                      title="Revoke this lesson?"
                      confirmLabel="Revoke lesson"
                      items={[detail.lesson.title]}
                      onCancel={() => setRevoking(false)}
                      onConfirm={() => { setRevoking(false); void decide('revoked'); }}
                    >
                      Agents stop getting it straight away. It moves to Revoked, where you can put it back up for review.
                    </ConfirmDialog>
                    <span className="text-xs text-muted">Save keeps it approved with your edits. Revoke and agents stop getting it straight away.</span>
                  </>
                )}
                {(status === 'rejected' || status === 'revoked') && <Button onClick={() => decide('proposed')}>Back to proposed</Button>}
              </div>
            </div>
          )}
        </div>
      </SplitPane>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <span aria-hidden="true" className="text-xs font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

/** Whose words the feedback is: yours, or a reviewer's or commenter's on GitHub or Linear. */
function feedbackSpeaker(ext: { source: string; author: string } | null | undefined): string {
  if (!ext) return 'You said';
  const who = ext.author || (ext.source === 'github' ? 'The reviewer' : 'The commenter');
  return `${who} said`;
}
