import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, type ProjectSummary } from './api.ts';
import { CHAT_PROVIDERS, type ChatConversation, type ChatProvider, type ChatSource, type ChatThread, type ChatTurn } from '@fb/core/chat';
import { chatHref, hashFocus, hashNewChat, moduleHref } from './links.ts';
import { askConfirm } from './ui/ConfirmDialog.tsx';
import { PageHeader } from './ui/PageHeader.tsx';
import { ListRow, SplitPane } from './ui/SplitPane.tsx';
import { Button, buttonClass, CopyButton, Select, Textarea } from './ui/controls.tsx';
import { ago, Alert, Badge, Card, EmptyState, Kbd, SectionLabel, SkeletonDetail, SkeletonList, type Tone } from './ui/display.tsx';
import { AskIcon, TrashIcon } from './ui/icons.tsx';
import { Markdown } from './ui/Markdown.tsx';

/** How often an open conversation is fetched again while its answer is being written. */
const MAX_POLL_FAILURES = 5;
const POLL_MS = 2000;
/** The API refuses longer questions. */
const MAX_QUESTION = 4000;
const TITLE_MAX = 60;

const PROVIDER_LABEL: Record<ChatProvider, string> = { claude: 'Claude', codex: 'Codex', local: 'Local model' };
const SOURCE_TONE: Record<ChatSource['kind'], Tone> = { lesson: 'ok', miss: 'bad', fact: 'accent', code: 'info', doc: 'neutral', session: 'neutral', linked: 'neutral' };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
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
  // While a new chat is being written or created, a list refresh must not open another conversation instead.
  const holdOpen = useRef(!!hashNewChat());

  useEffect(() => {
    api.projects().then((ps) => setProjects([...ps].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))), (e) => { setError(message(e)); setProjects([]); });
  }, []);

  useEffect(() => {
    let stale = false;
    api.chats(project || undefined).then((cs) => {
      if (stale) return;
      setConvs(cs);
      // Wider screens open the newest conversation, unless a link or a new chat is on the way.
      setSelected((cur) => cur ?? (holdOpen.current ? null : cs[0]?.id ?? null));
    }, (e) => { if (!stale) { setError(message(e)); setConvs([]); } });
    return () => { stale = true; };
  }, [project, listTick]);

  // The open conversation. One just created or sent to is already in hand and is not fetched again.
  useEffect(() => {
    if (!selected) { setThread(null); return; }
    if (threadRef.current?.id === selected) return;
    setThread(null);
    let stale = false;
    api.chat(selected).then((t) => { if (!stale) setThread(t); }, (e) => { if (!stale) setError(message(e)); });
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
        setError(`Stopped checking for the answer: ${message(e)}. Reload the page to look again.`);
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
      if (!link.q) { setAddress('#ask'); setDraft({ project: link.project, provider: '' }); setSelected(null); setOpen(true); return; }
      setAddress('#ask');
      void start(link.project, null, link.q);
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
    const p = project || projects?.[0]?.key || '';
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
      setError(message(e));
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

  async function send(question: string) {
    if (!thread) return;
    setSending(true);
    setError(null);
    try {
      setThread(await api.sendChat(thread.id, question));
      setText('');
      setListTick((n) => n + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setSending(false);
    }
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const q = text.trim();
    if (!q || sending) return;
    if (draft) {
      if (!draft.project) return setError('Pick the project to ask about.');
      void start(draft.project, draft.provider || null, q);
    } else void send(q);
  }

  async function retry(turn: ChatTurn) {
    if (!thread) return;
    setError(null);
    try {
      setThread(await api.retryChatTurn(thread.id, turn.id));
    } catch (e) {
      setError(message(e));
    }
  }

  async function changeProvider(provider: ChatProvider | null) {
    if (!thread) return;
    setError(null);
    try {
      const c = await api.updateChat(thread.id, { provider });
      setThread((t) => (t && t.id === c.id ? { ...t, ...c } : t));
      setConvs((cs) => cs?.map((x) => (x.id === c.id ? c : x)) ?? cs);
    } catch (e) {
      setError(message(e));
    }
  }

  async function remove() {
    if (!thread) return;
    const ok = await askConfirm({
      title: `Delete the conversation "${thread.title || 'New chat'}"?`,
      message: 'Its questions, answers and prompts are deleted. This cannot be undone.',
      confirmLabel: 'Delete conversation',
    });
    if (!ok) return;
    try {
      await api.deleteChat(thread.id);
      const id = thread.id;
      setConvs((cs) => cs?.filter((c) => c.id !== id) ?? cs);
      setSelected(null);
      setThread(null);
      setOpen(false);
      setAddress('#ask');
    } catch (e) {
      setError(message(e));
    }
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
            <Button variant="primary" onClick={newChat} disabled={!projects?.length}>New chat</Button>
          </>
        }
      />
      <SplitPane
        listLabel="conversations"
        listWidth="20rem"
        detailOpen={open && (!!selected || !!draft)}
        onBack={() => setOpen(false)}
        notice={error && <Alert>{error}</Alert>}
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
                <li key={c.id}>
                  <ListRow selected={c.id === selected} onClick={() => select(c.id)}>
                    <div className="truncate text-[13px] font-medium">{c.title || 'New chat'}</div>
                    <div className="flex items-center gap-1.5 truncate text-xs text-muted">
                      <span className="truncate">{c.projectKey}</span>
                      <span aria-hidden="true">·</span>
                      <span title={new Date(c.updatedAt).toLocaleString()}>{ago(c.updatedAt)}</span>
                      {c.pending && <Badge tone="info" dot>answering</Badge>}
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
                  {!draft.project && <option value="">pick a project</option>}
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
                <Button size="sm" variant="ghost" aria-label="delete conversation" title="Delete this conversation" onClick={remove}>
                  <TrashIcon size={13} />
                </Button>
              </header>
              <ol aria-label="conversation" className="grid gap-4">
                {thread.turns.map((t) => (
                  <li key={t.id}>
                    {t.role === 'user' ? <UserTurn turn={t} /> : <AssistantTurn turn={t} thread={thread} onRetry={() => retry(t)} />}
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

function ProviderSelect({ label, value, onChange }: { label: string; value: ChatProvider | null; onChange: (p: ChatProvider | null) => void }) {
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
        <Button type="submit" variant="primary" disabled={busy || disabled || !text.trim()}>{busy ? 'Sending…' : 'Send'}</Button>
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

function AssistantTurn({ turn, thread, onRetry }: { turn: ChatTurn; thread: ChatThread; onRetry: () => void }) {
  const who = providerName(turn.provider, thread.provider);
  if (isPending(turn)) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-muted">
        <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-info" />
        <span>Answering with {who}… <Elapsed since={turn.startedAt ?? turn.createdAt} /></span>
      </div>
    );
  }
  if (turn.status === 'failed') {
    return (
      <Alert className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{who} could not answer: {turn.error ?? 'unknown error'}</span>
        <Button size="sm" onClick={onRetry}>Retry</Button>
      </Alert>
    );
  }
  const a = turn.answer;
  if (!a) return null;
  return (
    <div className="grid gap-3">
      <div className="rounded-md border border-line bg-surface px-3 py-2.5 shadow-card">
        <Markdown text={a.answer} />
        {turn.provider && <p className="mt-2 text-[11px] text-muted">answered by {turn.provider}</p>}
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
      {turn.sources.length > 0 && <Sources sources={turn.sources} />}
      {a.prompt && (
        <Card title="Prompt for your agent" actions={<CopyButton text={a.prompt} />} bodyClass="p-3">
          <p className="mb-2 text-xs text-muted">Paste it into Claude Code or Codex in this project.</p>
          <pre className="max-h-80 overflow-auto rounded-sm border border-line bg-sunken px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{a.prompt}</pre>
        </Card>
      )}
    </div>
  );
}

function ModuleLink({ project, path, children }: { project: string; path: string; children: ReactNode }) {
  return <a href={moduleHref(project, path)} className="font-mono text-[12px] [overflow-wrap:anywhere] text-accent-text hover:underline">{children}</a>;
}

function Sources({ sources }: { sources: ChatSource[] }) {
  return (
    <details className="rounded-md border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold text-muted select-none">Sources ({sources.length})</summary>
      <ol className="mt-2 grid gap-1.5">
        {sources.map((s) => (
          <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-xs font-semibold">{s.id}</span>
            <Badge tone={SOURCE_TONE[s.kind] ?? 'neutral'}>{s.kind}</Badge>
            <span className="min-w-0">{s.title}</span>
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
