import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ActivityEntry } from './Activity.tsx';
import {
  api, ApiError, DECISION_STATUSES, DECISION_TYPES, LOOP_CHANGED_EVENT, loopApi, NOTE_REASONS,
  type Decision, type DecisionAction, type DecisionDetail, type DecisionFilter, type DecisionMode, type DecisionStatus, type DecisionSummary, type DecisionType, type DistinctPair,
  type ResolvedEvidence, type RollbackPreview, type RollbackReason,
} from './api.ts';
import { hashFilters, hashFocus, inboxHref, lessonHref, moduleHref, projectHref, saveHashFilters, sessionHref } from './links.ts';
import { confidenceLine, decisionsCsv, decisionTitle, decisionTone, fieldDiff, isLoopActor, p2, reasonLabel, showValue, statusLabel, summaryLabel, tierLabel, typeLabel } from './loop.ts';
import { useOwnerWrites } from './ownerAccess.tsx';
import { Dialog } from './ui/Dialog.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, buttonClass, Input, Select, Textarea } from './ui/controls.tsx';
import { Alert, Badge, Card, Chip, EmptyState, Kbd, longTime, plural, SectionLabel, SkeletonDetail, SkeletonList, tableClass, tdClass, thClass, Time } from './ui/display.tsx';
import { DecisionIcon, DownloadIcon } from './ui/icons.tsx';
import { ScrollArea } from './ui/ScrollArea.tsx';
import { judgementFirst, ScoreChip } from './ui/ScoreChip.tsx';

/** Every request fails with an Error (api.ts): the API's own words, or that it did not answer. */
const message = (e: unknown) => (e as Error).message;
/** How far back the Decisions page counts the proposals your own changes expired. */
const EXPIRED_NOTICE_DAYS = 7;
/** How many waiting proposals the owner's own changes expired in the last EXPIRED_NOTICE_DAYS (their Activity lines). */
export function expiredLately(xs: { ts: string; details: Record<string, unknown> }[], now = Date.now()): number {
  return xs.filter((a) => a.details.action === 'expired_by_you' && now - Date.parse(a.ts) <= EXPIRED_NOTICE_DAYS * 86_400_000)
    .reduce((n, a) => n + (typeof a.details.expired === 'number' ? a.details.expired : 0), 0);
}
const STATUS_OPTIONS = ['proposed', 'all', ...DECISION_STATUSES.filter((s) => s !== 'proposed')] as const;
type StatusOption = (typeof STATUS_OPTIONS)[number];
const MODES: DecisionMode[] = ['auto', 'propose', 'observe'];
const MODE_LABEL: Record<DecisionMode, string> = { auto: 'applied by the loop', propose: 'proposed to you', observe: 'observed only' };
const BANDS = [0, 1, 2, 3, 4];

/** The status a decision shows, and whether the loop made it: "by loop" in the accent color. */
export function DecisionBadges({ d }: { d: Pick<Decision, 'type' | 'status' | 'decidedBy'> }) {
  return (
    <>
      <Badge>{typeLabel(d.type)}</Badge>
      <Badge tone={decisionTone(d.status)} dot>{statusLabel(d.status)}</Badge>
      {isLoopActor(d.decidedBy) && <Badge tone="accent" title={`applied by ${d.decidedBy}`}>by loop</Badge>}
    </>
  );
}

/** Where an evidence row opens, or null when it has no page of its own. */
function evidenceHref(e: ResolvedEvidence): string | null {
  if (e.missing) return null;
  switch (e.kind) {
    case 'lesson': return lessonHref(e.id);
    case 'session': return sessionHref(e.id);
    case 'candidate': return inboxHref(e.id);
    case 'miss': return e.id.startsWith('miss:') ? inboxHref(e.id.slice(5)) : null;
    case 'fact': return e.projectKey ? (e.path ? moduleHref(e.projectKey, e.path) : projectHref(e.projectKey)) : null;
    default: return null;
  }
}

const linkClass = 'underline decoration-line-strong underline-offset-2 hover:text-text';

function EvidenceRow({ e }: { e: ResolvedEvidence }) {
  const href = evidenceHref(e);
  return (
    <li className="grid gap-1 border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <Badge>{e.kind}</Badge>
        <span>{e.role}</span>
        <span className="tabular-nums">weight {p2(e.weight)}</span>
        <Time iso={e.observedAt} />
      </div>
      <div className="min-w-0 [overflow-wrap:anywhere]">
        {e.missing ? <span className="text-muted">{e.label} (no longer exists)</span> : href ? <a href={href} className={`inline-block py-1 ${linkClass}`}>{e.label}</a> : e.label}
      </div>
      {e.activity && <ul className="rounded-sm border border-line"><ActivityEntry a={e.activity} /></ul>}
    </li>
  );
}

