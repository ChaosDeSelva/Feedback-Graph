import { asIs, labelOf } from './labels.ts';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ActivityEntry } from './Activity.tsx';
import { LessonDecisions } from './Decisions.tsx';
import { isLoopActor } from './loop.ts';
import { READ_ONLY_TITLE, useOwnerWrites } from './ownerAccess.tsx';
import { hashFocus, hashFilters, saveHashFilters } from './links.ts';
import type { FactKind, LessonCheck, LessonCheckName, LessonFrom, LessonTriggers } from '@fb/core';
import { FACT_KINDS, LESSON_CHECKS, LESSON_FROM } from '@fb/core/types';
import { EVERYDAY_FROM } from '@fb/core/relevance';
import { api, type Activity, type Lesson, type LessonDetail, type LessonEdit, type LessonQuality, type LessonQualityReport, type LessonStatus, errorMessage } from './api.ts';
import { afterDiscard, useUnsavedChanges } from './unsaved.ts';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { Modal } from './ui/Modal.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { byScore, ScoreChip } from './ui/ScoreChip.tsx';
import { Button, FilterBar, Input, Select, Tabs, Textarea, usePending } from './ui/controls.tsx';
import { Alert, Badge, Card, CauseBadge, causeLabel, causeTone, EmptyState, plural, SectionLabel, SkeletonDetail, SkeletonList, StatusBadge, tableClass, tdClass, TONE_FILL } from './ui/display.tsx';
import { LessonIcon } from './ui/icons.tsx';
import { ScrollArea } from './ui/ScrollArea.tsx';
import { rendered } from './ui/focus.ts';

const TABS: LessonStatus[] = ['proposed', 'approved', 'rejected', 'revoked', 'superseded'];

/** The lesson check's generic flag (a rule naming nothing concrete), if it has one. */
const genericOf = (l: Lesson) => l.checks?.find((c) => c.name === 'generic');
/** Generic lessons last (the rest keep their order): the owner reaches the concrete ones first. */
const genericLast = (ls: Lesson[]) => [...ls.filter((l) => !genericOf(l)), ...ls.filter((l) => genericOf(l))];

/** A lesson's triggers as edited: one per line in each box. */
type TriggerText = { paths: string; patterns: string; symbols: string };
const TRIGGER_KINDS = ['paths', 'patterns', 'symbols'] as const;
const triggerText = (t: LessonTriggers | null | undefined): TriggerText => ({ paths: (t?.paths ?? []).join('\n'), patterns: (t?.patterns ?? []).join('\n'), symbols: (t?.symbols ?? []).join('\n') });
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const triggersOf = (t: TriggerText): LessonTriggers => ({ paths: lines(t.paths), patterns: lines(t.patterns), symbols: lines(t.symbols) });
/** Whether the boxes say what the lesson has (blank lines and spaces aside). */
const sameTriggers = (t: TriggerText, l: Lesson) => TRIGGER_KINDS.every((k) => triggersOf(t)[k].join('\n') === (l.triggers?.[k] ?? []).join('\n'));

