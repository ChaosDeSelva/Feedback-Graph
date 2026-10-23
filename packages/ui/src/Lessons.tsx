import { useEffect, useState, type ReactNode } from 'react';
import { ActivityEntry } from './Activity.tsx';
import { hashFocus } from './links.ts';
import { api, type Activity, type Lesson, type LessonDetail, type LessonEdit, type LessonStatus } from './api.ts';
import { confirmDiscard, useUnsavedChanges } from './unsaved.ts';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, Input, Select, Tabs, Textarea } from './ui/controls.tsx';
import { Alert, Badge, Card, CauseBadge, causeLabel, causeTone, EmptyState, plural, SectionLabel, SkeletonDetail, SkeletonList, StatusBadge, tableClass, tdClass, TONE_FILL } from './ui/display.tsx';
import { LessonIcon } from './ui/icons.tsx';

const TABS: LessonStatus[] = ['proposed', 'approved', 'rejected', 'superseded'];

type Draft = Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope'>;

const EMPTY: Record<LessonStatus, { title: string; children: string }> = {
  proposed: { title: 'No lessons to review', children: 'Each feedback item you confirm in the Inbox gets a post-mortem, and its proposed lesson waits here.' },
  approved: { title: 'No approved lessons yet', children: 'Approve a proposed lesson and agents start receiving it with their task context.' },
  rejected: { title: 'Nothing rejected', children: 'Lessons you reject or revoke stay here, so you can put them back up for review.' },
  superseded: { title: 'Nothing superseded', children: 'When a newer lesson replaces an older one, the older one moves here.' },
};

export function Lessons() {
  const [status, setStatus] = useState<LessonStatus>('proposed');
  const [items, setItems] = useState<Lesson[]>([]);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<LessonDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [history, setHistory] = useState<Activity[]>([]);
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
    // The answer for a tab you have left must not fill the one you are on.
    let stale = false;
    api.lessons(status).then((l) => {
      if (stale) return;
      const at = focus ? l.findIndex((x) => x.id === focus) : -1;
      setItems(l);
      setSelected(Math.max(0, at));
      setOpen(at >= 0);
      setLoaded(true);
    }, (e) => { if (!stale) { setError(String(e)); setLoaded(true); } });
    return () => { stale = true; };
  }, [status]);

  const current = items[selected];
  useEffect(() => {
    setDetail(null);
    setDraft(null);
    setHistory([]);
    setError(null);
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

  // Edits live only here until Approve: moving to another lesson, tab or page asks before dropping them.
  const edited = !!detail && !!draft && detail.lesson.id === current?.id &&
    (['title', 'rule', 'appliesWhen', 'scope'] as const).some((k) => draft[k] !== detail.lesson[k]);
  useUnsavedChanges(edited, 'Your edits to this lesson are not saved.');

  async function decide(next: 'approved' | 'rejected' | 'proposed') {
    if (!current || !detail || !draft || detail.lesson.id !== current.id) return;
    const patch: LessonEdit = { status: next };
    if (next === 'approved') {
      for (const k of ['title', 'rule', 'appliesWhen', 'scope'] as const) {
        if (draft[k] !== detail.lesson[k]) (patch as Record<string, unknown>)[k] = draft[k];
      }
    }
    setError(null);
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
      <PageHeader title="Lessons" description="Rules drawn from confirmed misses. Agents only ever see the ones you approve." />
      <SplitPane
        listLabel="lessons"
        listWidth="24rem"
        listHeader={
          <>
            <Tabs label="status" value={status} options={TABS} onChange={(s) => { if (s !== status && confirmDiscard()) setStatus(s); }} />
            {loaded && <span className="ml-auto text-xs text-muted tabular-nums">{plural(items.length, 'lesson')}</span>}
          </>
        }
        detailOpen={open && items.length > 0}
        onBack={() => setOpen(false)}
        notice={error && <Alert>{error}</Alert>}
        list={
          !loaded ? <SkeletonList /> : items.length === 0 ? (
            <EmptyState compact icon={<LessonIcon />} {...EMPTY[status]} />
          ) : (
            <ul>
              {items.map((l, i) => (
                <li key={l.id}>
                  <ListRow selected={i === selected} onClick={() => { if (i === selected || confirmDiscard()) { setSelected(i); setOpen(true); } }}>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className="truncate">{l.projectKey ?? 'global'} · {l.source}</span>
                      {l.cause && (
                        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
                          <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE_FILL[causeTone(l.cause)]}`} />
                          <span className="truncate">{causeLabel(l.cause)}</span>
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug">{l.title}</div>
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
                  </div>
                  <h2 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-balance [overflow-wrap:anywhere]">{detail.lesson.title}</h2>
                </header>

                {detail.feedback && (
                  <section className="grid gap-1.5">
                    <SectionLabel>You said</SectionLabel>
                    <blockquote className="rounded-md border border-accent bg-accent-soft px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] shadow-[inset_3px_0_0_var(--color-accent)]">
                      {detail.feedback.text}
                    </blockquote>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span className="min-w-0 [overflow-wrap:anywhere]">session <span className="font-mono">{detail.feedback.sessionId}</span></span>
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
                    <span className="text-xs text-muted">prefer the narrowest scope the evidence supports</span>
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
                    <span className="text-xs text-muted">Approve saves your edits above.</span>
                  </>
                )}
                {status === 'approved' && (
                  <>
                    <Button variant="danger-outline" onClick={() => decide('rejected')}>Revoke</Button>
                    <span className="text-xs text-muted">Agents stop getting it straight away. Edits above are saved with Approve on the proposed tab.</span>
                  </>
                )}
                {status === 'rejected' && <Button onClick={() => decide('proposed')}>Back to proposed</Button>}
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
