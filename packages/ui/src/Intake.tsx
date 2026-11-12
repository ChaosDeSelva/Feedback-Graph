import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CLAIM_TYPES, FACT_KINDS, INTAKE_KINDS, type IntakeKind, type ClaimStatus, type ClaimType, type FactKind, type Person, type PersonStatus, type Question, type QuestionStatus } from '@fb/core/types';
import { api, errorMessage, intakeApi, type IntakeUpload, type ClaimDetail, type ClaimEdit, type IntakeSource, type IntakeSourceDetail, type ListedClaim, type QuestionDetail } from './api.ts';
import { hashFilters, hashFocus } from './links.ts';
import { READ_ONLY_TITLE, useOwnerWrites } from './ownerAccess.tsx';
import { askConfirm, ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { Dialog } from './ui/Dialog.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { BulkBar, bulkFailures, ReviewList } from './ui/ReviewList.tsx';
import { Button, Input, Select, Tabs, Textarea, usePending } from './ui/controls.tsx';
import { Alert, Badge, EmptyState, Kbd, plural, SectionLabel, SkeletonDetail, StatusBadge, Time, type Tone } from './ui/display.tsx';
import { IntakeIcon } from './ui/icons.tsx';
import { usePaged } from './ui/usePaged.ts';
import { ConflictsTab } from './IntakeConflicts.tsx';

/**
 * Knowledge intake's review (0.9.0 §3): the sources people's words came from, the claims drawn from them, the questions
 * they left open and the people who said them. Agents only ever see what you accept here: a claim that is not an
 * opinion becomes a project fact. The page exists only while the API reports INTAKE_ENABLED.
 */

export const INTAKE_SECTIONS = ['sources', 'claims', 'questions', 'conflicts', 'people'] as const;
type Section = (typeof INTAKE_SECTIONS)[number];
const CLAIM_TABS: ClaimStatus[] = ['proposed', 'accepted', 'rejected', 'superseded'];
const QUESTION_TABS: QuestionStatus[] = ['open', 'assigned', 'answered', 'dismissed'];
/** Proposed first, as Claims opens on proposed: the people a source just made are the ones to review. */
const PEOPLE_TABS: PersonStatus[] = ['proposed', 'confirmed', 'forgotten'];
/** How often the Sources tab reads its sources again while one is being read. */
export const SOURCE_POLL_MS = 5000;

export const TYPE_TONE: Record<ClaimType, Tone> = { fact: 'info', decision: 'accent', opinion: 'neutral', plan: 'violet', commitment: 'ok' };
export const FLAG_LABEL: Record<string, [string, string]> = {
  'quote-fuzzy': ['quote matched loosely', 'The quote matched the source only approximately: the source\'s own words are shown'],
  'statement-adds': ['statement adds to the quote', 'The statement names something (a number, version, date or name) the quote does not say: check it against the quote'],
};
const SOURCE_WORD = { transcript: 'call', notes: 'notes', doc: 'doc' } as const;

function TypeBadge({ type }: { type: ClaimType }) {
  return <Badge tone={TYPE_TONE[type]}>{type}</Badge>;
}

/** The URL keeps the section and filters: #intake/claims?project=shop&source=doc:1 */
function saveHash(section: Section, filters: Record<string, string>) {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => !!v));
  history.replaceState(history.state, '', `#intake/${section}${q.size ? `?${q}` : ''}`);
}

export function Intake() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => { api.status().then((s) => setEnabled(!!s.intake?.enabled), () => setEnabled(false)); }, []);
  const [section, setSection] = useState<Section>(() => {
    const f = hashFocus('intake');
    return (INTAKE_SECTIONS as readonly string[]).includes(f ?? '') ? (f as Section) : 'claims';
  });
  const [project, setProject] = useState(() => hashFilters().get('project') ?? '');
  const [source, setSource] = useState(() => hashFilters().get('source') ?? '');
  useEffect(() => saveHash(section, { project, ...(section === 'claims' && { source }) }), [section, project, source]);
  const [projects, setProjects] = useState<string[]>([]);
  useEffect(() => { api.projects().then((ps) => setProjects(ps.map((p) => p.key)), () => {}); }, []);
  // Who said what: names for every list, the assignee and merge choices. Reloaded when a person changes.
  const [people, setPeople] = useState<Person[]>([]);
  const reloadPeople = useCallback(() => { intakeApi.people().then(setPeople, () => {}); }, []);
  useEffect(() => { if (enabled) reloadPeople(); }, [enabled, reloadPeople]);
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.displayName])), [people]);
  // A source read in the background makes people after this page loaded them: a speaker not yet known reloads them
  // (once per id), so their claims are not shown as an unknown speaker's.
  const askedFor = useRef(new Set<string>());
  const ensureNames = useCallback((ids: (string | null)[]) => {
    const missing = ids.filter((id): id is string => !!id && !names.has(id) && !askedFor.current.has(id));
    if (!missing.length) return;
    for (const id of missing) askedFor.current.add(id);
    reloadPeople();
  }, [names, reloadPeople]);

  if (enabled === null) return <><PageHeader title="Intake" /><div className="p-4 md:p-6"><SkeletonDetail /></div></>;
  if (!enabled) {
    return (
      <>
        <PageHeader title="Intake" />
        <EmptyState icon={<IntakeIcon />} title="Knowledge intake is off">
          Set <code className="font-mono text-xs">INTAKE_ENABLED=1</code> in <code className="font-mono text-xs">.env</code> and restart to submit transcripts and notes and review what is drawn from them.
        </EmptyState>
      </>
    );
  }
  const showClaimsOf = (docId: string) => { setSource(docId); setSection('claims'); };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Intake"
        description="What people said in calls and notes, broken into claims and questions. Agents only see the claims you accept; an opinion is never given to them."
        actions={
          <Select aria-label="project" value={project} onChange={(e) => setProject(e.target.value)} className="w-44">
            <option value="">all projects</option>
            {projects.map((p) => <option key={p}>{p}</option>)}
          </Select>
        }
      />
      <div className="shrink-0 border-b border-line px-4 py-2 md:px-6">
        <Tabs label="intake section" value={section} options={INTAKE_SECTIONS} onChange={setSection} />
      </div>
      {section === 'sources' && <SourcesTab key={project} project={project} projects={projects} names={names} onPeopleChanged={reloadPeople} onShowClaims={showClaimsOf} />}
      {section === 'claims' && <ClaimsTab key={`${project}:${source}`} project={project} projects={projects} source={source} onClearSource={() => setSource('')} names={names} people={people} ensureNames={ensureNames} />}
      {section === 'questions' && <QuestionsTab key={project} project={project} projects={projects} names={names} people={people} />}
      {section === 'conflicts' && <ConflictsTab key={project} project={project} />}
      {section === 'people' && <PeopleTab people={people} onChanged={reloadPeople} />}
    </div>
  );
}