type Draft = Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope'> & { triggers: TriggerText; paths: string };
const draftOf = (l: Lesson): Draft => ({ title: l.title, rule: l.rule, appliesWhen: l.appliesWhen, scope: l.scope, triggers: triggerText(l.triggers), paths: l.paths.join('\n') });
/** Whether the paths box says what the lesson has (blank lines and spaces aside). */
const samePaths = (d: Draft, l: Lesson) => lines(d.paths).join('\n') === l.paths.join('\n');
/** The flags about a lesson's paths: paths the server checked against the code map settle them. */
const PATH_FLAGS: readonly string[] = ['needs-path', 'bad-path', 'non-repo-path', 'path-missing', 'ambiguous-path'];

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
  'instance-applies-when': '"applies when" too narrow',
  'example-applies-when': '"applies when" copied from an example',
  'off-turn': 'needs review: not about the flagged turn',
  'may-hold-secret': 'may hold a secret',
  'risky-command': 'runs a risky command',
  'broad-trigger': 'trigger fires repo-wide',
  'code-changed': 'its code changed',
};
/** Where a lesson came from, in words; the tooltip says it in full. `from` (where its feedback came from) first. */
const SOURCE_LABEL: Record<LessonFrom | Lesson['source'], [label: string, title: string]> = {
  github: ['GitHub review', 'from a GitHub pull request comment or review, through a post-mortem'],
  linear: ['Linear comment', 'from a Linear issue comment, through a post-mortem'],
  session: ['session pushback', 'from your pushback in an agent session, through a post-mortem'],
  agent: ['agent report', 'a miss your coding agent reported (report_feedback), through a post-mortem'],
  postmortem: ['post-mortem', 'from a post-mortem'],
  memory: ['memory file', 'imported from a Claude Code memory file'],
  manual: ['by you', 'written by you'],
  demo: ['demo', 'a demo lesson from fg demo seed; fg demo remove takes it back'],
};
function SourceLabel({ source }: { source: LessonFrom | Lesson['source'] }) {
  const [label, title] = labelOf(SOURCE_LABEL, source, (raw) => [raw, raw]);
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
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal labelledBy={titleId} busy={busy} onCancel={onCancel}>
      <div className="grid gap-3 p-4">
        <h2 id={titleId} className="font-semibold">{label}?</h2>
        <p className="text-muted">
          {action === 'approved'
            ? 'Agents start getting each of them with their task context straight away. Each is recorded as approved by you. If cloud sync is enabled, they are eligible for the next scheduled sync. Approval does not trigger a sync; use Sync now to send them.'
            : 'Agents never get them. They move to Rejected, where you can put any back up for review.'}
        </p>
        <ScrollArea as="ul" aria-label="lessons" className="grid max-h-48 gap-1 overflow-y-auto">
          {lessons.map((l) => <li key={l.id} className="rounded-sm border border-line bg-sunken px-2 py-1 [overflow-wrap:anywhere]">{l.title}</li>)}
        </ScrollArea>
        <label className="grid gap-1 text-xs font-medium text-muted">
          Note (optional, kept on each lesson)
          <Input data-autofocus aria-label="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={action === 'rejected' ? 'why, e.g. platitudes' : 'why'} maxLength={4000} />
        </label>
        {error && <Alert>{error}</Alert>}
      </div>
      <footer className="flex flex-wrap justify-end gap-2 rounded-b-md border-t border-line bg-sunken px-4 py-3">
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant={action === 'approved' ? 'primary' : 'danger'} owner onClick={() => void go()} busy={busy}>{busy ? 'Saving…' : label}</Button>
      </footer>
    </Modal>
  );
}

const checkLabel = (name: LessonCheckName) => labelOf(CHECK_LABEL, name, (raw) => raw.replace(/-/g, ' '));

/** The lesson check's findings as chips; the reason is the tooltip (and is listed on the lesson itself). */
function CheckChips({ checks, max }: { checks: LessonCheck[]; max: number }) {
  const shown = checks.slice(0, max);
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
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal labelledBy={titleId} busy={busy} onCancel={onCancel}>
      <div className="grid gap-3 p-4">
        <h2 id={titleId} className="font-semibold">Convert this lesson to a project fact?</h2>
        <p className="text-muted">
          Agents get the rule with the project facts, and no scan replaces it. The lesson moves to Rejected, noted
          "converted to a fact".
        </p>
        <blockquote className="rounded-sm border border-line bg-sunken px-2.5 py-2 [overflow-wrap:anywhere]">{lesson.rule}</blockquote>
        <label className="grid gap-1 text-xs font-medium text-muted">
          Kind
          <Select data-autofocus aria-label="fact kind" value={kind} onChange={(e) => setKind(e.target.value as FactKind)}>
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
        <Button variant="primary" owner onClick={() => void convert()} busy={busy}>{busy ? 'Converting…' : 'Convert'}</Button>
      </footer>
    </Modal>
  );
}

/**
 * The learning loop changed the lesson and that change stands: a loop decision on it is still applied (changedByLoop: a
 * reword, narrowing or re-ranking leaves decidedBy as it was), or the loop decided its status (decidedBy `loop:<v>`). Its
 * Decisions card says what and can undo it.
 */