/** Before → after for every field the decision changed, and the value now where it has changed since (three-way). */
function DiffTable({ detail }: { detail: DecisionDetail }) {
  const { decision: d, current } = detail;
  const rows = fieldDiff(d.before, d.after, current);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const threeWay = d.status === 'overridden' || rows.some((r) => r.nowKnown && !same(r.now, r.after));
  if (!rows.length) return <p className="p-3 text-muted">No field changes: this decision {d.after.length ? 'changed nothing it records' : 'records no snapshot'}.</p>;
  const value = 'min-w-28 [overflow-wrap:anywhere]';
  return (
    <ScrollArea role="region" aria-label="field changes" className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>field</th>
            <th className={thClass}>before</th>
            <th className={thClass}>after</th>
            {threeWay && <th className={thClass}>now</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={`${r.target}:${r.field}`}>
              {/* The target heads its own fields once, rather than repeating (and wrapping) on every row. */}
              {r.target !== rows[i - 1]?.target && (
                <tr><th scope="colgroup" colSpan={threeWay ? 4 : 3} className={`${tdClass} bg-sunken py-1 font-mono text-[11px] font-normal text-muted [overflow-wrap:anywhere]`}>{r.target}</th></tr>
              )}
              <tr>
                <td className={`${tdClass} font-mono text-xs whitespace-nowrap`}>{r.field}</td>
                {same(r.before, r.after) ? (
                  // Unchanged by the decision (shown because it changed since): no struck-out or inserted mark.
                  <><td className={`${tdClass} ${value} text-muted`}>{showValue(r.before)}</td><td className={`${tdClass} ${value} text-muted`}>{showValue(r.after)}</td></>
                ) : (
                  <><td className={`${tdClass} ${value}`}><del className="text-bad-text decoration-bad/50">{showValue(r.before)}</del></td><td className={`${tdClass} ${value}`}><ins className="text-ok-text no-underline">{showValue(r.after)}</ins></td></>
                )}
                {threeWay && (
                  <td className={`${tdClass} ${value}`}>
                    {!r.nowKnown ? <span className="text-muted">gone</span>
                      : same(r.now, r.after) ? <span className="text-muted">{showValue(r.now)}</span>
                      : <><span className="font-medium text-accent-text">{showValue(r.now)}</span><span className="block text-[11px] text-muted">changed since</span></>}
                  </td>
                )}
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function SummaryList({ items, empty }: { items: DecisionSummary[]; empty: string }) {
  if (!items.length) return <p className="text-xs text-muted">{empty}</p>;
  return (
    <ul className="grid gap-1">
      {items.map((s) => (
        <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge tone={decisionTone(s.status)} dot>{statusLabel(s.status)}</Badge>
          <a href={`#decisions/${encodeURIComponent(s.id)}`} className={`min-w-0 [overflow-wrap:anywhere] ${linkClass}`}>{summaryLabel(s)}</a>
        </li>
      ))}
    </ul>
  );
}

const VERDICTS = [['agree', 'Agree'], ['disagree', 'Disagree'], ['', 'No verdict']] as const;

/** The notes on a decision and a form to add one: agree or disagree (with a reason). A verdict is kept in the log; it changes no confidence (approving, Keep and rollbacks do). */
function Notes({ detail, onAdded, noteId }: { detail: DecisionDetail; onAdded: () => void; noteId: string }) {
  const writes = useOwnerWrites();
  const [text, setText] = useState('');
  const [verdict, setVerdict] = useState<'agree' | 'disagree' | ''>('');
  const [reason, setReason] = useState<RollbackReason | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loopApi.addNote(detail.decision.id, { text: text.trim(), verdict: verdict || null, ...(verdict === 'disagree' && reason && { reason }) });
      setText(''); setVerdict(''); setReason('');
      onAdded();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Notes">
      <ul>
        {detail.notes.map((n) => (
          <li key={n.id} className="grid gap-1 border-b border-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <Chip>{n.by}</Chip>
              <Time iso={n.ts} />
              {n.verdict && <Badge tone={n.verdict === 'agree' ? 'ok' : 'bad'}>{n.verdict}</Badge>}
              {n.reason && <Badge>{reasonLabel(n.reason)}</Badge>}
            </div>
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{n.text}</p>
          </li>
        ))}
        {!detail.notes.length && <li className="border-b border-line px-3 py-2 text-xs text-muted">No notes yet.</li>}
      </ul>
      <form onSubmit={add} className="grid gap-2 p-3">
        <Textarea id={noteId} aria-label="note" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="What the loop got right or wrong" maxLength={4000} disabled={!writes} />
        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="flex flex-wrap items-center gap-3 text-xs">
            <legend className="sr-only">verdict</legend>
            {VERDICTS.map(([v, label]) => (
              <label key={v} className="flex items-center gap-1.5">
                <input type="radio" name="verdict" value={v} checked={verdict === v} onChange={() => setVerdict(v)} disabled={!writes} />
                {label}
              </label>
            ))}
          </fieldset>
          {verdict === 'disagree' && (
            <Select aria-label="reason" size="sm" value={reason} onChange={(e) => setReason(e.target.value as RollbackReason | '')}>
              <option value="">reason…</option>
              {NOTE_REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
            </Select>
          )}
          <Button type="submit" size="sm" owner disabled={busy || !text.trim()} className="ml-auto">{busy ? 'Adding…' : 'Add note'}</Button>
        </div>
        {error && <Alert>{error}</Alert>}
      </form>
    </Card>
  );
}

/** Ids this long (a decision's, a lesson's) are cut to a line, with the whole id on hover. */
const LONG_ID = 32;

/** Text from the API that may name ids: each long one is truncated with a tooltip, so it never runs off a dialog. */
function IdText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s+)/).map((w, i) => (w.length > LONG_ID && /[:/]/.test(w)
        ? <span key={i} title={w} className="inline-block max-w-[14rem] truncate align-bottom font-mono text-[0.92em]">{w}</span>
        : w))}
    </>
  );
}

/** What changed on the decision's own targets since it was applied, in words: "the lesson "X": title, paths". */
function driftLine(detail: DecisionDetail): string | null {
  const rows = fieldDiff(detail.decision.before, detail.decision.after, detail.current)
    .filter((r) => !r.nowKnown || JSON.stringify(r.now) !== JSON.stringify(r.after));
  if (!rows.length) return null;
  const byTarget = new Map<string, string[]>();
  // Field names in words: appliesWhen → "applies when".
  const words = (f: string) => f.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  for (const r of rows) byTarget.set(r.target, [...(byTarget.get(r.target) ?? []), r.nowKnown ? words(r.field) : `${words(r.field)} (gone)`]);
  const label = (id: string) => {
    const t = detail.decision.after.find((a) => a.id === id);
    const title = typeof t?.fields.title === 'string' ? t.fields.title : null;
    return `the ${t?.kind ?? 'target'} ${title ? `"${title}"` : id}`;
  };
  return [...byTarget].map(([id, fields]) => `${label(id)}: ${fields.join(', ')}`).join('; ');
}

/** The ids a refusal names as blocking the rollback (a 409's `blocked`), other than the decision itself. */
const blockersOf = (e: unknown, self: string): string[] => {
  const blocked = e instanceof ApiError && e.status === 409 ? (e.body as { blocked?: { id: string }[] } | null)?.blocked ?? [] : [];
  return blocked.map((b) => b.id).filter((id) => id !== self);
};

/** A decision that blocks a rollback, by its type and when it was applied, as a link that opens it in the pane. */
function BlockerLink({ id, d }: { id: string; d: Decision | null | undefined }) {
  // Not loaded (yet, or hidden from this page): the id stays on hover.
  if (!d) return <span title={id}>a later decision</span>;
  return (
    <a href={`#decisions/${encodeURIComponent(id)}`} className={linkClass}>
      {typeLabel(d.type)} · {d.appliedAt ? `applied ${longTime(d.appliedAt)}` : statusLabel(d.status)}
    </a>
  );
}

