import { asIs, labelOf } from './labels.ts';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, type ProjectSummary, errorMessage } from './api.ts';
import { CHAT_PROVIDERS, type ChatConversation, type ChatProvider, type ChatSource, type ChatThread, type ChatTurn } from '@fb/core/chat';
import { chatHref, hashFocus, hashNewChat, moduleHref, sourceHref } from './links.ts';
import { askConfirm } from './ui/ConfirmDialog.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, buttonClass, CopyButton, Select, Textarea, useFocusHandoff, usePending } from './ui/controls.tsx';
import { Alert, Badge, Card, EmptyState, Kbd, SectionLabel, plural, SkeletonDetail, SkeletonList, Time, type Tone } from './ui/display.tsx';
import { AskIcon, TrashIcon } from './ui/icons.tsx';
import { Markdown } from './ui/Markdown.tsx';
import { ScrollArea } from './ui/ScrollArea.tsx';

/** How often an open conversation is fetched again while its answer is being written. */
const MAX_POLL_FAILURES = 5;
const POLL_MS = 2000;
/** How often the conversation list is fetched again while one in it is being answered (it may not be the open one). */
const LIST_POLL_MS = 5000;
/** The API refuses longer questions. */
const MAX_QUESTION = 4000;
const TITLE_MAX = 60;

const PROVIDER_LABEL: Record<ChatProvider, string> = { claude: 'Claude', codex: 'Codex', local: 'Local model' };
const SOURCE_TONE: Record<ChatSource['kind'], Tone> = { lesson: 'ok', miss: 'bad', fact: 'accent', code: 'info', doc: 'neutral', session: 'neutral', linked: 'neutral', claim: 'accent', question: 'neutral', conflict: 'violet' };

const isPending = (t: ChatTurn) => t.status === 'pending' || t.status === 'answering';
const threadPending = (t: ChatThread | null) => !!t && (t.pending || t.turns.some(isPending));
/** "Claude" for claude / claude-cli, "Codex" for codex / codex-cli; any other provider id as it is. */
function providerName(turnProvider: string | null, chosen: ChatProvider | null): string {
  const p = turnProvider ?? chosen;
  if (!p) return 'the default model';
  if (p.startsWith('claude')) return 'Claude';
  if (p.startsWith('codex')) return 'Codex';
  if (p === 'local') return 'the local model';
  return p;
}
/** Latest message first, as the server sorts them; the page re-sorts after its own sends without waiting for it. */
const byRecent = (cs: ChatConversation[]) => [...cs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? 1 : -1));
/** The conversation a link opened the page on (`#ask/<id>`), never the `#ask/new?…` form. */
const linkedConversation = () => (hashNewChat() ? null : hashFocus('ask'));
/** Writes the address without a history entry, so Back never re-runs a `#ask/new` link. */
const setAddress = (hash: string) => history.replaceState(history.state, '', hash);

type Draft = { project: string; provider: ChatProvider | '' };

/**
 * Ask: conversations about one project (and its confirmed linked projects). Each answer comes from what the tool knows
 * (lessons, misses, code map, docs), names examples with their usages, cites its sources, and ends with a prompt to paste
 * into Claude Code or Codex. Answers are written by the worker, so a sent question is polled until it is answered.
 */