const changedByLoop = (l: Pick<Lesson, 'decidedBy' | 'changedByLoop'>) => !!l.changedByLoop || isLoopActor(l.decidedBy);
function ChangedByLoop({ lesson }: { lesson: Pick<Lesson, 'decidedBy' | 'changedByLoop'> }) {
  if (!changedByLoop(lesson)) return null;
  return <Badge tone="accent" title="changed by the learning loop; its Decisions card says what and can roll it back">changed by loop</Badge>;
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
  if (!last30 || !(last90?.decided || last90?.byOperator)) return null;
  const projects = Object.entries(report!.projects).sort(([a], [b]) => a.localeCompare(b));
  const cells = (q: LessonQuality) =>
    [String(q.decided), share(q.asWritten, q.decided), share(q.edited, q.decided), share(q.rejected, q.decided), String(q.byOperator ?? 0)];
  return (
    <details aria-label="how your lessons were judged" className="min-w-0 text-xs text-muted">
      <summary className="cursor-pointer tabular-nums" title="Of the post-mortem's lessons you decided. The ones you edited or rejected, and some you approved as written, are shown to the post-mortem as examples. Decisions an agent made with the operator token are not yours: they are counted apart and never shown to the post-mortem.">
        {last30.decided
          ? <>Last 30 days: {last30.decided} decided · {said(last30.asWritten, 'as written', last30.decided)} · {said(last30.edited, 'after an edit', last30.decided)} · {said(last30.rejected, 'rejected', last30.decided)}
              {!!last30.byOperator && <> · and {last30.byOperator} more by an agent with the operator token, not counted</>}</>
          : <>Last 30 days: none decided ({last90.decided} in 90 days){!!last30.byOperator && <>, {last30.byOperator} by an agent with the operator token</>}</>}
        {report!.capped && ' (capped)'}
      </summary>
      <ScrollArea role="region" className="mt-2 max-w-full overflow-x-auto" aria-label="Lesson decision quality table">
      <table className={`${tableClass} tabular-nums`}>
        <thead><tr>{['project', 'days', 'decided', 'as written', 'after edit', 'rejected', 'by operator'].map((h) => <th key={h} className={tdClass}>{h}</th>)}</tr></thead>
        <tbody>
          {[['all', report!.windows] as const, ...projects].flatMap(([k, ws]) => ws.map((q) => (
            <tr key={`${k}-${q.days}`}>{[k, `${q.days} days`, ...cells(q)].map((c, i) => <td key={i} className={tdClass}>{c}</td>)}</tr>
          )))}
        </tbody>
      </table>
      </ScrollArea>
    </details>
  );
}