/**
 * Rolling a decision back: first asks the API what else it would undo (later loop decisions that build on this one) and
 * what blocks it, then rolls them all back on confirm, newest first. With `restore`, the decision was overridden (a
 * target changed since it was applied): this writes its `before` over what is there now, as your own change. A preview
 * the API refuses because the decision's own target changed since (it marks it overridden) turns into that restore, so
 * the dialog never ends at a disabled button. One refused because another applied decision changed the target since
 * names that decision, with a link to it: it has to be rolled back first.
 */
export function RollbackDialog({ decision, restore = false, onCancel, onDone, onConflict }: {
  decision: Pick<Decision, 'id' | 'status' | 'type' | 'targets'>;
  restore?: boolean;
  onCancel: () => void;
  /** Rolled back: the decision as it is now, with the dependents it took along in `rollback.cascade`. */
  onDone: (rolled: Decision) => void;
  /** The API refused because the target changed since: the decision is now overridden. */
  onConflict: () => void;
}) {
  const [preview, setPreview] = useState<RollbackPreview | null>(null);
  const [reason, setReason] = useState<RollbackReason | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  /** The preview found its own target changed: the API marked it overridden, and this offers Restore anyway. */
  const [drifted, setDrifted] = useState<{ why: string; drift: string | null } | null>(null);
  /** Other decisions the API says block it (a 409's `blocked`), and each one's record once read (null: it could not be). */
  const [blockers, setBlockers] = useState<string[]>([]);
  const [known, setKnown] = useState<Record<string, Decision | null>>({});
  const learn = (ids: string[]) => {
    for (const id of ids) loopApi.decision(id).then((x) => x.decision, () => null).then((x) => setKnown((k) => ({ ...k, [id]: x })));
  };
  const restoring = restore || !!drifted;
  const failed = (e: unknown) => {
    setError(message(e));
    setConflict(e instanceof ApiError && e.status === 409);
    const ids = blockersOf(e, decision.id);
    setBlockers(ids);
    learn(ids);
    setBusy(false);
  };
  useEffect(() => {
    if (restore) return;
    loopApi.act(decision.id, 'rollback', { expect: decision.status, cascade: 'preview' }).then((p) => {
      setPreview(p as RollbackPreview);
      learn((p as RollbackPreview).blocked.map((b) => b.id).filter((id) => id !== decision.id && !(p as RollbackPreview).cascade.some((c) => c.id === id)));
    }, async (e) => {
      if (!(e instanceof ApiError && e.status === 409) || blockersOf(e, decision.id).length) return failed(e);
      const now = await loopApi.decision(decision.id).catch(() => null);
      if (now?.decision.status === 'overridden' && now.decision.appliedAt) setDrifted({ why: message(e), drift: driftLine(now) });
      else failed(e);
    });
  }, []);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const expect = drifted ? 'overridden' : decision.status;
      const rolled = await loopApi.act(decision.id, 'rollback', { expect, cascade: 'apply', ...(reason && { reason }), ...(note.trim() && { note: note.trim() }), ...(restoring && { restoreAnyway: true }) });
      onDone(rolled as Decision);
    } catch (e) {
      failed(e);
    }
  }
  const blocked = !drifted && !!preview?.blocked.length;
  const more = drifted ? 0 : preview?.cascade.length ?? 0;
  const label = restoring ? 'Restore anyway' : more && !blocked ? `Roll back ${more + 1} decisions` : 'Roll back';
  const inCascade = (id: string) => preview!.cascade.find((c) => c.id === id);
  const blockedLabel = (id: string) => (id === decision.id ? decisionTitle(decision) : inCascade(id) ? summaryLabel(inCascade(id)!) : <BlockerLink id={id} d={known[id]} />);
  // Once the API has marked it overridden, closing the dialog shows the decision as it is now.
  const cancel = drifted ? onConflict : onCancel;
  return (
    <Dialog
      title={restoring ? 'Restore what was there before this decision?' : `Roll back ${decisionTitle(decision)}?`}
      onCancel={cancel}
      busy={busy}
      footer={
        <>
          <Button data-autofocus onClick={cancel} disabled={busy}>Cancel</Button>
          {blockers.length === 1
            ? <a href={`#decisions/${encodeURIComponent(blockers[0]!)}`} className={buttonClass('primary')}>Open the decision that blocks it</a>
            : blockers.length ? null
            : conflict
            ? <Button variant="primary" onClick={onConflict}>Show what changed</Button>
            : <Button variant="danger" owner onClick={() => void go()} disabled={busy || blocked || (!restoring && !preview)}>{busy ? 'Rolling back…' : label}</Button>}
        </>
      }
    >
      {drifted ? (
        <div role="note" className="grid gap-1 rounded-md border border-accent-edge/50 bg-accent-soft px-3 py-2 text-accent-text [overflow-wrap:anywhere]">
          <p>{drifted.drift ? <>Since this decision was applied, <IdText text={drifted.drift} /> changed. So nothing was rolled back, and it is now marked overridden.</> : <IdText text={drifted.why} />}</p>
          <p className="text-xs">Restore anyway writes the version from before the decision over that change, as your own edit. Cancel keeps the change.</p>
        </div>
      ) : (
        <p className="text-muted">
          {restore
            ? 'A target changed after the loop applied this. This writes the version from before the decision over that change, as your own edit.'
            : 'The targets go back to how they were before it. The loop will not make the same call again for 30 days, and counts this against its confidence.'}
        </p>
      )}
      {!restoring && !preview && !error && <p role="status" className="text-xs text-muted">Checking what else depends on it…</p>}
      {more > 0 && (
        <div className="grid gap-1">
          <SectionLabel>Also rolls back, newest first</SectionLabel>
          <ScrollArea as="ul" aria-label="also rolled back" className="grid max-h-40 gap-1 overflow-y-auto">
            {preview!.cascade.map((c) => <li key={c.id} className="rounded-sm border border-line bg-sunken px-2 py-1 [overflow-wrap:anywhere]">{summaryLabel(c)}</li>)}
          </ScrollArea>
        </div>
      )}
      {blocked && (
        <Alert className="[overflow-wrap:anywhere]">
          It cannot be rolled back:{' '}
          {preview!.blocked.map((b, i) => (
            <Fragment key={b.id}>
              {i > 0 && '; '}
              {blockedLabel(b.id)}: <IdText text={b.reason} />
            </Fragment>
          ))}
        </Alert>
      )}
      {blockers.length > 0 && (
        <Alert className="grid gap-1 [overflow-wrap:anywhere]">
          <p>
            Nothing was rolled back: since this decision, {blockers.length === 1 ? 'a later one changed the same target and is still applied' : 'later ones changed the same targets and are still applied'}:{' '}
            {blockers.map((id, i) => <Fragment key={id}>{i > 0 && ', '}<BlockerLink id={id} d={known[id]} /></Fragment>)}.
          </p>
          <p className="text-xs">Roll {blockers.length === 1 ? 'that one' : 'those'} back first (its Roll back takes along any decisions built on it), then this one.</p>
        </Alert>
      )}
      {!conflict && !blocked && (
        <>
          <label className="grid gap-1 text-xs font-medium text-muted">
            Why (teaches the loop)
            <Select aria-label="rollback reason" value={reason} onChange={(e) => setReason(e.target.value as RollbackReason | '')}>
              <option value="">no reason given</option>
              {NOTE_REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
            </Select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted">
            Note (optional)
            <Input aria-label="rollback note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
          </label>
        </>
      )}
      {error && !blockers.length && <Alert className="[overflow-wrap:anywhere]"><IdText text={error} /></Alert>}
    </Dialog>
  );
}