export function Chat() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [project, setProject] = useState('');
  const [convs, setConvs] = useState<ChatConversation[] | null>(null);
  const [listTick, setListTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(linkedConversation);
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // On a phone the list and the conversation take turns; this is true while the conversation is showing.
  const [open, setOpen] = useState(() => !!linkedConversation() || !!hashNewChat());
  const threadRef = useRef(thread);
  threadRef.current = thread;
  // A `#ask/new` link starts its conversation once, even when StrictMode runs the effect twice.
  const linkDone = useRef(false);
  // While a new chat is being written or created, a list refresh must not open another conversation instead. The page
  // opens on a new chat unless a link names a conversation: an old one open with the composer ready would take the
  // next question as a follow-up to it.
  const holdOpen = useRef(!linkedConversation());

  useEffect(() => {
    api.projects().then((ps) => setProjects([...ps].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))), (e) => { setError(errorMessage(e)); setProjects([]); });
  }, []);
  // With its projects known, a page not opened on a conversation starts a new chat (a #ask/new link starts its own).
  const startedNew = useRef(false);
  useEffect(() => {
    if (startedNew.current || !projects?.length || linkedConversation() || hashNewChat()) return;
    startedNew.current = true;
    setDraft((d) => d ?? { project: project || projects[0].key, provider: '' });
  }, [projects]);

  useEffect(() => {
    let stale = false;
    api.chats(project || undefined).then((cs) => {
      if (stale) return;
      setConvs(byRecent(cs));
      // Wider screens open the newest conversation, unless a link or a new chat is on the way.
      setSelected((cur) => cur ?? (holdOpen.current ? null : cs[0]?.id ?? null));
    }, (e) => { if (!stale) { setError(errorMessage(e)); setConvs([]); } });
    return () => { stale = true; };
  }, [project, listTick]);

  // A conversation answering in the background (not the open one, which polls itself) moves up and drops its
  // "answering" badge once answered: the list is fetched again while any listed conversation is pending.
  useEffect(() => {
    if (!convs?.some((c) => c.pending)) return;
    const t = setTimeout(() => setListTick((n) => n + 1), LIST_POLL_MS);
    return () => clearTimeout(t);
  }, [convs]);

  // The open conversation. One just created or sent to is already in hand and is not fetched again.
  useEffect(() => {
    if (!selected) { setThread(null); return; }
    if (threadRef.current?.id === selected) return;
    setThread(null);
    let stale = false;
    api.chat(selected).then((t) => { if (!stale) setThread(t); }, (e) => { if (!stale) setError(errorMessage(e)); });
    return () => { stale = true; };
  }, [selected]);

  // Poll while an answer is being written; each fetched thread schedules the next, so it stops once nothing is pending.
  const [pollTick, setPollTick] = useState(0);
  // Failed polls in a row: a conversation deleted elsewhere (another tab, fg) would otherwise be asked for forever.
  const pollFailures = useRef(0);
  useEffect(() => {
    if (!thread || !threadPending(thread)) return;
    const id = thread.id;
    const t = setTimeout(() => {
      api.chat(id).then((next) => {
        pollFailures.current = 0;
        if (threadRef.current?.id !== id) return;
        setThread(next);
        if (!threadPending(next)) setListTick((n) => n + 1);
      }, (e) => {
        if (threadRef.current?.id !== id) return;
        if (++pollFailures.current < MAX_POLL_FAILURES) return setPollTick((n) => n + 1);
        setError(`Stopped checking for the answer: ${errorMessage(e)}. Reload the page to look again.`);
      });
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [thread, pollTick]);

  // `#ask/new?project=<key>&q=<text>` (the Dashboard's Ask box): start that conversation and ask straight away.
  useEffect(() => {
    const run = () => {
      const link = hashNewChat();
      if (!link) return;
      if (!link.project) { holdOpen.current = false; setAddress('#ask'); setError('That link names no project to ask about.'); return; }
      // The model the Dashboard picked; anything else in the link is ignored (the default model answers).
      const provider = (CHAT_PROVIDERS as readonly string[]).includes(link.provider ?? '') ? (link.provider as ChatProvider) : null;
      if (!link.q) { setAddress('#ask'); setDraft({ project: link.project, provider: provider ?? '' }); setSelected(null); setOpen(true); return; }
      setAddress('#ask');
      void start(link.project, provider, link.q);
    };
    if (!linkDone.current) { linkDone.current = true; run(); }
    // A link followed while the page is open: a new chat from it, or another conversation.
    const onHash = () => {
      if (hashNewChat()) return run();
      const id = linkedConversation();
      if (id && id !== threadRef.current?.id) select(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function select(id: string) {
    holdOpen.current = false;
    setDraft(null);
    setError(null);
    setText('');
    setSelected(id);
    setOpen(true);
    setAddress(chatHref(id));
  }

  function newChat() {
    // The button is enabled only once there is a project to ask about.
    const p = project || projects![0].key;
    holdOpen.current = true;
    setDraft({ project: p, provider: '' });
    setSelected(null);
    setError(null);
    setText('');
    setOpen(true);
    setAddress('#ask');
  }

  /** Creates the conversation, then asks its first question (titled by it). */
  async function start(projectKey: string, provider: ChatProvider | null, question: string) {
    setSending(true);
    setError(null);
    let created: ChatConversation | null = null;
    try {
      created = await api.createChat({ project: projectKey, ...(provider ? { provider } : {}), title: question.slice(0, TITLE_MAX) });
      const t = await api.sendChat(created.id, question);
      threadRef.current = t;
      setThread(t);
      setText('');
    } catch (e) {
      setError(errorMessage(e));
      setText(question);
    } finally {
      setSending(false);
    }
    if (created) {
      holdOpen.current = false;
      setDraft(null);
      setSelected(created.id);
      setOpen(true);
      setAddress(chatHref(created.id));
      setListTick((n) => n + 1);
    }
  }

  /** A follow-up in the open conversation (the form is shown only with one open). */
  async function send(question: string) {
    setSending(true);
    setError(null);
    try {
      const next = await api.sendChat(thread!.id, question);
      setThread(next);
      setText('');
      // It has the newest message now: to the top at once, then the list as the server has it.
      const at = new Date().toISOString();
      setConvs((cs) => cs && byRecent(cs.map((c) => (c.id === next.id ? { ...c, updatedAt: at, pending: true } : c))));
      setListTick((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const q = text.trim();
    if (!q || sending) return;
    if (draft) void start(draft.project, draft.provider || null, q);
    else void send(q);
  }

  // A retry or a delete in flight: its button says so and a second press sends nothing.
  const [acting, runAction] = usePending<'retry' | 'delete'>();
  const retry = (turn: ChatTurn) => runAction('retry', async () => {
    setError(null);
    try {
      setThread(await api.retryChatTurn(thread!.id, turn.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  async function changeProvider(provider: ChatProvider | null) {
    setError(null);
    try {
      const c = await api.updateChat(thread!.id, { provider });
      setThread((t) => (t && t.id === c.id ? { ...t, ...c } : t));
      setConvs((cs) => cs?.map((x) => (x.id === c.id ? c : x)) ?? cs);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  // Several conversations deleted at once (test chats, say): ticked in the list, one confirm for all.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const togglePick = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function removePicked() {
    const ids = [...picked];
    const ok = await askConfirm({
      title: `Delete ${plural(ids.length, 'conversation')}?`,
      message: 'Their questions, answers and prompts are deleted. This cannot be undone.',
      items: ids.map((id) => convs?.find((c) => c.id === id)?.title || 'New chat'),
      confirmLabel: `Delete ${plural(ids.length, 'conversation')}`,
    });
    if (!ok) return;
    await runAction('delete', async () => {
      const failed: string[] = [];
      for (const id of ids) await api.deleteChat(id).catch((e) => { failed.push(`${id}: ${errorMessage(e)}`); });
      const gone = new Set(ids.filter((id) => !failed.some((f) => f.startsWith(`${id}:`))));
      setConvs((cs) => cs?.filter((c) => !gone.has(c.id)) ?? cs);
      setPicked(new Set(ids.filter((id) => !gone.has(id))));
      if (selected && gone.has(selected)) { setSelected(null); setThread(null); setOpen(false); setAddress('#ask'); }
      setError(failed.length ? `${plural(failed.length, 'conversation')} could not be deleted (still ticked): ${failed.slice(0, 3).join('; ')}` : null);
    });
  }

  async function remove() {
    const { id, title } = thread!;
    const ok = await askConfirm({
      title: `Delete the conversation "${title || 'New chat'}"?`,
      message: 'Its questions, answers and prompts are deleted. This cannot be undone.',
      confirmLabel: 'Delete conversation',
    });
    if (!ok) return;
    await runAction('delete', async () => {
      try {
        await api.deleteChat(id);
        setConvs((cs) => cs?.filter((c) => c.id !== id) ?? cs);
        setSelected(null);
        setThread(null);
        setOpen(false);
        setAddress('#ask');
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  const noProjects = projects?.length === 0;
  const pending = threadPending(thread);

  const composer = (
    <Composer
      text={text}
      onText={setText}
      onSubmit={submit}
      busy={sending}
      disabled={pending}
      placeholder={pending ? 'Wait for the answer before asking again' : draft ? "e.g. 'I want to add a modal' or 'where would feature X go?'" : 'Ask a follow-up'}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Ask"
        description="Ask about one project: answers come from its lessons, misses, code map and docs, and end with a prompt for your agent."
        actions={
          <>
            <Select aria-label="project" value={project} onChange={(e) => setProject(e.target.value)} className="w-40">
              <option value="">all projects</option>
              {projects?.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
            </Select>
            <Button variant="primary" owner onClick={newChat} disabled={!projects?.length}>New chat</Button>
          </>
        }
      />
      <SplitPane
        listLabel="conversations"
        listWidth="20rem"
        detailOpen={open && (!!selected || !!draft)}
        onBack={() => setOpen(false)}
        notice={error && <Alert>{error}</Alert>}
        listHeader={convs?.length ? (
          <>
            <span className="text-xs text-muted tabular-nums">{picked.size ? `${picked.size} ticked` : 'Tick conversations to delete several'}</span>
            <Button size="sm" variant="danger-outline" owner className="ml-auto" disabled={!picked.size} busy={acting === 'delete'} onClick={() => void removePicked()}>Delete ticked</Button>
          </>
        ) : undefined}
        list={
          convs === null ? <SkeletonList /> : noProjects ? (
            <EmptyState compact icon={<AskIcon />} title="No projects selected" action={<a href="#settings" className={buttonClass('secondary', 'sm')}>Open Settings</a>}>
              Select a project in Settings first: Ask answers from what the tool has learned about it.
            </EmptyState>
          ) : convs.length === 0 ? (
            <EmptyState compact icon={<AskIcon />} title="No conversations yet">
              Ask about a project: e.g. 'I want to add a modal' or 'where would feature X go?'
            </EmptyState>
          ) : (
            <ul>
              {convs.map((c) => (
                <li key={c.id} className="relative">
                  <input type="checkbox" aria-label={`tick ${c.title || 'New chat'}`} checked={picked.has(c.id)} onChange={() => togglePick(c.id)} className="absolute top-3 right-3 z-10" />
                  <ListRow selected={c.id === selected} onClick={() => select(c.id)}>
                    {/* pr-6 keeps the text clear of the tick box over the row's right edge: a long title ends in an ellipsis before it. */}
                    <div data-testid="chat-row-text" className="min-w-0 pr-6">
                      <div className="truncate text-[13px] font-medium" title={c.title || 'New chat'}>{c.title || 'New chat'}</div>
                      <div className="flex items-center gap-1.5 truncate text-xs text-muted">
                        <span className="truncate">{c.projectKey}</span>
                        <span aria-hidden="true">·</span>
                        <Time iso={c.updatedAt} />
                        {c.pending && <Badge tone="info" dot>answering</Badge>}
                      </div>
                    </div>
                  </ListRow>
                </li>
              ))}
            </ul>
          )
        }
      >
        <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 md:p-6">
          {error && <Alert className="hidden md:block">{error}</Alert>}
          {draft ? (
            <form aria-label="new chat" onSubmit={submit} className="grid gap-3">
              <SectionLabel as="h2">New chat</SectionLabel>
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label="chat project" value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} className="w-48">
                  {projects?.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
                </Select>
                <ProviderSelect label="chat provider" value={draft.provider || null} onChange={(p) => setDraft({ ...draft, provider: p ?? '' })} />
              </div>
              <p className="text-xs text-muted">
                The answer uses this project and its confirmed linked projects. It runs on your own Claude or Codex subscription (or the local model); the
                question and the context gathered for it go only to the model you pick.
              </p>
              {composer}
            </form>
          ) : !selected ? (
            <EmptyState icon={<AskIcon />} title="No conversation open">
              {noProjects ? 'Select a project in Settings, then ask about it here.' : 'Pick one on the left, or start a New chat.'}
            </EmptyState>
          ) : !thread ? (
            <SkeletonDetail />
          ) : (
            <>
              <header className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 flex-1 basis-48 truncate text-[15px] font-semibold">{thread.title || 'New chat'}</h2>
                <Badge>{thread.projectKey}</Badge>
                <ProviderSelect label="provider" value={thread.provider} onChange={changeProvider} />
                <Button size="sm" variant="ghost" owner busy={!!acting} aria-label={acting === 'delete' ? 'deleting conversation' : 'delete conversation'} title="Delete this conversation" onClick={() => void remove()}>
                  <TrashIcon size={13} />
                </Button>
              </header>
              <ol aria-label="conversation" className="grid gap-4">
                {thread.turns.map((t) => (
                  <li key={t.id}>
                    {t.role === 'user' ? <UserTurn turn={t} /> : <AssistantTurn turn={t} thread={thread} retrying={acting === 'retry'} onRetry={() => void retry(t)} />}
                  </li>
                ))}
              </ol>
              <form aria-label="follow-up" onSubmit={submit}>{composer}</form>
            </>
          )}
        </div>
      </SplitPane>
    </div>
  );
}

export function ProviderSelect({ label, value, onChange }: { label: string; value: ChatProvider | null; onChange: (p: ChatProvider | null) => void }) {
  return (
    <Select aria-label={label} size="sm" value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as ChatProvider | null)} className="w-36">
      <option value="">Default model</option>
      {CHAT_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
    </Select>
  );
}

function Composer({ text, onText, onSubmit, busy, disabled, placeholder }: {
  text: string;
  onText: (t: string) => void;
  onSubmit: () => void;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="grid gap-2">
      <Textarea aria-label="question" rows={3} maxLength={MAX_QUESTION} value={text} disabled={disabled} placeholder={placeholder}
        onChange={(e) => onText(e.target.value)} onKeyDown={onKeyDown} className="w-full resize-y" />
      <div className="flex items-center justify-end gap-2">
        <span className="hidden text-xs text-muted sm:inline-flex sm:items-center sm:gap-1"><Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> to send</span>
        <Button type="submit" variant="primary" owner disabled={busy || disabled || !text.trim()}>{busy ? 'Sending…' : 'Send'}</Button>
      </div>
    </div>
  );
}

function UserTurn({ turn }: { turn: ChatTurn }) {
  return (
    <div className="ml-auto grid max-w-[85%] gap-1 rounded-md border border-line bg-sunken px-3 py-2">
      <span className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">You</span>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.text}</p>
    </div>
  );
}

function AssistantTurn({ turn, thread, retrying, onRetry }: { turn: ChatTurn; thread: ChatThread; retrying: boolean; onRetry: () => void }) {
  const who = providerName(turn.provider, thread.provider);
  const retryHandoff = useFocusHandoff();
  if (isPending(turn)) {
    // The worker counts the questions ahead of a waiting one in its model's line (other models answer meanwhile).
    const ahead = turn.status === 'pending' ? (turn.queueAhead ?? 0) : 0;
    return (
      // Only the words are a live region: the clock ticks every second and would be read out each time.
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-muted">
        <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-info" />
        <span>
          <span role="status">{ahead > 0 ? `Waiting for ${who}: ${ahead} ${ahead === 1 ? 'question' : 'questions'} ahead of this one…` : `Answering with ${who}…`}</span>{' '}
          <Elapsed since={ahead > 0 ? turn.createdAt : turn.startedAt ?? turn.createdAt} />
        </span>
      </div>
    );
  }
  if (turn.status === 'failed') {
    return (
      <Alert className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{who} could not answer: {turn.error ?? 'unknown error'}</span>
        <Button ref={retryHandoff} size="sm" owner busy={retrying} onClick={onRetry}>{retrying ? 'Retrying…' : 'Retry'}</Button>
      </Alert>
    );
  }
  // A done answer always carries its answer (the worker writes both together).
  const a = turn.answer!;
  return (
    <div className="grid gap-3">
      <div className="rounded-md border border-line bg-surface px-3 py-2.5 shadow-card">
        <Markdown text={a.answer} cite={(id) => { const s = turn.sources.find((x) => x.id === id); return s ? sourceHref(thread.projectKey, s) : null; }} />
        {(turn.provider || turn.pack) && (
          <p className="mt-2 text-[11px] text-muted">
            {turn.provider && <>answered by {turn.provider}</>}
            {turn.provider && turn.pack && ' · '}
            {turn.pack && <span title="what Feedback Graph gathered for this question and gave the model: lessons, misses, code map matches, snippets, facts and documents">answered from a context pack of {turn.pack.chars.toLocaleString()} characters, {plural(turn.pack.sources, 'source')}</span>}
          </p>
        )}
      </div>
      {a.examples.length > 0 && (
        <div className="grid gap-1.5">
          <SectionLabel as="div">Examples</SectionLabel>
          <ul aria-label="examples" className="grid gap-2">
            {a.examples.map((ex, i) => (
              <li key={`${ex.path}:${i}`} className="grid gap-0.5 rounded-md border border-line bg-surface px-3 py-2">
                <ModuleLink project={thread.projectKey} path={ex.path}>{ex.path}{ex.lines ? `:${ex.lines}` : ''}</ModuleLink>
                <span>{ex.why}</span>
                {ex.usages.length > 0 && (
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted">
                    used in
                    {ex.usages.map((u) => <ModuleLink key={u} project={thread.projectKey} path={u.split(':')[0]}>{u}</ModuleLink>)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {turn.sources.length > 0 && <Sources project={thread.projectKey} sources={turn.sources} />}
      {a.prompt && (
        <Card title="Prompt for your agent" actions={<CopyButton text={a.prompt} />} bodyClass="p-3">
          <p className="mb-2 text-xs text-muted">Paste it into Claude Code or Codex in this project.</p>
          <ScrollArea as="pre" className="max-h-80 overflow-auto rounded-sm border border-line bg-sunken px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{a.prompt}</ScrollArea>
        </Card>
      )}
    </div>
  );
}

function ModuleLink({ project, path, children }: { project: string; path: string; children: ReactNode }) {
  return <a href={moduleHref(project, path)} className="font-mono text-[12px] [overflow-wrap:anywhere] text-accent-text hover:underline">{children}</a>;
}

function Sources({ project, sources }: { project: string; sources: ChatSource[] }) {
  return (
    <details className="rounded-md border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold text-muted select-none">Sources ({sources.length})</summary>
      <ol className="mt-2 grid gap-1.5">
        {sources.map((s) => (
          <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-xs font-semibold">{s.id}</span>
            <Badge tone={labelOf(SOURCE_TONE, s.kind, () => 'neutral')}>{s.kind}</Badge>
            {(() => {
              const href = sourceHref(project, s);
              return href
                ? <a href={href} {...(/^https?:/.test(href) && { target: '_blank', rel: 'noreferrer' })} className="min-w-0 text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{s.title}</a>
                : <span className="min-w-0">{s.title}</span>;
            })()}
            <span className="font-mono text-[11px] [overflow-wrap:anywhere] text-muted">{s.ref}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** m:ss since `since`, ticking every second. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return <span className="tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}