export function Lessons() {
  const writes = useOwnerWrites();
  /** On a read-only install the lesson's words show as text to read: nothing could save an edit. */
  const locked = writes ? {} : { readOnly: true, title: READ_ONLY_TITLE };
  const [judged, setJudged] = useState<LessonQualityReport | null>(null);
  useEffect(() => { api.lessonQuality().then(setJudged, () => setJudged(null)); }, []);
  const [status, setStatus] = useState<LessonStatus>(() => ['proposed', 'approved', 'rejected', 'revoked', 'superseded'].includes(hashFilters().get('status') ?? '') ? hashFilters().get('status') as LessonStatus : 'proposed');
  // Filters the server applies: where the feedback came from, and one check flag.
  const [source, setSource] = useState<LessonFrom | ''>(() => (hashFilters().get('source') ?? '') as LessonFrom | '');
  const [pr, setPr] = useState(() => (hashFilters().get('pr') ?? '') as string);
  const [author, setAuthor] = useState(() => (hashFilters().get('author') ?? '') as string);
  const [flag, setFlag] = useState<LessonCheckName | ''>(() => (hashFilters().get('flag') ?? '') as LessonCheckName | '');
  const [sortBy, setSortBy] = useState<'' | 'score'>(() => (hashFilters().get('sort') === 'score' ? 'score' : ''));

  useEffect(() => saveHashFilters('lessons', { status, pr, author, source, flag, sort: sortBy }), [status, pr, author, source, flag, sortBy]);
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
      // By approve score (highest first), else the concrete lessons before the generic ones.
      const sorted = sortBy === 'score' ? [...l].sort(byScore) : genericLast(l);
      const at = focus ? sorted.findIndex((x) => x.id === focus) : -1;
      setItems(sorted);
      setSelected(focus && at < 0 ? -1 : Math.max(0, at));
      setOpen(at >= 0);
      setLoaded(true);
    }, (e) => { if (!stale) { setError(errorMessage(e)); setLoaded(true); } });
    return () => { stale = true; };
  }, [status, flag, source, pr, author, sortBy]);

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
      setDraft(draftOf(d.lesson));
    }, (e) => { if (!stale) setError(errorMessage(e)); });
    return () => { stale = true; };
  }, [current?.id]);

  // Edits live only here until Approve (or Save, on an approved lesson): moving to another lesson, tab or page asks before dropping them.
  const edited = !!detail && !!draft && detail.lesson.id === current?.id &&
    ((['title', 'rule', 'appliesWhen', 'scope'] as const).some((k) => draft[k] !== detail.lesson[k]) || !sameTriggers(draft.triggers, detail.lesson) || !samePaths(draft, detail.lesson));
  useUnsavedChanges(edited, 'Your edits to this lesson are not saved.');
  const narrowing = !!detail && !!draft && detail.lesson.scope === 'global' && draft.scope !== 'global';
  useEffect(() => {
    if (narrowing && projectKeys === null) api.projects().then((ps) => setProjectKeys(ps.map((p) => p.key)), () => setProjectKeys([]));
  }, [narrowing, projectKeys]);
  /** The edited fields of the draft, with the project a narrowed global lesson serves; null (and why) when it has none. */
  // These run from the open lesson's own buttons, which show only once its detail and draft are loaded (React runs
  // the effect that clears them for another lesson before it handles the next click).
  function edits(): LessonEdit | null {
    const patch: LessonEdit = {};
    for (const k of ['title', 'rule', 'appliesWhen', 'scope'] as const) {
      if (draft![k] !== detail!.lesson[k]) (patch as Record<string, unknown>)[k] = draft![k];
    }
    if (!sameTriggers(draft!.triggers, detail!.lesson)) patch.triggers = triggersOf(draft!.triggers);
    if (!samePaths(draft!, detail!.lesson)) patch.paths = lines(draft!.paths);
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
  // Why you decide: kept as the lesson's decision note with Approve, Reject, Save, Revoke or Back to proposed.
  const [note, setNote] = useState('');
  useEffect(() => { setRevoking(false); setConverting(false); setNote(''); }, [current?.id]);

  /** The lesson became a fact (and was rejected): it leaves this tab like any decision. */
  function converted() {
    const { id } = current!;
    setConverting(false);
    setItems((xs) => xs.filter((x) => x.id !== id));
    setSelected((i) => Math.min(i, items.length - 2));
  }

  // Edits to an approved lesson are saved as they are: no status change, so agents keep getting it (now as edited).
  const [saving, setSaving] = useState(false);
  async function save() {
    const lesson = detail!.lesson;
    setError(null);
    const patch = edits();
    if (!patch) return;
    setSaving(true);
    try {
      await api.updateLesson(lesson.id, { ...patch, ...(note.trim() && { note: note.trim() }) });
      const saved = { ...lesson, ...patch, ...(patch.paths?.length && { checks: lesson.checks?.filter((c) => !PATH_FLAGS.includes(c.name)) ?? null }) };
      setDetail({ ...detail!, lesson: saved });
      setItems((xs) => xs.map((x) => (x.id === lesson.id ? saved : x)));
      setNote('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  /** A loop decision on this lesson was rolled back: it may now belong in another tab. */
  function reloadAfterRollback() {
    if (!current) return;
    api.lesson(current.id).then((d) => {
      if (d.lesson.status !== status) {
        setItems((xs) => xs.filter((x) => x.id !== current.id));
        setSelected((i) => Math.min(i, items.length - 2));
      } else {
        setDetail(d);
        setDraft(draftOf(d.lesson));
      }
    }, (e) => setError(errorMessage(e)));
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
    const displayedFailures = failed.slice(0, 3);
    setError(failed.length ? `${plural(failed.length, 'lesson')} could not be decided (still selected): ${displayedFailures.map((r) => `${r.id}: ${r.error ?? 'failed'}`).join('; ')}${failed.length > displayedFailures.length ? `; and ${failed.length - displayedFailures.length} more` : ''}` : null);
  }
  const pickedLessons = items.filter((l) => picked.has(l.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  /** The flags on the lessons listed, with how many carry each: what "select all with flag" offers. */
  const flagCounts = LESSON_CHECKS.map((n) => [n, items.filter((l) => l.checks?.some((c) => c.name === n)).length] as const).filter(([, c]) => c > 0);
  const bulkable = status === 'proposed' && items.length > 0;
  // Deciding the lesson open with unsaved edits drops them: ask first, as moving away does.
  const openBulk = (action: 'approved' | 'rejected') => (current && picked.has(current.id) ? afterDiscard(() => setBulk(action)) : setBulk(action));

  // One decision at a time: while it saves, every decision button says so and ignores presses.
  const [deciding, runDecision] = usePending<'approved' | 'rejected' | 'revoked' | 'proposed'>();
  // A decision made from the keyboard: its button leaves with the lesson, so focus goes to the next lesson's row (or, with
  // none left, the list saying so; on a phone showing the next lesson, that lesson) instead of dropping to the page.
  const page = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || !page.current) return;
    refocus.current = false;
    const at = page.current;
    const target = [at.querySelector('aside [aria-current="true"]'), at.querySelector('aside [role="region"]'), at.querySelector('section[aria-label="item detail"]')]
      .find((x): x is HTMLElement => x instanceof HTMLElement && rendered(x, at));
    if (!target) return;
    if (!target.matches('button') && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus();
  }, [items]);
  async function decide(next: 'approved' | 'rejected' | 'revoked' | 'proposed') {
    const { id } = detail!.lesson;
    const fromBar = !!bar.current?.contains(document.activeElement);
    let patch: LessonEdit = { status: next, ...(note.trim() && { note: note.trim() }) };
    if (next === 'approved') {
      const changed = edits();
      if (!changed) return;
      patch = { ...patch, ...changed };
    }
    await runDecision(next, async () => {
      setError(null);
      try {
        await api.updateLesson(id, patch);
        refocus.current = fromBar && !!bar.current?.contains(document.activeElement);
        setItems((xs) => xs.filter((x) => x.id !== id));
        setSelected((i) => Math.min(i, items.length - 2));
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  return (
    <div ref={page} className="flex h-full min-h-0 flex-col">
      <PageHeader title="Lessons" description="Rules drawn from confirmed misses. Agents only ever see the ones you approve." actions={<Judged report={judged} />} />
      <SplitPane
        listLabel="lessons"
        listWidth="24rem"
        listHeader={
          <>
            <Tabs label="status" value={status} options={TABS} onChange={(s) => { if (s !== status) afterDiscard(() => setStatus(s)); }} />
            {loaded && <span className="ml-auto text-xs text-muted tabular-nums">{plural(items.length, 'lesson')}</span>}
            <FilterBar label="filters">
              <Input aria-label="PR number" size="sm" placeholder="PR number" type="number" min="1" value={pr} onChange={(e) => { const value = e.target.value; afterDiscard(() => setPr(value)); }} />
              <Input aria-label="feedback author" size="sm" placeholder="Feedback author" value={author} onChange={(e) => { const value = e.target.value; afterDiscard(() => setAuthor(value)); }} />
              {author && <span className="col-span-full text-[11px] text-muted">Exact match; use the full GitHub or Linear login.</span>}
              <Select aria-label="source" size="sm" value={source} onChange={(e) => { const v = e.target.value as LessonFrom | ''; afterDiscard(() => setSource(v)); }}>
                <option value="">all sources</option>
                {LESSON_FROM.map((f) => <option key={f} value={f}>{SOURCE_LABEL[f][0]}</option>)}
              </Select>
              <Select aria-label="flag" size="sm" value={flag} onChange={(e) => { const v = e.target.value as LessonCheckName | ''; afterDiscard(() => setFlag(v)); }}>
                <option value="">any check</option>
                {LESSON_CHECKS.map((n) => <option key={n} value={n}>{checkLabel(n)}</option>)}
              </Select>
              <Select aria-label="order" size="sm" value={sortBy} onChange={(e) => { const v = e.target.value as '' | 'score'; afterDiscard(() => setSortBy(v)); }}>
                <option value="">newest first</option>
                <option value="score">approve score</option>
              </Select>
            </FilterBar>
            {bulkable && (
              <FilterBar label="bulk decisions">
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
                <Button size="sm" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((l) => l.id)))}>
                  {picked.size === items.length ? 'Clear' : 'Select all'}
                </Button>
                {/* Always there, disabled until a row is ticked: the bar never grows, so the rows never move under the cursor. */}
                <span className="text-xs text-muted tabular-nums">{picked.size ? `${picked.size} selected` : 'none selected'}</span>
                <Button size="sm" variant="primary" owner disabled={!picked.size} onClick={() => openBulk('approved')}>Approve selected</Button>
                <Button size="sm" owner disabled={!picked.size} onClick={() => openBulk('rejected')}>Reject selected</Button>
              </FilterBar>
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
                <li key={l.id}>
                  <ListRow
                    selected={i === selected}
                    lead={bulkable ? <input type="checkbox" aria-label={`select ${l.title}`} checked={picked.has(l.id)} onChange={() => toggle(l.id)} className="cursor-pointer" /> : undefined}
                    onClick={() => { const go = () => { setSelected(i); setOpen(true); }; if (i === selected) go(); else afterDiscard(go); }}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="truncate">{l.projectKey ?? 'global'} · <SourceLabel source={l.from ?? l.source} /></span>
                      <span className="flex min-w-0 shrink-0 items-center gap-1.5">
                        {l.cause && (
                          <>
                            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE_FILL[causeTone(l.cause)]}`} />
                            <span className="truncate">{causeLabel(l.cause)}</span>
                          </>
                        )}
                        <ScoreChip score={l.score} why={l.scoreWhy} />
                      </span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug">{l.title}</div>
                    {!!l.checks?.length && <div className="mt-1"><CheckChips checks={l.checks} max={3} /></div>}
                    {genericOf(l) && <div className="mt-1 text-xs text-muted">{genericOf(l)!.why}</div>}
                    {l.decidedBy?.startsWith('operator') && l.status !== 'proposed' && <div className="mt-1"><AgentDecided lesson={l} /></div>}
                    {changedByLoop(l) && <div className="mt-1"><ChangedByLoop lesson={l} /></div>}
                    {l.decisionNote && l.status !== 'proposed' && <div className="mt-1 text-xs text-muted">{l.decisionNote}</div>}
                  </ListRow>
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
                    <ChangedByLoop lesson={detail.lesson} />
                    <ScoreChip score={detail.lesson.score} why={detail.lesson.scoreWhy} />
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
                          {c.suggestion && (
                            // A broader "applies when" the worker proposed: yours to take into the draft, never applied for you.
                            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]">
                              <span>Suggested: “{c.suggestion}”</span>
                              <Button size="sm" disabled={draft.appliesWhen === c.suggestion} onClick={() => setDraft({ ...draft, appliesWhen: c.suggestion! })}>Use it</Button>
                            </span>
                          )}
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
                    <SectionLabel>{feedbackSpeaker(detail.feedback.external, detail.lesson.from)}</SectionLabel>
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
                          <ScrollArea as="pre" className="overflow-x-auto rounded-sm bg-sunken px-2.5 py-2 font-mono text-xs whitespace-pre-wrap">{c.excerpt}</ScrollArea>
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
                            <td className={`${tdClass} max-w-0 [overflow-wrap:anywhere]`}>{c.subject}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}

                <Card title="Lesson for future agents" bodyClass="grid gap-3 p-3">
                  <Field label="Title">
                    <Input aria-label="title" {...locked} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="w-full" />
                  </Field>
                  <Field label="Rule">
                    <Textarea aria-label="rule" {...locked} value={draft.rule} onChange={(e) => setDraft({ ...draft, rule: e.target.value })} rows={3} className="w-full" />
                  </Field>
                  <Field label="Applies when">
                    <Input aria-label="applies when" {...locked} value={draft.appliesWhen} onChange={(e) => setDraft({ ...draft, appliesWhen: e.target.value })} placeholder="applies when…" className="w-full" />
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted">Scope</span>
                    <Select aria-label="scope" size="sm" disabled={!writes} title={writes ? undefined : READ_ONLY_TITLE} value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as Draft['scope'] })}>
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
                  <label className="grid gap-1">
                    <span className="text-xs font-medium text-muted">Paths (agents get it when they edit these; one per line, a file or folder in the code map)</span>
                    <Textarea {...locked} value={draft.paths} onChange={(e) => setDraft({ ...draft, paths: e.target.value })} rows={2} placeholder="src/billing/retry.ts" className="w-full font-mono text-xs" />
                    {!lines(draft.paths).length && <span className="text-xs text-muted">No paths: applies anywhere in its project{draft.scope === 'global' ? ' (or any project, as a global lesson)' : ''}.</span>}
                  </label>
                  <div className="grid gap-1.5">
                    <span className="text-xs font-medium text-muted">Triggers (agents also get it when a task or change matches one; one per line)</span>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {([['paths', 'Path globs', '**/*.sql'], ['patterns', 'Added-line patterns', 'CREATE\\s+INDEX'], ['symbols', 'Symbols', 'asyncio.to_thread']] as const).map(([k, label, hint]) => (
                        <Field key={k} label={label}>
                          <Textarea aria-label={`trigger ${k}`} {...locked} value={draft.triggers[k]} onChange={(e) => setDraft({ ...draft, triggers: { ...draft.triggers, [k]: e.target.value } })} rows={3} placeholder={hint} className="w-full font-mono text-xs" />
                        </Field>
                      ))}
                    </div>
                    {detail.lesson.triggers == null && <span className="text-xs text-muted">None derived yet: the worker fills them in from the miss, or write your own.</span>}
                  </div>
                </Card>

                <LessonDecisions lessonId={detail.lesson.id} onChanged={reloadAfterRollback} />

                {history.length > 0 && (
                  <Card title="History">
                    <ul>{history.map((a) => <ActivityEntry key={a.id} a={a} />)}</ul>
                  </Card>
                )}
              </div>
            ) : current ? (
              <SkeletonDetail />
            ) : loaded && focus && selected < 0 ? <EmptyState icon={<LessonIcon />} title="Linked lesson is unavailable">It may have been deleted or excluded by the current filters. Select a lesson explicitly to continue.</EmptyState> : null}
          </div>
          {detail && draft && status !== 'superseded' && (
            <div ref={bar} className="sticky bottom-0 border-t border-line bg-surface/95 backdrop-blur">
              <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 py-2.5 md:px-6">
                <label className="flex w-full items-center gap-2 text-xs text-muted">
                  <span className="shrink-0">Note</span>
                  <Input {...locked} size="sm" value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} placeholder="optional: why, kept with your decision" className="w-full" />
                </label>
                {status === 'proposed' && (
                  <>
                    <Button variant="primary" owner busy={!!deciding} onClick={() => decide('approved')}>{deciding === 'approved' ? 'Approving…' : 'Approve'}</Button>
                    <Button owner busy={!!deciding} onClick={() => decide('rejected')}>{deciding === 'rejected' ? 'Rejecting…' : 'Reject'}</Button>
                    <Button
                      owner
                      busy={!!deciding}
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
                    <Button variant="primary" owner disabled={!edited} busy={saving || !!deciding} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
                    <Button variant="danger-outline" owner busy={saving || !!deciding} onClick={() => setRevoking(true)}>{deciding === 'revoked' ? 'Revoking…' : 'Revoke'}</Button>
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
                {(status === 'rejected' || status === 'revoked') && <Button owner busy={!!deciding} onClick={() => decide('proposed')}>{deciding === 'proposed' ? 'Moving…' : 'Back to proposed'}</Button>}
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

/** Whose words the feedback is: yours, your agent's report of a miss, or a reviewer's or commenter's on GitHub or Linear. */
function feedbackSpeaker(ext: { source: string; author: string } | null | undefined, from?: LessonFrom): string {
  if (from === 'agent') return 'The agent reported';
  if (!ext) return 'You said';
  const who = ext.author || (ext.source === 'github' ? 'The reviewer' : 'The commenter');
  return `${who} said`;
}