/** Every page of the decisions the filter matches, for an export, by keyset (a deep page reads as fast as the first). */
async function allDecisions(f: Omit<DecisionFilter, 'offset'>): Promise<Decision[]> {
  const out: Decision[] = [];
  for (let after: string | null | undefined; after !== null;) {
    const page: { items: Decision[]; next: string | null } = await loopApi.decisionsAfter({ ...f, limit: 500, ...(after && { after }) });
    out.push(...page.items);
    after = page.next;
  }
  return out;
}

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type Filters = { status: StatusOption; type: DecisionType | ''; project: string; mode: DecisionMode | ''; band: string; since: string; until: string; target: string; q: string; sort: '' | 'score' };

/**
 * A day as the date fields write it (2026-11-09) that is a real date; anything else from an address is dropped. Year 0000
 * is a date to JavaScript but not to a date field, which would show it blank while the filter applied.
 */
function day(v: string | null): string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith('0000')) return '';
  const t = new Date(`${v}T00:00:00`);
  return !Number.isNaN(t.getTime()) && t.getFullYear() === Number(v.slice(0, 4)) && t.getMonth() + 1 === Number(v.slice(5, 7)) && t.getDate() === Number(v.slice(8)) ? v : '';
}

function filtersFromHash(): Filters {
  const h = hashFilters();
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T | '') => (allowed as readonly string[]).includes(h.get(key) ?? '') ? (h.get(key) as T) : fallback;
  return {
    status: pick('status', STATUS_OPTIONS, 'proposed') as StatusOption,
    type: pick('type', DECISION_TYPES, ''),
    project: h.get('project') ?? '',
    mode: pick('mode', MODES, ''),
    band: pick('band', BANDS.map(String), ''),
    since: day(h.get('since')),
    until: day(h.get('until')),
    target: h.get('target') ?? '',
    q: h.get('q') ?? '',
    sort: h.get('sort') === 'score' ? 'score' : '',
  };
}

/**
 * The order rows are shown in: the API's (newest first, or by approve score with sort=score), except that "needs you"
 * in its default order puts the judgement calls (the grey middle band, nearest 5 first) before the clear ones (0.9.4).
 */
const ordered = (f: Filters, rows: Decision[]) =>
  f.status === 'proposed' && !f.sort ? [...rows].sort((a, b) => judgementFirst({ score: a.approveScore }, { score: b.approveScore })) : rows;