/** The ticked rows of a list, cleared when the list is loaded again. */
function usePicked(reset: unknown[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), reset);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { picked, setPicked, toggle };
}

// ── Claims ────────────────────────────────────────────────────────────────

type ClaimDraft = { statement: string; type: ClaimType; about: string; area: string; files: string; kind: FactKind | ''; fileUnder: string };
const draftOf = (c: ListedClaim): ClaimDraft => ({ statement: c.statement, type: c.type, about: c.about, area: c.scope.area ?? '', files: c.scope.files.join(', '), kind: '', fileUnder: '' });
const filesOf = (s: string) => s.split(/[,\n]/).map((f) => f.trim()).filter(Boolean);

function ClaimsTab({ project, projects, source, onClearSource, names, people, ensureNames }: {
  project: string; projects: string[]; source: string; onClearSource: () => void; names: Map<string, string>; people: Person[]; ensureNames: (ids: (string | null)[]) => void;
}) {
  const writes = useOwnerWrites();
  const locked = writes ? {} : { readOnly: true, title: READ_ONLY_TITLE };
  const [status, setStatus] = useState<ClaimStatus>(() => (CLAIM_TABS.includes(hashFilters().get('status') as ClaimStatus) ? hashFilters().get('status') as ClaimStatus : 'proposed'));
  const [type, setType] = useState<ClaimType | ''>('');
  const [speaker, setSpeaker] = useState('');
  const list = usePaged<ListedClaim>(
    (offset) => intakeApi.claims({ status, ...(type && { type }), ...(project && { project }), ...(speaker && { person: speaker }), ...(source && { source }), offset }),
    (c) => c.id, [status, type, speaker, project, source],
  );
  const { items, setItems } = list;
  useEffect(() => ensureNames(items.map((c) => c.speakerId)), [items, ensureNames]);
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [status, type, speaker]);
  const { picked, setPicked, toggle } = usePicked([status, type, speaker, list.loaded]);
  const current = items[selected];
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [draft, setDraft] = useState<ClaimDraft | null>(null);
  const [error, setError] = useState<ReactNode>(null);
  const [undo, setUndo] = useState<{ claim: ListedClaim; message: string } | null>(null);
  const [pending, run] = usePending<'accepted' | 'rejected' | 'opinion' | 'save' | 'bulk' | 'undo'>();

  useEffect(() => {
    setDetail(null);
    setDraft(null);
    setError(null);
    if (!current) return;
    // An answer for a claim you have moved past must not replace the one you are reading.
    let stale = false;
    intakeApi.claim(current.id).then((d) => { if (!stale) { setDetail(d); setDraft(draftOf(d.claim)); } }, (e) => { if (!stale) setError(errorMessage(e)); });
    return () => { stale = true; };
  }, [current?.id]);
  const ready = !!detail && !!draft && detail.claim.id === current?.id;
  const claim = ready ? detail.claim : null;
  // A proposed claim is reviewed; an accepted opinion can still be re-typed (which gives it to agents).
  const editable = !!claim && (claim.status === 'proposed' || (claim.status === 'accepted' && claim.type === 'opinion' && !claim.factId));

  /** The fields of the draft that differ from the claim. */
  const edits = (): ClaimEdit => {
    if (!claim || !draft) return {};
    const scope = { area: draft.area.trim() || null, files: filesOf(draft.files) };
    return {
      ...(draft.statement.trim() !== claim.statement && { statement: draft.statement.trim() }),
      ...(draft.type !== claim.type && { type: draft.type }),
      ...(draft.about.trim() !== claim.about && draft.about.trim() && { about: draft.about.trim() }),
      ...((scope.area !== claim.scope.area || scope.files.join('\n') !== claim.scope.files.join('\n')) && { scope }),
    };
  };
  const edited = Object.keys(edits()).length > 0;
  const filing = (finalType: ClaimType): ClaimEdit => ({
    ...(draft?.kind && finalType === 'fact' && { kind: draft.kind }),
    ...(claim?.projectKey === null && draft?.fileUnder && { projectKey: draft.fileUnder }),
  });

  /** The claim left this tab: off the list, the next one open. */
  const leave = (id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    setSelected((i) => Math.min(i, items.length - 2));
  };
  const decide = (choice: 'accepted' | 'rejected' | 'opinion') => {
    if (!claim || !detail || !draft) return;
    const changes = edits();
    const finalType = choice === 'opinion' ? 'opinion' : changes.type ?? claim.type;
    if (choice === 'accepted' && finalType !== 'opinion' && claim.projectKey === null && !draft.fileUnder) {
      setError('This claim is global: choose the project its fact is filed under first.');
      return;
    }
    return run(choice, async () => {
      setError(null);
      try {
        const body: ClaimEdit = { ...changes, status: choice === 'opinion' ? 'accepted' : choice, ...(choice === 'opinion' && { asFact: false }), ...(choice !== 'rejected' && filing(finalType)), expect: detail.fingerprint };
        if (choice === 'opinion') delete body.type;
        const { fact } = await intakeApi.editClaim(claim.id, body);
        // A fact agents are given cannot be taken back from here; a rejection or an opinion can.
        setUndo(fact ? null : { claim, message: choice === 'rejected' ? 'Claim rejected.' : 'Kept as an opinion: agents are not given it.' });
        leave(claim.id);
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  };
  const save = () => run('save', async () => {
    if (!claim || !detail) return;
    setError(null);
    try {
      const changes = edits();
      const { claim: saved, fact } = await intakeApi.editClaim(claim.id, { ...changes, ...filing(changes.type ?? claim.type), expect: detail.fingerprint });
      if (saved.status !== status) { leave(claim.id); return; }
      const d = await intakeApi.claim(claim.id);
      setDetail(d);
      setDraft(draftOf(d.claim));
      setItems((xs) => xs.map((x) => (x.id === claim.id ? d.claim : x)));
      if (fact) setUndo(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  });
  const takeBack = () => run('undo', async () => {
    if (!undo) return;
    try {
      await intakeApi.editClaim(undo.claim.id, { status: 'proposed', ...(undo.claim.type !== 'opinion' && { type: undo.claim.type }) });
      setUndo(null);
      if (status === 'proposed') setItems((xs) => [undo.claim, ...xs.filter((x) => x.id !== undo.claim.id)]);
      setSelected(0);
    } catch (e) {
      setError(errorMessage(e));
      setUndo(null);
    }
  });
  const bulk = (decision: 'accepted' | 'rejected', o: { source?: string } = {}) => run('bulk', async () => {
    const ids = [...picked];
    if (o.source && !(await askConfirm({
      title: `Accept every proposed claim from this source?`,
      message: 'Each one that is not an opinion becomes a project fact agents are given. Opinions are accepted as opinions. A global claim is left for you to file under a project.',
      confirmLabel: 'Accept them all',
    }))) return;
    setError(null);
    try {
      const { results } = await intakeApi.decideClaims(o.source ? { source: o.source, status: decision } : { items: ids.map((id) => ({ id, status: decision })) });
      const done = new Set(results.filter((r) => r.ok).map((r) => r.id));
      setItems((xs) => xs.filter((x) => !done.has(x.id)));
      setPicked(new Set(results.filter((r) => !r.ok).map((r) => r.id)));
      setSelected(0);
      setUndo(null);
      setError(bulkFailures(results, 'claim'));
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  const proposed = status === 'proposed';
  const speakers = people.filter((p) => p.status !== 'forgotten');
  return (
    <ReviewList
      label="claims"
      listWidth="24rem"
      items={items}
      idOf={(c) => c.id}
      selected={selected}
      onSelect={setSelected}
      loaded={list.loaded}
      next={list.next !== null}
      loadingMore={list.loadingMore}
      onLoadMore={list.loadMore}
      busy={!!pending}
      notice={(error || list.error) && (typeof (error ?? list.error) === 'string' ? <Alert>{error ?? list.error}</Alert> : error)}
      undo={undo && { message: undo.message, label: 'Undo', onUndo: () => void takeBack() }}
      pick={proposed ? { picked, toggle, label: (c) => c.statement.slice(0, 60) } : undefined}
      keys={[
        { key: 'a', label: 'accept', owner: true, when: proposed && ready, run: () => void decide('accepted') },
        { key: 'r', label: 'reject', owner: true, when: proposed && ready, run: () => void decide('rejected') },
        { key: 'e', label: 'edit', owner: true, when: editable, run: () => document.getElementById('claim-statement')?.focus() },
      ]}
      listHeader={
        <>
          <Tabs label="status" value={status} options={CLAIM_TABS} onChange={(s) => { setStatus(s); setUndo(null); }} />
          {list.loaded && <span className="ml-auto text-xs text-muted tabular-nums">{plural(items.length, 'claim')}{list.next !== null ? ', more waiting' : ''}</span>}
          <div role="group" aria-label="filters" className="grid w-full grid-cols-2 gap-2">
            <Select aria-label="type" size="sm" value={type} onChange={(e) => setType(e.target.value as ClaimType | '')}>
              <option value="">any type</option>
              {CLAIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
            <Select aria-label="speaker" size="sm" value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
              <option value="">anyone</option>
              {speakers.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </Select>
          </div>
          {source && (
            <div className="flex w-full flex-wrap items-center gap-2 text-xs text-muted">
              <span className="min-w-0 truncate">From one source</span>
              <Button size="sm" variant="ghost" onClick={onClearSource}>Show every source</Button>
              {proposed && items.length > 0 && <Button size="sm" variant="primary" owner busy={pending === 'bulk'} onClick={() => void bulk('accepted', { source })}>Accept all from this source</Button>}
            </div>
          )}
          {proposed && items.length > 0 && (
            <BulkBar total={items.length} picked={picked.size} onAll={(all) => setPicked(all ? new Set(items.map((c) => c.id)) : new Set())}>
              <Button size="sm" variant="primary" owner disabled={!picked.size} busy={pending === 'bulk'} onClick={() => void bulk('accepted')}>Accept selected</Button>
              <Button size="sm" owner disabled={!picked.size} busy={pending === 'bulk'} onClick={() => void bulk('rejected')}>Reject selected</Button>
            </BulkBar>
          )}
        </>
      }
      empty={
        type || speaker || source ? (
          <EmptyState compact icon={<IntakeIcon />} title={`No ${status} claims match these filters`} action={<Button size="sm" onClick={() => { setType(''); setSpeaker(''); onClearSource(); }}>Clear filters</Button>} />
        ) : <EmptyState compact icon={<IntakeIcon />} {...CLAIMS_EMPTY[status]} />
      }
      row={(c) => (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="flex min-w-0 items-center gap-1.5">
              <TypeBadge type={c.type} />
              <span className="truncate">{(c.speakerId && names.get(c.speakerId)) ?? 'unknown speaker'} · {c.about}</span>
            </span>
            <span className="shrink-0 tabular-nums" title="how sure the extraction was">{Math.round(c.confidence * 100)}%</span>
          </div>
          <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug">{c.statement}</div>
          {(c.flags.length > 0 || c.conflicts.length > 0) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {c.conflicts.length > 0 && <Badge tone="bad">{plural(c.conflicts.length, 'conflict')}</Badge>}
              {c.flags.map((f) => <Badge key={f} tone="accent" title={FLAG_LABEL[f]?.[1]}>{FLAG_LABEL[f]?.[0] ?? f}</Badge>)}
            </div>
          )}
        </>
      )}
      actions={claim && (proposed || editable) && (
        <>
          {proposed && (
            <>
              <Button variant="primary" owner busy={pending === 'accepted'} onClick={() => void decide('accepted')}>
                {(edits().type ?? claim.type) === 'opinion' ? 'Accept as opinion' : 'Accept as fact'} <Kbd>a</Kbd>
              </Button>
              {(edits().type ?? claim.type) !== 'opinion' && <Button owner busy={pending === 'opinion'} onClick={() => void decide('opinion')}>Keep as opinion</Button>}
              <Button owner busy={pending === 'rejected'} onClick={() => void decide('rejected')}>Reject <Kbd>r</Kbd></Button>
            </>
          )}
          {edited && <Button owner busy={pending === 'save'} onClick={() => void save()} className="ml-auto">Save edits</Button>}
        </>
      )}
    >
      {claim && draft && detail ? (
        <div className="flex min-w-0 flex-col gap-5">
          <header className="grid gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>{claim.projectKey ?? 'global'}</Badge>
              <StatusBadge status={claim.status} />
              <TypeBadge type={claim.type} />
              {claim.flags.map((f) => <Badge key={f} tone="accent" title={FLAG_LABEL[f]?.[1]}>{FLAG_LABEL[f]?.[0] ?? f}</Badge>)}
            </div>
            <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">{claim.statement}</h2>
            <p className="text-xs text-muted">{servedLine(claim)}</p>
          </header>

          <section aria-label="what was said" className="grid gap-1.5">
            <SectionLabel>
              {detail.speaker?.displayName ?? 'Unknown speaker'}
              {(claim.assertedAt ?? detail.source?.occurredAt) && <>, {(claim.assertedAt ?? detail.source!.occurredAt)!.slice(0, 10)}</>}
              {detail.source && <> · {SOURCE_WORD[detail.source.kind]}{detail.source.origin ? ` (${detail.source.origin})` : ''}</>}
            </SectionLabel>
            {claim.quote
              ? <blockquote className="rounded-md border border-accent bg-accent-soft px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] shadow-[inset_3px_0_0_var(--color-accent)]">{claim.quote}</blockquote>
              : <p className="text-[13px] text-muted">You wrote this as an answer.</p>}
          </section>

          {claim.conflicts.length > 0 && (
            <section aria-label="conflicts" className="grid gap-1.5 rounded-md border border-bad/40 bg-bad-soft px-3 py-2.5 text-[13px] text-bad-text">
              <SectionLabel className="text-bad-text">Conflicts with what is already known</SectionLabel>
              <ul className="grid gap-1">
                {claim.conflicts.map((k) => <li key={k.id} className="[overflow-wrap:anywhere]">The {k.with.kind} <code className="font-mono text-xs">{k.with.id}</code> says otherwise.</li>)}
              </ul>
              <p className="text-xs">Accepting it now gives agents both sides until the conflict is settled.</p>
            </section>
          )}

          {editable ? (
            <section aria-label="edit claim" className="grid gap-3">
              <label className="grid gap-1 text-xs font-medium text-muted">
                Statement
                <Textarea id="claim-statement" rows={3} value={draft.statement} onChange={(e) => setDraft({ ...draft, statement: e.target.value })} {...locked} />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs font-medium text-muted">
                  Type
                  <Select aria-label="claim type" value={draft.type} disabled={!writes} onChange={(e) => setDraft({ ...draft, type: e.target.value as ClaimType })}>
                    {CLAIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-muted">
                  About
                  <Input value={draft.about} onChange={(e) => setDraft({ ...draft, about: e.target.value })} {...locked} />
                </label>
                <label className="grid gap-1 text-xs font-medium text-muted">
                  Area
                  <Input value={draft.area} placeholder="billing" onChange={(e) => setDraft({ ...draft, area: e.target.value })} {...locked} />
                </label>
                <label className="grid gap-1 text-xs font-medium text-muted">
                  Files
                  <Input value={draft.files} placeholder="src/retry.ts, src/queue.ts" onChange={(e) => setDraft({ ...draft, files: e.target.value })} {...locked} />
                </label>
                {draft.type === 'fact' && (
                  <label className="grid gap-1 text-xs font-medium text-muted">
                    Fact kind
                    <Select aria-label="fact kind" value={draft.kind} disabled={!writes} onChange={(e) => setDraft({ ...draft, kind: e.target.value as FactKind | '' })}>
                      <option value="">convention (default)</option>
                      {FACT_KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
                    </Select>
                  </label>
                )}
                {claim.projectKey === null && draft.type !== 'opinion' && (
                  <label className="grid gap-1 text-xs font-medium text-muted">
                    File its fact under
                    <Select aria-label="file under project" value={draft.fileUnder} disabled={!writes} onChange={(e) => setDraft({ ...draft, fileUnder: e.target.value })}>
                      <option value="">choose a project…</option>
                      {projects.map((p) => <option key={p}>{p}</option>)}
                    </Select>
                  </label>
                )}
              </div>
              {claim.status === 'accepted' && <p className="text-xs text-muted">Re-typing this opinion as a fact, decision, plan or commitment gives it to agents.</p>}
            </section>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-muted">About</dt><dd className="[overflow-wrap:anywhere]">{claim.about}</dd>
              {claim.scope.area && <><dt className="text-muted">Area</dt><dd>{claim.scope.area}</dd></>}
              {claim.scope.files.length > 0 && <><dt className="text-muted">Files</dt><dd className="font-mono text-xs [overflow-wrap:anywhere]">{claim.scope.files.join(', ')}</dd></>}
              {claim.decidedBy && <><dt className="text-muted">Decided</dt><dd>{claim.decidedBy}{claim.decidedAt && <>, <Time iso={claim.decidedAt} /></>}</dd></>}
            </dl>
          )}
        </div>
      ) : current ? <SkeletonDetail /> : null}
    </ReviewList>
  );
}

/** Whether agents are given this claim, and why. */
function servedLine(c: ListedClaim): string {
  if (c.factId) return `Agents see this: yes, as the fact ${c.factId}.`;
  if (c.status === 'accepted') return 'Agents see this: no. An opinion stays attributed to who said it until you re-type it.';
  if (c.status === 'proposed') return c.type === 'opinion' ? 'Agents see this: no. Accepted, it stays an opinion agents are not given.' : 'Agents see this: no, not until you accept it.';
  return 'Agents see this: no.';
}

const CLAIMS_EMPTY: Record<ClaimStatus, { title: string; children: string }> = {
  proposed: { title: 'No claims waiting', children: 'Add a transcript or notes on the Sources tab and the claims drawn from it land here for you to accept or reject.' },
  accepted: { title: 'Nothing accepted yet', children: 'Accepted facts, decisions, plans and commitments are given to agents; accepted opinions stay here.' },
  rejected: { title: 'Nothing rejected', children: 'Claims you reject stay here, so you can change your mind.' },
  superseded: { title: 'Nothing superseded', children: 'A claim that loses a conflict is kept here, not deleted.' },
};

// ── Questions ─────────────────────────────────────────────────────────────

const KIND_LABEL: Record<Question['kind'], string> = { unanswered: 'unanswered', contradictory: 'contradictory', needs_owner: 'needs an owner' };

function QuestionsTab({ project, projects, names, people }: { project: string; projects: string[]; names: Map<string, string>; people: Person[] }) {
  const writes = useOwnerWrites();
  const locked = writes ? {} : { readOnly: true, title: READ_ONLY_TITLE };
  const [status, setStatus] = useState<QuestionStatus>('open');
  const list = usePaged<Question>((offset) => intakeApi.questions({ status, ...(project && { project }), offset }), (q) => q.id, [status, project]);
  const { items, setItems } = list;
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [status]);
  const current = items[selected];
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [answer, setAnswer] = useState('');
  const [answerType, setAnswerType] = useState<ClaimType>('fact');
  const [fileUnder, setFileUnder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = usePending<'assign' | 'dismiss' | 'reopen' | 'answer'>();
  useEffect(() => {
    setDetail(null);
    setAnswer('');
    setError(null);
    if (!current) return;
    let stale = false;
    intakeApi.question(current.id).then((d) => { if (!stale) setDetail(d); }, (e) => { if (!stale) setError(errorMessage(e)); });
    return () => { stale = true; };
  }, [current?.id]);
  const q = detail && detail.question.id === current?.id ? detail.question : null;

  /** The question changed: it stays here while its status does, else it leaves this tab. */
  const changed = (next: Question) => {
    if (next.status === status) {
      setItems((xs) => xs.map((x) => (x.id === next.id ? next : x)));
      intakeApi.question(next.id).then(setDetail, () => {});
    } else {
      setItems((xs) => xs.filter((x) => x.id !== next.id));
      setSelected((i) => Math.min(i, items.length - 2));
    }
  };
  const update = (key: 'assign' | 'dismiss' | 'reopen', patch: { assignee?: string | null; status?: 'open' | 'dismissed' }) => run(key, async () => {
    if (!q) return;
    setError(null);
    try { changed(await intakeApi.updateQuestion(q.id, patch)); } catch (e) { setError(errorMessage(e)); }
  });
  const submitAnswer = () => run('answer', async () => {
    if (!q || !answer.trim()) return;
    if (answerType !== 'opinion' && q.projectKey === null && !fileUnder) { setError('This question is global: choose the project the answer is filed under, or answer it as an opinion.'); return; }
    setError(null);
    try {
      const out = await intakeApi.answerQuestion(q.id, { text: answer.trim(), type: answerType, ...(q.projectKey === null && fileUnder && { projectKey: fileUnder }) });
      changed(out.question);
    } catch (e) { setError(errorMessage(e)); }
  });
  const open = status === 'open' || status === 'assigned';
  const assignable = people.filter((p) => p.status !== 'forgotten');
  return (
    <ReviewList
      label="questions"
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
      keys={[{ key: 'd', label: 'dismiss', owner: true, when: open && !!q, run: () => void update('dismiss', { status: 'dismissed' }) }]}
      listHeader={
        <>
          <Tabs label="status" value={status} options={QUESTION_TABS} onChange={setStatus} />
          {list.loaded && <span className="ml-auto text-xs text-muted tabular-nums">{plural(items.length, 'question')}{list.next !== null ? ', more waiting' : ''}</span>}
        </>
      }
      empty={<EmptyState compact icon={<IntakeIcon />} title={status === 'open' ? 'No open questions' : `No ${status} questions`}>{status === 'open' ? 'Questions a call left unanswered, contradicted or without an owner land here.' : undefined}</EmptyState>}
      row={(x) => (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="flex min-w-0 items-center gap-1.5"><Badge tone={x.kind === 'contradictory' ? 'bad' : 'info'}>{KIND_LABEL[x.kind]}</Badge><span className="truncate">{x.projectKey ?? 'global'}</span></span>
            {x.assignee && <span className="truncate">to {names.get(x.assignee) ?? 'someone'}</span>}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug">{x.text}</div>
        </>
      )}
      actions={q && open && (
        <>
          <Button owner busy={pending === 'dismiss'} onClick={() => void update('dismiss', { status: 'dismissed' })}>Dismiss <Kbd>d</Kbd></Button>
        </>
      )}
    >
      {q && detail ? (
        <div className="flex min-w-0 flex-col gap-5">
          <header className="grid gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>{q.projectKey ?? 'global'}</Badge>
              <StatusBadge status={q.status} />
              <Badge tone={q.kind === 'contradictory' ? 'bad' : 'info'}>{KIND_LABEL[q.kind]}</Badge>
            </div>
            <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">{q.text}</h2>
            {detail.askedBy && <p className="text-xs text-muted">Asked by {detail.askedBy.displayName}{detail.source?.occurredAt && <>, {detail.source.occurredAt.slice(0, 10)}</>}</p>}
          </header>
          {q.quote && <blockquote className="rounded-md border border-line bg-sunken px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{q.quote}</blockquote>}
          {detail.answer && (
            <section aria-label="answer" className="grid gap-1.5">
              <SectionLabel>Your answer</SectionLabel>
              <p className="[overflow-wrap:anywhere]">{detail.answer.statement}</p>
              <p className="text-xs text-muted">{detail.answer.factId ? `Agents are given it as the fact ${detail.answer.factId}.` : 'An opinion: agents are not given it.'}</p>
            </section>
          )}
          {open && (
            <>
              <section aria-label="assign" className="grid gap-1.5">
                <label className="grid gap-1 text-xs font-medium text-muted">
                  Who should answer it
                  <Select aria-label="assignee" value={q.assignee ?? ''} disabled={!writes || !!pending} onChange={(e) => void update('assign', { assignee: e.target.value || null })}>
                    <option value="">nobody yet</option>
                    {assignable.map((p) => <option key={p.id} value={p.id}>{p.displayName}{p.isOwner ? ' (you)' : ''}</option>)}
                  </Select>
                </label>
              </section>
              <section aria-label="answer it" className="grid gap-2">
                <label className="grid gap-1 text-xs font-medium text-muted">
                  Answer it yourself
                  <Textarea rows={3} value={answer} placeholder="The answer, as one statement" onChange={(e) => setAnswer(e.target.value)} {...locked} />
                </label>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid gap-1 text-xs font-medium text-muted">
                    As a
                    <Select aria-label="answer type" value={answerType} disabled={!writes} onChange={(e) => setAnswerType(e.target.value as ClaimType)} className="w-36">
                      {CLAIM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  </label>
                  {q.projectKey === null && answerType !== 'opinion' && (
                    <label className="grid gap-1 text-xs font-medium text-muted">
                      Filed under
                      <Select aria-label="answer project" value={fileUnder} disabled={!writes} onChange={(e) => setFileUnder(e.target.value)} className="w-40">
                        <option value="">choose a project…</option>
                        {projects.map((p) => <option key={p}>{p}</option>)}
                      </Select>
                    </label>
                  )}
                  <Button variant="primary" owner disabled={!answer.trim()} busy={pending === 'answer'} onClick={() => void submitAnswer()}>Answer</Button>
                </div>
                <p className="text-xs text-muted">{answerType === 'opinion' ? 'Saved as your opinion: agents are not given it.' : 'Saved as your accepted claim and given to agents as a project fact.'}</p>
              </section>
            </>
          )}
          {q.status === 'dismissed' && <div><Button owner busy={pending === 'reopen'} onClick={() => void update('reopen', { status: 'open' })}>Reopen</Button></div>}
        </div>
      ) : current ? <SkeletonDetail /> : null}
    </ReviewList>
  );
}

// ── People ────────────────────────────────────────────────────────────────

function PeopleTab({ people, onChanged }: { people: Person[]; onChanged: () => void }) {
  const writes = useOwnerWrites();
  const locked = writes ? {} : { readOnly: true, title: READ_ONLY_TITLE };
  const [status, setStatus] = useState<PersonStatus>('proposed');
  const items = people.filter((p) => p.status === status);
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [status]);
  const p = items[Math.min(selected, items.length - 1)];
  const [name, setName] = useState('');
  const [alias, setAlias] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = usePending<'rename' | 'confirm' | 'alias' | 'merge' | 'forget'>();
  useEffect(() => { setName(p?.displayName ?? ''); setAlias(''); setMergeInto(''); setError(null); }, [p?.id, p?.displayName]);
  const act = (key: 'rename' | 'confirm' | 'alias' | 'merge' | 'forget', fn: () => Promise<unknown>) => run(key, async () => {
    setError(null);
    try { await fn(); onChanged(); } catch (e) { setError(errorMessage(e)); }
  });
  const merge = () => act('merge', async () => {
    const keep = people.find((x) => x.id === mergeInto);
    if (!p || !keep || !(await askConfirm({ title: `Merge ${p.displayName} into ${keep.displayName}?`, message: `Everything ${p.displayName} said, their aliases and their questions become ${keep.displayName}'s.`, confirmLabel: 'Merge' }))) return;
    await intakeApi.mergePeople(keep.id, p.id);
  });
  const forget = () => act('forget', async () => {
    if (!p || !(await askConfirm({
      title: `Forget ${p.displayName}?`,
      message: 'Their name and aliases are removed, and the claims of theirs you have not accepted are deleted. Accepted claims stay, said by a former participant. This cannot be undone.',
      confirmLabel: 'Forget them',
      typeToConfirm: p.displayName,
    }))) return;
    await intakeApi.forgetPerson(p.id);
  });
  const others = people.filter((x) => p && x.id !== p.id && x.status !== 'forgotten');
  const editable = !!p && p.status !== 'forgotten';
  return (
    <ReviewList
      label="people"
      items={items}
      idOf={(x) => x.id}
      selected={selected}
      onSelect={setSelected}
      loaded
      busy={!!pending}
      notice={error && <Alert>{error}</Alert>}
      keys={[{ key: 'c', label: 'confirm', owner: true, when: p?.status === 'proposed', run: () => void act('confirm', () => intakeApi.updatePerson(p!.id, { status: 'confirmed' })) }]}
      listHeader={<Tabs label="status" value={status} options={PEOPLE_TABS} onChange={setStatus} />}
      empty={<EmptyState compact icon={<IntakeIcon />} title={status === 'proposed' ? 'Nobody to confirm' : `No ${status} people`}>{status === 'proposed' ? 'A speaker label nobody has is proposed as a new person here: confirm them, or merge them into someone you know.' : undefined}</EmptyState>}
      row={(x) => (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium"><span className="truncate">{x.displayName}</span>{x.isOwner && <Badge tone="accent">you</Badge>}</span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{plural(x.claims, 'claim')}</span>
          </div>
          {x.aliases.length > 0 && <div className="mt-0.5 truncate text-xs text-muted">{x.aliases.join(', ')}</div>}
        </>
      )}
      actions={p?.status === 'proposed' && <Button variant="primary" owner busy={pending === 'confirm'} onClick={() => void act('confirm', () => intakeApi.updatePerson(p.id, { status: 'confirmed' }))}>Confirm <Kbd>c</Kbd></Button>}
    >
      {p ? (
        <div className="flex min-w-0 flex-col gap-5">
          <header className="grid gap-2">
            <div className="flex flex-wrap items-center gap-1.5"><StatusBadge status={p.status} />{p.isOwner && <Badge tone="accent">you</Badge>}</div>
            <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{p.displayName}</h2>
            <p className="text-xs text-muted">{plural(p.claims, 'claim')} said · since <Time iso={p.createdAt} /></p>
          </header>
          {editable && (
            <>
              <section aria-label="name" className="flex flex-wrap items-end gap-2">
                <label className="grid flex-1 gap-1 text-xs font-medium text-muted">
                  Name
                  <Input value={name} onChange={(e) => setName(e.target.value)} {...locked} />
                </label>
                <Button owner disabled={!name.trim() || name.trim() === p.displayName} busy={pending === 'rename'} onClick={() => void act('rename', () => intakeApi.updatePerson(p.id, { displayName: name.trim() }))}>Rename</Button>
              </section>
              <section aria-label="aliases" className="grid gap-2">
                <SectionLabel>Aliases</SectionLabel>
                <p className="text-xs text-muted">Speaker labels and names that are this person (case, accents and “Last, First” do not matter).</p>
                <ul className="flex flex-wrap gap-1.5">
                  {p.aliases.map((a) => (
                    <li key={a} className="inline-flex items-center gap-1 rounded-sm border border-line bg-sunken py-0.5 pr-0.5 pl-2 text-xs">
                      {a}
                      <Button size="sm" variant="ghost" owner aria-label={`remove alias ${a}`} busy={pending === 'alias'} onClick={() => void act('alias', () => intakeApi.updatePerson(p.id, { removeAliases: [a] }))}>×</Button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-end gap-2">
                  <Input aria-label="new alias" placeholder="Add an alias" value={alias} onChange={(e) => setAlias(e.target.value)} className="flex-1" {...locked} />
                  <Button owner disabled={!alias.trim()} busy={pending === 'alias'} onClick={() => void act('alias', async () => { await intakeApi.updatePerson(p.id, { addAliases: [alias.trim()] }); setAlias(''); })}>Add</Button>
                </div>
              </section>
              {!p.isOwner && (
                <section aria-label="merge or forget" className="grid gap-3 border-t border-line pt-4">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="grid flex-1 gap-1 text-xs font-medium text-muted">
                      The same person as
                      <Select aria-label="merge into" value={mergeInto} disabled={!writes} onChange={(e) => setMergeInto(e.target.value)}>
                        <option value="">choose someone…</option>
                        {others.map((x) => <option key={x.id} value={x.id}>{x.displayName}{x.isOwner ? ' (you)' : ''}</option>)}
                      </Select>
                    </label>
                    <Button owner disabled={!mergeInto} busy={pending === 'merge'} onClick={() => void merge()}>Merge</Button>
                  </div>
                  <div><Button variant="danger-outline" owner busy={pending === 'forget'} onClick={() => void forget()}>Forget this person</Button></div>
                </section>
              )}
            </>
          )}
        </div>
      ) : null}
    </ReviewList>
  );
}

// ── Sources ───────────────────────────────────────────────────────────────

export type SourceState = 'queued' | 'reading' | 'done' | 'failed';
/**
 * Where a source is, from its document: being embedded or embedding failed (embed), then waiting to be read, reading
 * (some windows done), read, or given up (read). error: why it failed, or why it waits after a failed try.
 */
export function sourceState(s: Pick<IntakeSource, 'embed' | 'read' | 'intake'>): { state: SourceState; error: string | null } {
  if (s.embed) return { state: s.embed.status === 'failed' ? 'failed' : 'queued', error: s.embed.error ?? null };
  const r = s.read;
  if (!r) return { state: 'queued', error: null };
  if (r.status === 'pending') return { state: s.intake?.windowsDone ? 'reading' : 'queued', error: r.error };
  return { state: r.status, error: r.error };
}

/** queued, reading window 3/8, done, failed. */
export function sourceStateLabel(s: Pick<IntakeSource, 'embed' | 'read' | 'intake'>): string {
  const { state } = sourceState(s);
  if (state !== 'reading' || !s.intake) return state;
  const { windowsDone, windowsTotal } = s.intake;
  return `reading window ${Math.min(windowsDone + 1, windowsTotal ?? Infinity)}/${windowsTotal ?? '?'}`;
}
const STATE_TONE: Record<SourceState, Tone> = { queued: 'info', reading: 'info', done: 'ok', failed: 'bad' };

/** The source's text with the spans claims were drawn from marked. */
function SourceText({ text, spans = [] }: { text: string; spans?: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at || s.end > text.length) continue;
    parts.push(text.slice(at, s.start), <mark key={s.start} className="rounded-xs bg-accent-soft text-accent-text">{text.slice(s.start, s.end)}</mark>);
    at = s.end;
  }
  parts.push(text.slice(at));
  return <pre className="max-h-[32rem] overflow-auto rounded-md border border-line bg-sunken px-3 py-2.5 font-sans text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{parts}</pre>;
}

/**
 * Add a source: paste it, or pick a .txt, .md, .vtt or .srt file. Private (never synced) is its own choice, ticked when
 * the dialog opens: changing the kind never changes it.
 */
function AddSource({ open, projects, project, onClose, onAdded }: { open: boolean; projects: string[]; project: string; onClose: () => void; onAdded: () => void }) {
  const blank = (): IntakeUpload & { people: string } => ({ projectKey: project || projects[0] || '', kind: 'transcript', title: '', text: '', occurredAt: null, people: '', private: true });
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = usePending<'add'>();
  useEffect(() => { if (open) { setF(blank()); setError(null); } }, [open]);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setF((x) => ({ ...x, text, name: file.name.replace(/[^\w .()-]/g, '_').replace(/^[^\w]+/, '').slice(0, 200) || undefined, title: x.title || file.name.replace(/\.[^.]+$/, '') }));
  };
  const add = () => run('add', async () => {
    setError(null);
    if (!f.projectKey || !f.title.trim() || !f.text.trim()) { setError('Choose a project, give it a title and paste or pick its text.'); return; }
    const { people, ...b } = f;
    try {
      await intakeApi.addSource({ ...b, title: b.title.trim(), participants: people.split(',').map((x) => x.trim()).filter(Boolean), occurredAt: b.occurredAt || null });
      onAdded();
    } catch (e) { setError(errorMessage(e)); }
  });
  if (!open) return null;
  const busy = pending === 'add';
  // Each field is named by its visible label, so what you see is what a screen reader or a test finds.
  return (
    <Dialog
      title="Add a source"
      busy={busy}
      onCancel={onClose}
      footer={<>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void add()} busy={busy}>{busy ? 'Adding…' : 'Add'}</Button>
      </>}
    >
      <p className="text-muted">Its text is read into claims and questions for you to review. Credentials and contact details are removed before it is stored; agents never see the text.</p>
      <div className="grid gap-2 text-[13px]">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="grid gap-1"><span className="text-xs text-muted">Project</span>
            <Select value={f.projectKey} onChange={(e) => setF({ ...f, projectKey: e.target.value })}>
              {projects.map((p) => <option key={p}>{p}</option>)}
            </Select>
          </label>
          <label className="grid gap-1"><span className="text-xs text-muted">Kind</span>
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as IntakeKind })}>
              {INTAKE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
          </label>
          <label className="grid gap-1"><span className="text-xs text-muted">Title</span><Input value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="grid gap-1"><span className="text-xs text-muted">When it was said</span><Input type="date" value={f.occurredAt ?? ''} onChange={(e) => setF({ ...f, occurredAt: e.target.value || null })} /></label>
        </div>
        <label className="grid gap-1"><span className="text-xs text-muted">Who was there (comma-separated)</span><Input value={f.people} onChange={(e) => setF({ ...f, people: e.target.value })} /></label>
        <label className="grid gap-1"><span className="text-xs text-muted">Text</span><Textarea rows={8} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value, name: undefined })} className="font-mono text-xs" /></label>
        <label className="grid gap-1"><span className="text-xs text-muted">Or a file (.txt, .md, .vtt, .srt)</span>
          <input type="file" accept=".txt,.md,.vtt,.srt,text/plain,text/markdown,text/vtt" onChange={(e) => void pick(e.target.files?.[0])} className="max-w-full text-xs" />
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={!!f.private} onChange={(e) => setF({ ...f, private: e.target.checked })} className="mt-0.5" />
          <span>Private (never synced)<span className="block text-xs text-muted">Its accepted claims never leave this install, even with SYNC_CLAIMS. Your choice, whatever its kind.</span></span>
        </label>
      </div>
      {error && <Alert>{error}</Alert>}
    </Dialog>
  );
}

function SourcesTab({ project, projects, names, onShowClaims, onPeopleChanged }: {
  project: string; projects: string[]; names: Map<string, string>; onShowClaims: (docId: string) => void; onPeopleChanged: () => void;
}) {
  const [items, setItems] = useState<IntakeSource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<IntakeSourceDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [keep, setKeep] = useState<'facts' | 'none'>('facts');
  const [pending, run] = usePending<'reread' | 'delete'>();
  const [adding, setAdding] = useState(false);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let stale = false;
    intakeApi.sources(project || undefined).then((s) => { if (!stale) { setItems(s); setLoaded(true); } }, (e) => { if (!stale) { setError(errorMessage(e)); setLoaded(true); } });
    return () => { stale = true; };
  }, [project, reloads]);
  const current = items[selected];
  // While a source is queued or being read, the list and the open source are read again every few seconds, so its
  // state and its claims count follow the background reading without a page reload.
  const reading = items.some((x) => sourceState(x).state === 'queued' || sourceState(x).state === 'reading');
  useEffect(() => {
    if (!reading) return;
    const t = setTimeout(() => setReloads((n) => n + 1), SOURCE_POLL_MS);
    return () => clearTimeout(t);
  }, [reading, items]);
  useEffect(() => {
    setDetail((d) => (d && d.id === current?.id ? d : null));
    if (!current) return;
    let stale = false;
    intakeApi.source(current.id).then((d) => { if (!stale) setDetail(d); }, () => {});
    return () => { stale = true; };
  }, [current?.id, reloads]);
  const s = detail && detail.id === current?.id ? detail : current;
  const meta = s?.intake ?? null;
  const stateOf = s ? sourceState(s) : null;
  const spans = detail?.claims.flatMap((c) => (c.span ? [c.span] : [])) ?? [];
  const reread = () => run('reread', async () => {
    if (!s) return;
    setError(null);
    try {
      await intakeApi.rereadSource(s.id);
      const queued = (x: IntakeSource): IntakeSource => ({ ...x, read: x.read && { ...x.read, status: 'pending', error: null }, intake: x.intake && { ...x.intake, windowsDone: 0 } });
      setItems((xs) => xs.map((x) => (x.id === s.id ? queued(x) : x)));
      setDetail((d) => (d && d.id === s.id ? { ...d, ...queued(d) } : d));
    } catch (e) { setError(errorMessage(e)); }
  });
  const remove = () => run('delete', async () => {
    if (!s) return;
    setError(null);
    try {
      await intakeApi.deleteSource(s.id, keep);
      setDeleting(false);
      setItems((xs) => xs.filter((x) => x.id !== s.id));
      setSelected((i) => Math.max(0, Math.min(i, items.length - 2)));
    } catch (e) { setError(errorMessage(e)); }
  });
  return (
    <ReviewList
      label="sources"
      items={items}
      idOf={(x) => x.id}
      selected={selected}
      onSelect={setSelected}
      loaded={loaded}
      busy={!!pending}
      notice={error && <Alert>{error}</Alert>}
      listHeader={loaded && (
        <span className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-muted tabular-nums">{plural(items.length, 'source')}</span>
          <Button size="sm" owner onClick={() => setAdding(true)}>Add a source</Button>
          <AddSource open={adding} projects={projects} project={project} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); setSelected(0); setReloads((n) => n + 1); onPeopleChanged(); }} />
        </span>
      )}
      empty={
        <EmptyState compact icon={<IntakeIcon />} title="Nothing submitted yet">
          Add a transcript or notes with <strong>Add a source</strong>, or send one with <code className="font-mono text-xs">POST /api/intake</code>; it is read in the background.
        </EmptyState>
      }
      row={(x) => (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="flex min-w-0 items-center gap-1.5">{x.intake && <Badge>{SOURCE_WORD[x.intake.kind]}</Badge>}<span className="truncate">{x.projectKey}{x.intake?.occurredAt ? ` · ${x.intake.occurredAt.slice(0, 10)}` : ''}</span></span>
            <Badge tone={STATE_TONE[sourceState(x).state]} dot>{sourceStateLabel(x)}</Badge>
          </div>
          <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug">{x.title}</div>
        </>
      )}
      actions={s && (
        <>
          <Button variant="primary" onClick={() => onShowClaims(s.id)}>Review its claims</Button>
          <Button owner busy={pending === 'reread'} disabled={stateOf?.state === 'queued' || stateOf?.state === 'reading'} onClick={() => void reread()}>Read again</Button>
          <Button variant="danger-outline" owner className="ml-auto" onClick={() => setDeleting(true)}>Delete</Button>
        </>
      )}
    >
      {s ? (
        <div className="flex min-w-0 flex-col gap-5">
          <header className="grid gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>{s.projectKey}</Badge>
              <Badge tone={STATE_TONE[stateOf!.state]} dot>{sourceStateLabel(s)}</Badge>
              {meta && <Badge>{SOURCE_WORD[meta.kind]}</Badge>}
              {meta?.private && <Badge title="never synced, even with SYNC_CLAIMS">private</Badge>}
            </div>
            <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{s.title}</h2>
          </header>
          {stateOf!.error && <Alert>{stateOf!.state === 'failed' ? 'Reading it failed' : 'The last try failed'}: {stateOf!.error}</Alert>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-muted">When</dt><dd>{meta?.occurredAt?.slice(0, 10) ?? 'not given'}</dd>
            {meta?.origin && <><dt className="text-muted">From</dt><dd className="[overflow-wrap:anywhere]">{meta.origin}</dd></>}
            <dt className="text-muted">Who was there</dt><dd>{meta?.participants.length ? meta.participants.map((id) => names.get(id) ?? 'someone').join(', ') : 'not given'}</dd>
            <dt className="text-muted">Added</dt><dd><Time iso={s.addedAt} /></dd>
            {detail?.id === s.id && <><dt className="text-muted">Claims</dt><dd className="tabular-nums">{plural(detail.claims.length, 'claim')}</dd></>}
          </dl>
          {detail?.id === s.id && detail.text !== null && (
            <section aria-label="source text" className="grid gap-1.5">
              <SectionLabel>What was said{spans.length ? ', with the quotes claims were drawn from marked' : ''}</SectionLabel>
              <SourceText text={detail.text} spans={spans} />
            </section>
          )}
          <ConfirmDialog
            open={deleting}
            title={`Delete “${s.title}”?`}
            message="Its text, excerpts, the claims you have not accepted and its questions are removed."
            confirmLabel="Delete"
            busyLabel="Deleting…"
            busy={pending === 'delete'}
            error={error}
            onCancel={() => setDeleting(false)}
            onConfirm={() => void remove()}
          >
            <fieldset className="grid gap-1.5 text-[13px]">
              <legend className="mb-1 text-xs font-medium text-muted">What it told agents</legend>
              <label className="flex items-start gap-2"><input type="radio" name="keep" checked={keep === 'facts'} onChange={() => setKeep('facts')} className="mt-1" /> Keep the facts from claims you accepted</label>
              <label className="flex items-start gap-2"><input type="radio" name="keep" checked={keep === 'none'} onChange={() => setKeep('none')} className="mt-1" /> Remove everything from it: every claim, its facts and the proposed people only it named (Undo on Decisions re-opens the facts)</label>
            </fieldset>
          </ConfirmDialog>
        </div>
      ) : null}
    </ReviewList>
  );
}
