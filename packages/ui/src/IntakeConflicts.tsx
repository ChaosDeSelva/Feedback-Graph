import { useEffect, useState } from 'react';
import { CONFLICT_DISMISS_REASONS, type ConflictChoice, type ConflictDismissReason, type ConflictStatus } from '@fb/core/types';
import { errorMessage, intakeApi, loopApi, type ConflictSideView, type ConflictView, type Decision } from './api.ts';
import { READ_ONLY_TITLE, useOwnerWrites } from './ownerAccess.tsx';
import { ReviewList } from './ui/ReviewList.tsx';
import { Button, Select, Tabs, Textarea, usePending } from './ui/controls.tsx';
import { Alert, Badge, EmptyState, Kbd, plural, SectionLabel, SkeletonDetail, StatusBadge } from './ui/display.tsx';
import { IntakeIcon } from './ui/icons.tsx';
import { usePaged } from './ui/usePaged.ts';

/**
 * The Conflicts tab of the Intake page (0.9.0 §6): two things agents may be told that disagree, side by side, and your
 * choice of which is true. A choice is a resolve_conflict decision the API applies at once: the loser is superseded,
 * never deleted, and Undo rolls that decision back, which reopens the conflict and restores the loser exactly.
 */

const STATUS_TABS: ConflictStatus[] = ['open', 'resolved', 'dismissed'];
export const REASON_LABEL: Record<ConflictDismissReason, string> = { scope: 'different scope', refines: 'one refines the other', handled: 'already handled' };
const CHOICE_LABEL: Record<ConflictChoice, string> = { a: 'A is true', b: 'B is true', both: 'Both partly', none: 'Not a conflict' };
const SOURCE_WORD = { transcript: 'call', notes: 'notes', doc: 'doc' } as const;
const DAY = 86_400_000;

/** Who said a side, in words: a person (and the call), else where a fact or lesson came from. */
function whoSaid(s: ConflictSideView): string {
  if (s.speaker) return `${s.speaker.isOwner ? 'You' : s.speaker.displayName}${s.source ? `, ${SOURCE_WORD[s.source.kind]}${s.source.origin ? ` (${s.source.origin})` : ''}` : ''}`;
  if (s.kind === 'claim') return s.docId?.startsWith('answer:') ? 'Your answer' : 'Someone in a source';
  if (s.kind === 'lesson') return `A lesson${s.origin ? ` (${s.origin})` : ''}`;
  return s.origin === 'you' ? 'A fact you wrote' : s.origin === 'claim' ? 'A fact from an accepted claim' : `A fact${s.origin ? ` (${s.origin})` : ''}${s.path ? ` on ${s.path}` : ''}`;
}
const whenSaid = (s: ConflictSideView) => (s.assertedAt ?? s.source?.occurredAt ?? null)?.slice(0, 10) ?? null;

/** "12 days later": how far apart the two sides were said, when both have a time. */
function gap(a: ConflictSideView, b: ConflictSideView): string | null {
  const [x, y] = [a.assertedAt, b.assertedAt].map((t) => (t ? Date.parse(t) : NaN));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const days = Math.round(Math.abs(y - x) / DAY);
  return days === 0 ? 'said the same day' : `${days} ${days === 1 ? 'day' : 'days'} apart, ${y > x ? 'B' : 'A'} later`;
}

function SideCard({ label, side, newer }: { label: 'A' | 'B'; side: ConflictSideView; newer: boolean }) {
  const when = whenSaid(side);
  return (
    <section aria-label={`side ${label}`} className="grid content-start gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="accent">{label}</Badge>
        <Badge>{side.kind}</Badge>
        {side.type && side.type !== side.kind && <Badge>{side.type}</Badge>}
        {side.status && <StatusBadge status={side.status} />}
        {newer && <Badge tone="info">probably replaces the other</Badge>}
      </div>
      {side.gone ? <p className="text-muted">This record is gone.</p> : <p className="text-[14px] leading-snug [overflow-wrap:anywhere]">{side.text}</p>}
      {side.quote && <blockquote className="rounded-md border border-line bg-sunken px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">“{side.quote}”</blockquote>}
      <p className="text-xs text-muted">{whoSaid(side)}{when && <>, {when}</>}</p>
      <p className="text-xs">Agents see this: <strong>{side.agentsSee ? 'yes' : 'no'}</strong></p>
      {side.kind === 'claim' && side.docId && !side.docId.startsWith('answer:') && (
        <a className="text-xs underline" href={`#intake/claims?source=${encodeURIComponent(side.docId)}`}>open in source</a>
      )}
    </section>
  );
}