const toQuery = (f: Filters): DecisionFilter => ({
  status: f.status === 'all' ? undefined : f.status,
  type: f.type || undefined,
  project: f.project || undefined,
  mode: f.mode || undefined,
  band: f.band ? Number(f.band) : undefined,
  // Dates are whole days in the viewer's zone: until includes its own day.
  since: f.since ? new Date(`${f.since}T00:00:00`).toISOString() : undefined,
  until: f.until ? new Date(new Date(`${f.until}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined,
  target: f.target || undefined,
  q: f.q || undefined,
  sort: f.sort || undefined,
});

/** The actions a decision in this status takes. */
const canDecide = (s: string) => s === 'proposed' || s === 'observed';

/** The audit log: every decision the loop made, with what it changed, why, and a way to undo it. */
/** The two records a merge decision joins (its keeper and the one merged into it), or null for any other decision. */
export function mergePair(d: Pick<Decision, 'type' | 'targets'>): { a: string; b: string } | null {
  if (d.type !== 'merge_duplicates' && d.type !== 'merge_claims') return null;
  const keeper = d.targets.find((t) => t.role === 'keeper');
  const merged = d.targets.find((t) => t.role === 'merged');
  return keeper && merged ? { a: keeper.id, b: merged.id } : null;
}

/**
 * On a merge decision: "Never merge these two" records the pair so the loop never proposes merging it again, and the
 * never-merge records naming either record are listed, each of which you can lift.
 */
function NeverMerge({ pair }: { pair: { a: string; b: string } }) {
  const [pairs, setPairs] = useState<DistinctPair[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => loopApi.distinctPairs([pair.a, pair.b]).then(setPairs, (e) => setError(message(e)));
  useEffect(() => { setPairs(null); setError(null); void load(); }, [pair.a, pair.b]);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await f(); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const [x, y] = distinctOrder(pair.a, pair.b);
  const marked = pairs?.some((p) => p.a === x && p.b === y) ?? false;
  return (
    <Card title="Never merge" bodyClass="grid gap-2 p-3">
      {error && <Alert>{error}</Alert>}
      {pairs === null ? <p className="text-xs text-muted">Loading…</p> : (
        <>
          {marked
            ? <p className="text-[13px]">You said these two are not the same: the loop never proposes merging them again.</p>
            : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" owner disabled={busy} onClick={() => void run(() => loopApi.markDistinct({ a: pair.a, b: pair.b, reason: 'you marked them as not the same on the Decisions page' }))}>Never merge these two</Button>
                <span className="text-xs text-muted">The loop never proposes merging them again, whatever the evidence; reject this one to close it.</span>
              </div>
            )}
          {pairs.length > 0 && (
            <ul aria-label="never-merge records" className="grid gap-1">
              {pairs.map((p) => (
                <li key={`${p.a}|${p.b}`} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">{p.a} ≠ {p.b}</span>
                  <span className="text-muted">{p.reason} · {p.by} · {longTime(p.at)}</span>
                  <Button size="sm" variant="ghost" owner disabled={busy} aria-label={`lift never merge ${p.a} and ${p.b}`} onClick={() => void run(() => loopApi.liftDistinct(p.a, p.b))}>Lift</Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/** Mirrors core distinctKey: a pair is stored with its ids in order. */
const distinctOrder = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export function Decisions() {
  const writes = useOwnerWrites();
  const [filters, setFilters] = useState<Filters>(filtersFromHash);
  const [qDraft, setQDraft] = useState(filters.q);
  const [targetDraft, setTargetDraft] = useState(filters.target);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  useEffect(() => saveHashFilters('decisions', { ...filters, status: filters.status }), [filters]);
  const [items, setItems] = useState<Decision[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** The list itself failed (not a decision or an action): no count and no "nothing waiting", which would not be true. */
  const [listFailed, setListFailed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * An action the API refused (a 409: the decision moved on meanwhile). It outlives the selection change that follows,
   * when the decision leaves a filtered list, and goes when you pick another decision or act again.
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  const pick = (i: number) => { setRefusal(null); setSelected(i); setOpen(true); };
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'rollback' | 'restore' | null>(null);
  const [exporting, setExporting] = useState(false);
  // Why you approve or reject: the note joins the decision's notes (agree or disagree), a reject's reason with it.
  // Proposals your own changes expired lately (the Activity lines that say so): a notice, so none vanish unannounced.
  const [expiredByYou, setExpiredByYou] = useState(0);
  const [listedOnce, setListedOnce] = useState(false);
  useEffect(() => { if (loaded) setListedOnce(true); }, [loaded]);
  useEffect(() => {
    if (!listedOnce) return;
    const load = () => api.activity({ kind: 'decision_made', limit: 200 }).then((xs) => setExpiredByYou(expiredLately(xs)), () => {});
    load();
    window.addEventListener(LOOP_CHANGED_EVENT, load);
    return () => window.removeEventListener(LOOP_CHANGED_EVENT, load);
  }, [listedOnce]);
  const [actNote, setActNote] = useState('');
  const [actReason, setActReason] = useState<RollbackReason | ''>('');
  const noteId = useId();
  const moreId = useId();
  // Open when a link or the address already sets one of the folded filters, so none is applied out of sight.
  const [moreOpen, setMoreOpen] = useState(() => !!(filters.mode || filters.band || filters.project || filters.target || filters.since || filters.until));

  // A link to one decision (#decisions/<id>) opens it with the list on its status.
  const [focus] = useState(() => hashFocus('decisions'));
  /** The decision the list opens on when it loads: the link's, or one whose status changed under the dialog (reopen). */
  const pinned = useRef(focus);
  useEffect(() => {
    if (focus) loopApi.decision(focus).then((d) => set({ status: d.decision.status }), () => setError(`Decision ${focus} could not be loaded.`));
  }, [focus]);

  const query = toQuery(filters);
  const key = JSON.stringify(query);
  useEffect(() => {
    setLoaded(false);
    setListFailed(false);
    setOpen(false);
    let stale = false;
    loopApi.decisions(query).then(({ items: rows, next: n }) => {
      if (stale) return;
      const at = pinned.current ? rows.findIndex((x) => x.id === pinned.current) : -1;
      setItems(ordered(filters, rows));
      setNext(n);
      setSelected(Math.max(0, at));
      setOpen(at >= 0);
      setLoaded(true);
    }, (e) => { if (!stale) { setError(message(e)); setItems([]); setListFailed(true); setLoaded(true); } });
    return () => { stale = true; };
  }, [key]);

  async function loadMore() {
    try {
      const page = await loopApi.decisions({ ...query, offset: next! });
      setItems((xs) => ordered(filters, [...xs, ...page.items]));
      setNext(page.next);
    } catch (e) {
      setError(message(e));
    }
  }

  const current = items[selected];
  const loadDetail = (id: string) => {
    let stale = false;
    loopApi.decision(id).then((d) => { if (!stale) setDetail(d); }, (e) => { if (!stale) setError(message(e)); });
    return () => { stale = true; };
  };
  useEffect(() => {
    setDetail(null);
    setError(null);
    setDialog(null);
    setActNote('');
    setActReason('');
    if (current) return loadDetail(current.id);
  }, [current?.id]);

  /**
   * After a change: the decision's new state in the list (it leaves a list filtered to another status) and in the pane,
   * and that of `others` it changed too (the dependents a rollback took along).
   */
  async function refresh(id: string, others: string[] = []) {
    window.dispatchEvent(new Event(LOOP_CHANGED_EVENT));
    const [d, ...rest] = await Promise.all([id, ...others].map((x) => loopApi.decision(x)));
    const now = new Map([d, ...rest].map((x) => [x.decision.id, x.decision]));
    const leaves = (x: Decision) => filters.status !== 'all' && now.has(x.id) && now.get(x.id)!.status !== filters.status;
    const kept = items.filter((x) => !leaves(x)).map((x) => now.get(x.id) ?? x);
    const at = kept.findIndex((x) => x.id === id);
    setItems(kept);
    if (at >= 0) {
      setSelected(at);
      setDetail(d);
    } else {
      // The next decision takes its place.
      setSelected(Math.max(0, Math.min(items.slice(0, selected).filter((x) => !leaves(x)).length, kept.length - 1)));
    }
  }

  /**
   * The API changed the decision's status under the rollback dialog (its target changed since: it is overridden now).
   * The same decision stays open as it is now: a list filtered to its old status switches to its new one, and the address
   * names it, rather than the next decision silently taking its place with live buttons.
   */
  async function reopen(id: string) {
    window.dispatchEvent(new Event(LOOP_CHANGED_EVENT));
    const now = await loopApi.decision(id);
    setDetail(now);
    const s = now.decision.status;
    if (filters.status === 'all' || s === filters.status) return setItems((xs) => xs.map((x) => (x.id === id ? now.decision : x)));
    pinned.current = id;
    history.replaceState(history.state, '', `#decisions/${encodeURIComponent(id)}`);
    set({ status: (STATUS_OPTIONS as readonly string[]).includes(s) ? (s as StatusOption) : 'all' });
  }

  // A second key press before the first answer would decide again: the ref holds until the answer comes.
  const acting = useRef(false);
  async function act(action: Exclude<DecisionAction, 'rollback'>) {
    if (acting.current) return;
    acting.current = true;
    const d = detail!.decision;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const note = actNote.trim();
      await loopApi.act(d.id, action, { expect: d.status, ...(note && { note }), ...(action === 'reject' && actReason && { reason: actReason }) });
      setActNote('');
      setActReason('');
      await refresh(d.id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) setError(message(e));
      else {
        setRefusal(`${decisionTitle(d)} was not ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'kept'}: ${message(e)}`);
        await refresh(d.id).catch(() => {});
      }
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  const status = detail?.decision.status;
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || dialog) return;
    if (e.key === 'j') pick(Math.min(selected + 1, items.length - 1));
    else if (e.key === 'k') pick(Math.max(selected - 1, 0));
    else if (!writes || !status) return;
    else if (e.key === 'a' && canDecide(status)) void act('approve');
    else if (e.key === 'x' && canDecide(status)) void act('reject');
    else if (e.key === 'u' && status === 'applied') setDialog('rollback');
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  async function exportAs(format: 'json' | 'csv') {
    setExporting(true);
    setError(null);
    try {
      const all = await allDecisions(query);
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'json') download(`decisions-${stamp}.json`, 'application/json', JSON.stringify(all, null, 2));
      else download(`decisions-${stamp}.csv`, 'text/csv', decisionsCsv(all));
    } catch (e) {
      setError(`Export failed: ${message(e)}`);
    } finally {
      setExporting(false);
    }
  }

  const moreCount = [filters.mode, filters.band, filters.project, filters.target, filters.since, filters.until].filter(Boolean).length;
  const filtered = filters.type || filters.project || filters.mode || filters.band || filters.since || filters.until || filters.target || filters.q;
  const clear = () => { setQDraft(''); setTargetDraft(''); set({ type: '', project: '', mode: '', band: '', since: '', until: '', target: '', q: '', sort: '' }); };
  const d = detail?.decision;
  const pair = d ? mergePair(d) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Decisions"
        description="Everything the learning loop decided: what it changed, the evidence, and a way to undo it."
        actions={
          <>
            <Button size="sm" onClick={() => void exportAs('json')} disabled={exporting}><DownloadIcon size={12} />JSON</Button>
            <Button size="sm" onClick={() => void exportAs('csv')} disabled={exporting}><DownloadIcon size={12} />CSV</Button>
          </>
        }
      />
      <SplitPane
        listLabel="decisions"
        listWidth="26rem"
        listHeader={
          <>
            {expiredByYou > 0 && filters.status !== 'expired' && (
              <p role="status" className="flex w-full flex-wrap items-center gap-2 rounded-md border border-accent-edge/50 bg-accent-soft px-2.5 py-1.5 text-xs text-accent-text">
                {plural(expiredByYou, 'waiting proposal')} expired in the last {EXPIRED_NOTICE_DAYS} days: you decided their targets yourself.
                <Button size="sm" variant="ghost" onClick={() => set({ status: 'expired' })}>Show expired</Button>
              </p>
            )}
            <div className="grid w-full grid-cols-2 gap-2">
              <Select aria-label="status" size="sm" value={filters.status} onChange={(e) => set({ status: e.target.value as StatusOption })}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s === 'all' ? 'every status' : s === 'proposed' ? 'needs you' : statusLabel(s)}</option>)}
              </Select>
              <Select aria-label="type" size="sm" value={filters.type} onChange={(e) => set({ type: e.target.value as DecisionType | '' })}>
                <option value="">every type</option>
                {DECISION_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </Select>
              <Select aria-label="order" size="sm" className="col-span-2" value={filters.sort} onChange={(e) => set({ sort: e.target.value as '' | 'score' })}>
                <option value="">{filters.status === 'proposed' ? 'judgement calls first' : 'newest first'}</option>
                <option value="score">approve score</option>
              </Select>
              <Input size="sm" type="search" aria-label="search rationale and targets" placeholder="search (Enter)" className="col-span-2" value={qDraft} onChange={(e) => setQDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') set({ q: qDraft.trim() }); }} onBlur={() => set({ q: qDraft.trim() })} />
              {/* The rarer filters fold away so the list keeps its room, most of all in a phone's single column. */}
              {moreOpen && (
                <div id={moreId} className="col-span-2 grid grid-cols-2 gap-2">
                  <Select aria-label="applied or proposed" size="sm" value={filters.mode} onChange={(e) => set({ mode: e.target.value as DecisionMode | '' })}>
                    <option value="">auto and proposed</option>
                    {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                  </Select>
                  <Select aria-label="confidence band" size="sm" value={filters.band} onChange={(e) => set({ band: e.target.value })}>
                    <option value="">any confidence</option>
                    {BANDS.map((b) => <option key={b} value={String(b)}>band {b + 1} of 5</option>)}
                  </Select>
                  <Input size="sm" aria-label="project" placeholder="project" value={filters.project} onChange={(e) => set({ project: e.target.value.trim() })} />
                  <Input size="sm" aria-label="target id" placeholder="target id" value={targetDraft} onChange={(e) => setTargetDraft(e.target.value)} onBlur={() => set({ target: targetDraft.trim() })} onKeyDown={(e) => { if (e.key === 'Enter') set({ target: targetDraft.trim() }); }} />
                  <label className="grid gap-0.5 text-[11px] text-muted">from<Input size="sm" type="date" aria-label="from date" value={filters.since} onChange={(e) => set({ since: e.target.value })} /></label>
                  <label className="grid gap-0.5 text-[11px] text-muted">to<Input size="sm" type="date" aria-label="to date" value={filters.until} onChange={(e) => set({ until: e.target.value })} /></label>
                </div>
              )}
            </div>
            <div className="flex w-full flex-wrap items-center gap-2">
              {loaded && !listFailed && <span className="text-xs text-muted tabular-nums">{plural(items.length, 'decision')}{next !== null ? '+' : ''}</span>}
              <div className="ml-auto flex items-center gap-1">
                {filtered && <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>}
                <Button size="sm" variant="ghost" aria-expanded={moreOpen} aria-controls={moreOpen ? moreId : undefined} onClick={() => setMoreOpen((o) => !o)}>
                  {moreOpen ? 'Fewer filters' : `More filters${moreCount ? ` (${moreCount})` : ''}`}
                </Button>
              </div>
            </div>
          </>
        }
        detailOpen={open && items.length > 0}
        onBack={() => setOpen(false)}
        notice={(error || refusal) && <>{refusal && <Alert className="[overflow-wrap:anywhere]">{refusal}</Alert>}{error && <Alert>{error}</Alert>}</>}
        list={
          !loaded ? <SkeletonList /> : listFailed ? (
            <EmptyState compact icon={<DecisionIcon />} title="Decisions could not be loaded">The error above says why. Change a filter or reload the page to try again.</EmptyState>
          ) : items.length === 0 ? (
            <EmptyState compact icon={<DecisionIcon />} title={filters.status === 'proposed' && !filtered ? 'Nothing waiting for you' : 'No decisions match'}>
              {filters.status === 'proposed' && !filtered ? 'When the learning loop proposes a change it waits here. Pick "every status" to see what it did on its own.' : 'Try another status or clear the filters.'}
            </EmptyState>
          ) : (
            <ul>
              {items.map((x, i) => (
                <li key={x.id}>
                  <ListRow selected={i === selected} onClick={() => pick(i)}>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="truncate">{x.projectKey ?? 'global'} · {typeLabel(x.type)}</span>
                      <Time iso={x.createdAt} className="shrink-0" />
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug">{x.rationale}</div>
                    {x.needsYou && <div className="mt-0.5 truncate text-xs text-accent-text" title={x.needsYou}>Needs you: {x.needsYou}</div>}
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge tone={decisionTone(x.status)} dot>{statusLabel(x.status)}</Badge>
                      <span className="text-xs text-muted tabular-nums">p {p2(x.confidence.p)}</span>
                      <ScoreChip score={x.approveScore} why={x.scoreWhy} />
                    </div>
                  </ListRow>
                </li>
              ))}
              {next !== null && <li className="p-2 text-center"><Button size="sm" variant="ghost" onClick={() => void loadMore()}>Load more</Button></li>}
            </ul>
          )
        }
        listFooter={
          items.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
              <span className="flex items-center gap-1"><Kbd>j</Kbd><Kbd>k</Kbd> move</span>
              <span className="flex items-center gap-1"><Kbd>a</Kbd> approve</span>
              <span className="flex items-center gap-1"><Kbd>x</Kbd> reject</span>
              <span className="flex items-center gap-1"><Kbd>u</Kbd> roll back</span>
            </div>
          )
        }
      >
        <div className="flex min-h-full flex-col">
          <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-5 md:px-6">
            {refusal && <Alert className="mb-4 [overflow-wrap:anywhere]">{refusal}</Alert>}
            {error && <Alert className="mb-4">{error}</Alert>}
            {detail && d ? (
              <div className="flex min-w-0 flex-col gap-5">
                <header className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <DecisionBadges d={d} />
                    <Badge title={`tier ${d.tier}`}>{tierLabel(d.tier)}</Badge>
                    <Badge>{d.projectKey ?? 'global'}</Badge>
                    <ScoreChip score={d.approveScore} why={d.scoreWhy} />
                  </div>
                  <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{decisionTitle(d)}</h2>
                  <ul aria-label="about this decision" className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                    <li>{confidenceLine(d.confidence)}</li>
                    <li>band {d.confidence.band + 1} of 5</li>
                    <li>made {longTime(d.createdAt)}</li>
                    {d.decidedBy && <li>{statusLabel(d.status)} by <span className="font-mono">{d.decidedBy}</span>{d.decidedAt && <> {longTime(d.decidedAt)}</>}</li>}
                  </ul>
                  {d.rollback && (
                    <p className="text-xs text-muted">
                      Rolled back by <span className="font-mono">{d.rollback.by}</span> {longTime(d.rollback.at)}
                      {d.rollback.reason && <>: {reasonLabel(d.rollback.reason)}</>}{d.rollback.note && <> ({d.rollback.note})</>}
                      {d.rollback.cascade.length > 0 && <>, with {plural(d.rollback.cascade.length, 'dependent decision')}</>}
                    </p>
                  )}
                  {d.status === 'overridden' && (
                    <p role="note" className="rounded-md border border-accent-edge/50 bg-accent-soft px-3 py-2 text-accent-text">
                      {d.appliedAt
                        ? 'A target changed after the loop applied this, so it was not rolled back over that change.'
                        : 'Its target changed before it was applied, so nothing was changed.'} The <b>now</b> column shows what is there.
                    </p>
                  )}
                </header>

                <Card title="What changed"><DiffTable detail={detail} /></Card>

                <Card title="Why" bodyClass="grid gap-2 p-3">
                  {d.needsYou && <p className="rounded-md bg-accent-soft px-2 py-1 text-[13px] text-accent-text">Needs you: {d.needsYou}</p>}
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{d.rationale}</p>
                  <p className="text-xs text-muted">Model <span className="font-mono">{d.model ?? 'deterministic'}</span> · policy v{d.policyVersion} · score {p2(d.score)}</p>
                  {Object.keys(d.features).length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted">Features it scored</summary>
                      <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 font-mono">
                        {Object.entries(d.features).map(([k, v]) => <div key={k} className="contents"><dt className="[overflow-wrap:anywhere]">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}
                      </dl>
                    </details>
                  )}
                </Card>

                <Card title={`Evidence (${detail.evidence.length})`}>
                  {detail.evidence.length ? <ul>{detail.evidence.map((e) => <EvidenceRow key={`${e.kind}:${e.id}:${e.role}`} e={e} />)}</ul> : <p className="p-3 text-muted">No evidence recorded.</p>}
                </Card>

                <Card title="Depends on, and depended on by" bodyClass="grid gap-3 p-3 sm:grid-cols-2">
                  <div className="grid content-start gap-1.5"><SectionLabel as="div">Depends on</SectionLabel><SummaryList items={detail.dependsOn} empty="Nothing: it stands on its own." /></div>
                  <div className="grid content-start gap-1.5"><SectionLabel as="div">Depended on by</SectionLabel><SummaryList items={detail.dependents} empty="No later decision builds on it." /></div>
                </Card>

                {pair && <NeverMerge pair={pair} />}

                <Notes detail={detail} noteId={noteId} onAdded={() => void refresh(d.id).catch((e) => setError(message(e)))} />
              </div>
            ) : current ? <SkeletonDetail /> : null}
          </div>
          {detail && d && (
            <div className="sticky bottom-0 border-t border-line bg-surface/95 backdrop-blur">
              <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 py-2.5 md:px-6">
                {canDecide(d.status) && (
                  <>
                    <label className="flex min-w-48 flex-1 items-center gap-2 text-xs text-muted">
                      <span className="shrink-0">Note</span>
                      <Input size="sm" value={actNote} onChange={(e) => setActNote(e.target.value)} maxLength={4000} placeholder="optional: why, kept in its notes" className="w-full" disabled={!writes} />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted">
                      <span className="shrink-0">Reason to reject</span>
                      <Select size="sm" value={actReason} onChange={(e) => setActReason(e.target.value as RollbackReason | '')} disabled={!writes}>
                        <option value="">none given</option>
                        {NOTE_REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
                      </Select>
                    </label>
                    <Button variant="primary" owner disabled={busy} onClick={() => void act('approve')}>Approve <Kbd>a</Kbd></Button>
                    <Button owner disabled={busy} onClick={() => void act('reject')}>Reject <Kbd>x</Kbd></Button>
                  </>
                )}
                {d.status === 'applied' && (
                  <>
                    {!d.ratifiedAt && <Button variant="primary" owner disabled={busy} onClick={() => void act('keep')} title="you agree: it stays, and counts toward the loop's confidence">Keep</Button>}
                    <Button variant="danger-outline" owner disabled={busy} onClick={() => setDialog('rollback')}>Roll back <Kbd>u</Kbd></Button>
                  </>
                )}
                {d.status === 'overridden' && d.appliedAt && <Button variant="danger-outline" owner disabled={busy} onClick={() => setDialog('restore')}>Restore anyway</Button>}
                <Button variant="ghost" owner onClick={() => document.getElementById(noteId)?.focus()}>Write a note</Button>
                {d.ratifiedAt && <span className="text-xs text-muted">Kept by {d.ratifiedBy} {longTime(d.ratifiedAt)}</span>}
              </div>
            </div>
          )}
        </div>
      </SplitPane>
      {dialog && d && (
        <RollbackDialog
          decision={d}
          restore={dialog === 'restore'}
          onCancel={() => setDialog(null)}
          onDone={(rolled) => { setDialog(null); void refresh(d.id, rolled.rollback?.cascade ?? []).catch((e) => setError(message(e))); }}
          onConflict={() => { setDialog(null); void reopen(d.id).catch((e) => setError(message(e))); }}
        />
      )}
    </div>
  );
}

/** The newest decisions a lesson's card lists; the rest are a link away. */
const LESSON_DECISIONS_SHOWN = 5;

/** On a lesson: the loop's decisions about it, each with a link to the audit log and an inline Roll back. */
export function LessonDecisions({ lessonId, onChanged }: { lessonId: string; onChanged: () => void }) {
  const [rows, setRows] = useState<Decision[] | null>(null);
  const [rolling, setRolling] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  /** More than the page fetched: the count below is a floor. */
  const [beyond, setBeyond] = useState(false);
  useEffect(() => {
    let stale = false;
    loopApi.decisions({ target: lessonId, limit: 20 }).then((p) => { if (!stale) { setRows(p.items); setBeyond(p.next !== null); } }, () => { if (!stale) setRows([]); });
    return () => { stale = true; };
  }, [lessonId, n]);
  if (!rows?.length) return null;
  const reload = () => { setRolling(null); setN((x) => x + 1); onChanged(); };
  const audit = `#decisions?status=all&target=${encodeURIComponent(lessonId)}`;
  const shown = rows.slice(0, LESSON_DECISIONS_SHOWN);
  const rollable = shown.some((x) => x.status === 'applied');
  return (
    <Card title="Decisions" actions={<a href={audit} className="text-xs font-medium text-accent-text underline decoration-accent/40 underline-offset-2">Audit log</a>}>
      <ul>
        {shown.map((x) => (
          // One height per row whether or not it has a Roll back, and the times in one column.
          <li key={x.id} className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5 last:border-b-0">
            <span className="flex shrink-0 items-center gap-1"><DecisionBadges d={x} /></span>
            <a href={`#decisions/${encodeURIComponent(x.id)}`} className={`min-w-0 flex-1 basis-40 truncate text-[13px] ${linkClass}`} title={x.rationale}>{x.rationale}</a>
            <span className="flex shrink-0 items-center gap-2">
              <Time iso={x.createdAt} className="text-xs text-muted" />
              {rollable && <span className="flex w-[5.5rem] justify-end">{x.status === 'applied' && <Button size="sm" variant="danger-outline" owner onClick={() => setRolling(x)}>Roll back</Button>}</span>}
            </span>
          </li>
        ))}
        {rows.length > shown.length && <li className="px-3 py-2 text-xs text-muted"><a href={audit} className={linkClass}>{beyond ? 'More decisions' : plural(rows.length - shown.length, 'more decision')} in the audit log</a></li>}
      </ul>
      {error && <div className="p-3"><Alert>{error}</Alert></div>}
      {rolling && <RollbackDialog decision={rolling} onCancel={() => setRolling(null)} onDone={reload} onConflict={() => { setError('You changed this lesson after the loop did, so it was not rolled back. Open the decision to compare.'); reload(); }} />}
    </Card>
  );
}