export function ConflictsTab({ project }: { project: string }) {
  const writes = useOwnerWrites();
  const locked = writes ? {} : { readOnly: true, title: READ_ONLY_TITLE };
  const [status, setStatus] = useState<ConflictStatus>('open');
  const list = usePaged<ConflictView>((offset) => intakeApi.conflicts({ status, ...(project && { project }), offset }), (k) => k.id, [status, project]);
  const { items, setItems } = list;
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [status]);
  const current = items[selected];
  const [detail, setDetail] = useState<(ConflictView & { decision: Decision | null }) | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<ConflictDismissReason | ''>('');
  const [statement, setStatement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ conflict: ConflictView; decision: Decision; message: string } | null>(null);
  const [pending, run] = usePending<ConflictChoice | 'undo'>();
  useEffect(() => {
    setDetail(null);
    setNote('');
    setReason('');
    setStatement('');
    setError(null);
    if (!current) return;
    let stale = false;
    intakeApi.conflict(current.id).then((d) => { if (!stale) setDetail(d); }, (e) => { if (!stale) setError(errorMessage(e)); });
    return () => { stale = true; };
  }, [current?.id, status]);
  const k = detail && detail.id === current?.id ? detail : null;
  const isOpen = k?.status === 'open';
  // A supersession: the newer side probably replaces the older (the owner still confirms it).
  const newer = k?.kind === 'supersession' && k.sides.a.assertedAt && k.sides.b.assertedAt ? (k.sides.b.assertedAt > k.sides.a.assertedAt ? 'b' : 'a') : null;

  const resolve = (choice: ConflictChoice) => run(choice, async () => {
    if (!k || !isOpen) return;
    if (choice === 'both' && !note.trim()) { setError('Both partly needs a note saying how each is true.'); return; }
    if (choice === 'none' && !reason) { setError('Not a conflict needs a reason.'); return; }
    setError(null);
    try {
      const out = await intakeApi.resolveConflict(k.id, {
        choice, expect: k.fingerprint, ...(note.trim() && { note: note.trim() }), ...(choice === 'none' && reason && { reason }),
        ...(choice === 'both' && statement.trim() && { statement: statement.trim() }),
      });
      setItems((xs) => xs.filter((x) => x.id !== k.id));
      setSelected((i) => Math.min(i, items.length - 2));
      setUndo({ conflict: k, decision: out.decision, message: `${CHOICE_LABEL[choice]}: ${choice === 'none' ? 'dismissed' : 'resolved'}` });
    } catch (e) { setError(errorMessage(e)); }
  });
  /** Roll the resolution back: the conflict opens again and the loser is restored as it was. */
  const rollBack = (decision: Decision, conflict: ConflictView) => run('undo', async () => {
    setError(null);
    try {
      await loopApi.act(decision.id, 'rollback', { expect: 'applied', cascade: 'apply' });
      setUndo(null);
      const back = await intakeApi.conflict(conflict.id);
      if (status === 'open') setItems((xs) => [back, ...xs.filter((x) => x.id !== back.id)]);
      else setItems((xs) => xs.filter((x) => x.id !== back.id));
      setSelected(0);
    } catch (e) { setError(errorMessage(e)); }
  });

  const choiceKeys = (['a', 'b', 'both', 'none'] as const).map((choice, i) => ({
    key: String(i + 1), label: CHOICE_LABEL[choice].toLowerCase(), owner: true, when: !!isOpen, run: () => void resolve(choice),
  }));
  return (
    <ReviewList
      label="conflicts"
      listWidth="24rem"
      items={items}
      idOf={(x) => x.id}
      selected={selected}
      onSelect={setSelected}
      loaded={list.loaded}
      next={list.next !== null}
      loadingMore={list.loadingMore}
      onLoadMore={list.loadMore}
      busy={!!pending}
      notice={(error ?? list.error) && <Alert>{error ?? list.error}</Alert>}
      keys={choiceKeys}
      undo={undo && { message: undo.message, label: 'Undo', onUndo: () => void rollBack(undo.decision, undo.conflict) }}
      listHeader={
        <>
          <Tabs label="status" value={status} options={STATUS_TABS} onChange={setStatus} />
          {list.loaded && <span className="ml-auto text-xs text-muted tabular-nums">{plural(items.length, 'conflict')}{list.next !== null ? ', more waiting' : ''}</span>}
        </>
      }
      empty={
        <EmptyState compact icon={<IntakeIcon />} title={status === 'open' ? 'No conflicts to settle' : `No ${status} conflicts`}>
          {status === 'open' ? 'When a claim disagrees with a fact, a lesson or another claim, both sides are shown here for you to choose which is true.' : undefined}
        </EmptyState>
      }
      row={(x) => (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="flex min-w-0 items-center gap-1.5"><Badge tone={x.kind === 'supersession' ? 'info' : 'bad'}>{x.kind}</Badge><span className="truncate">{x.projectKey ?? 'global'}</span></span>
          </div>
          <div className="mt-0.5 line-clamp-1 text-[13px] leading-snug">A: {x.sides.a.text}</div>
          <div className="line-clamp-1 text-[13px] leading-snug">B: {x.sides.b.text}</div>
        </>
      )}
      actions={k && isOpen && (
        <>
          {(['a', 'b'] as const).map((c, i) => (
            <Button key={c} owner variant={newer === c ? 'primary' : 'secondary'} busy={pending === c} onClick={() => void resolve(c)}>{CHOICE_LABEL[c]} <Kbd>{i + 1}</Kbd></Button>
          ))}
          <Button owner busy={pending === 'both'} onClick={() => void resolve('both')}>Both partly <Kbd>3</Kbd></Button>
          <Button owner busy={pending === 'none'} onClick={() => void resolve('none')}>Not a conflict <Kbd>4</Kbd></Button>
        </>
      )}
    >
      {k ? (
        <div className="flex min-w-0 flex-col gap-5">
          <header className="grid gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>{k.projectKey ?? 'global'}</Badge>
              <StatusBadge status={k.status} />
              <Badge tone={k.kind === 'supersession' ? 'info' : 'bad'}>{k.kind}</Badge>
            </div>
            {k.judge && <p className="[overflow-wrap:anywhere]">{k.judge.explanation}</p>}
            {(k.signals.length > 0 || gap(k.sides.a, k.sides.b)) && (
              <ul aria-label="evidence" className="flex flex-wrap gap-1.5 text-xs text-muted">
                {k.signals.map((s, i) => <li key={i}><Badge>{s.why}</Badge></li>)}
                {gap(k.sides.a, k.sides.b) && <li><Badge>{gap(k.sides.a, k.sides.b)}</Badge></li>}
              </ul>
            )}
            {k.judge && (
              <p className="text-xs text-muted">The judge quoted A “{k.judge.aQuote}” and B “{k.judge.bQuote}”.</p>
            )}
          </header>
          <div className="grid gap-3 md:grid-cols-2">
            <SideCard label="A" side={k.sides.a} newer={newer === 'a'} />
            <SideCard label="B" side={k.sides.b} newer={newer === 'b'} />
          </div>
          {isOpen && (
            <section aria-label="your choice" className="grid gap-2">
              <label className="grid gap-1 text-xs font-medium text-muted">
                Note (needed for both partly; kept with the decision)
                <Textarea rows={2} value={note} placeholder="How each is true, or why" onChange={(e) => setNote(e.target.value)} {...locked} />
              </label>
              <label className="grid gap-1 text-xs font-medium text-muted">
                Reconciled statement (both partly, optional: filed as your fact, and both sides are superseded by it)
                <Textarea rows={2} value={statement} placeholder="One statement both are part of" onChange={(e) => setStatement(e.target.value)} {...locked} />
              </label>
              <label className="grid gap-1 text-xs font-medium text-muted">
                Why it is not a conflict
                <Select aria-label="reason" value={reason} disabled={!writes} onChange={(e) => setReason(e.target.value as ConflictDismissReason | '')} className="w-56">
                  <option value="">choose a reason…</option>
                  {CONFLICT_DISMISS_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
                </Select>
              </label>
              <p className="text-xs text-muted">The side you do not choose is superseded, never deleted: agents stop being given it, and Undo restores it.</p>
            </section>
          )}
          {!isOpen && k.resolution && (
            <section aria-label="resolution" className="grid gap-1.5">
              <SectionLabel>Your choice</SectionLabel>
              <p>
                {CHOICE_LABEL[k.resolution.choice]}
                {k.resolution.reason && <> ({REASON_LABEL[k.resolution.reason]})</>}
                {k.resolution.note && <>: {k.resolution.note}</>}
              </p>
              {k.resolution.createdFactId && <p className="text-xs text-muted">Agents are given your reconciled statement as the fact {k.resolution.createdFactId}.</p>}
              {k.decision?.status === 'applied' && (
                <div><Button owner busy={pending === 'undo'} onClick={() => void rollBack(k.decision!, k)}>Undo this choice</Button></div>
              )}
            </section>
          )}
        </div>
      ) : current ? <SkeletonDetail /> : null}
    </ReviewList>
  );
}
