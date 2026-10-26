import { useEffect, useRef, useState } from 'react';
import { api, type DocSummary } from './api.ts';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { Button, buttonClass } from './ui/controls.tsx';
import { Badge, Card, plural } from './ui/display.tsx';
import { UploadIcon } from './ui/icons.tsx';

/** What the API takes: anything else is read as text. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
const isImage = (t: string): t is ImageType => (IMAGE_TYPES as readonly string[]).includes(t);
const ACCEPT = `.md,.txt,.markdown,.rst,.json,.yaml,.yml,.csv,text/*,${IMAGE_TYPES.join(',')}`;

const readFile = (f: File, as: 'text' | 'dataUrl') =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    if (as === 'text') r.readAsText(f);
    else r.readAsDataURL(f);
  });

/** The API's page of documents when none is asked for, and the most one request may ask for. */
const DOCS_PAGE = 100;
const DOCS_MAX = 500;

/** The server only accepts plain file names. */
const safeName = (n: string) => n.replace(/[^\w .()-]/g, '_').replace(/^[^\w]+/, '') || 'document.txt';

/** How often a large upload is checked on while it is embedded, at most (15 minutes at the usual 5 s). */
const EMBED_POLLS = 180;

/** An upload's reading, in a few words: what the worker has made of it so far (or of its new version, being embedded). */
function ReadState({ d }: { d: DocSummary }) {
  if (d.embed?.status === 'pending') return <span className="shrink-0 text-xs text-muted">embedding a new version…</span>;
  if (d.embed?.status === 'failed') return <span className="min-w-0 text-xs text-bad-text [overflow-wrap:anywhere]">new version not stored: {d.embed.error ?? 'unknown error'}</span>;
  if (!d.read) return null;
  const r = d.read;
  if (r.status === 'pending' || r.status === 'reading') {
    return <span className="shrink-0 text-xs text-muted">{r.status === 'reading' ? 'reading…' : r.attempts ? `reading again${r.retryAt ? ` at ${new Date(r.retryAt).toLocaleTimeString()}` : ''}…` : 'queued for reading…'}</span>;
  }
  if (r.status === 'failed') return <span className="min-w-0 text-xs text-bad-text [overflow-wrap:anywhere]">not read: {r.error ?? 'unknown error'}</span>;
  return <span className="shrink-0 text-xs text-muted tabular-nums" title={r.readAt ? `read ${new Date(r.readAt).toLocaleString()}` : undefined}>{plural(r.facts, 'fact')}</span>;
}

/**
 * Context that isn't code: your uploads (text and images, read into facts by the worker), PR discussions and tickets
 * synced for this project.
 */
export function ProjectDocs({ projectKey, onError, pollMs = 5000, maxEmbedPolls = EMBED_POLLS }: { projectKey: string; onError: (e: string) => void; pollMs?: number; maxEmbedPolls?: number }) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  // Where the next (older) page starts; null when every document is shown.
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // A refresh reloads as many as are shown, so loading older ones is not undone by the next poll.
  const shown = useRef(0);
  shown.current = docs.length;
  const load = (stale = () => false) =>
    api.docs(projectKey, shown.current > DOCS_PAGE ? { limit: Math.min(shown.current, DOCS_MAX) } : {}).then(
      (p) => { if (!stale()) { setDocs(p.items); setNext(p.next); } },
      (e) => { if (!stale()) onError(String(e)); },
    );
  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const p = await api.docs(projectKey, { cursor: next });
      setDocs((ds) => [...ds, ...p.items.filter((d) => !ds.some((x) => x.id === d.id))]);
      setNext(p.next);
    } catch (e) {
      onError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }
  useEffect(() => {
    let stale = false;
    shown.current = 0;
    setNext(null);
    load(() => stale);
    return () => { stale = true; };
  }, [projectKey]);

  // While the worker is reading an upload, check back so its facts show up.
  const reading = docs.some((d) => d.read && (d.read.status === 'pending' || d.read.status === 'reading'));
  useEffect(() => {
    if (!reading) return;
    let stale = false;
    const t = setInterval(() => load(() => stale), pollMs);
    return () => { stale = true; clearInterval(t); };
  }, [reading, projectKey, pollMs]);

  // Large uploads the API embeds in the background (202): each is checked by id (it may be past the first page, or
  // replace a document already listed) until it is stored, fails, or maxEmbedPolls checks have passed.
  type Embedding = { id: string; name: string; chunks: number; status: 'pending' | 'failed' | 'waited'; error?: string; polls: number };
  const [embedding, setEmbedding] = useState<Embedding[]>([]);
  const pending = embedding.filter((e) => e.status === 'pending');
  useEffect(() => setEmbedding([]), [projectKey]);
  useEffect(() => {
    if (!pending.length) return;
    let stale = false;
    const t = setInterval(async () => {
      const checked = await Promise.all(pending.map(async (e) => {
        try {
          return { e, d: await api.doc(e.id) };
        } catch {
          return { e, d: undefined }; // not reached: checked again next time
        }
      }));
      if (stale) return;
      // What each check found, decided here (a state updater may run later): stored ones leave, and the list reloads.
      const found = new Map(checked.map(({ e, d }): [string, { error: string } | 'stored' | 'pending' | null] => [
        e.id,
        d === undefined ? null
          : d === null ? { error: 'the server no longer has it (it may have restarted); upload it again' }
          : d.embed?.status === 'failed' ? { error: d.embed.error ?? 'unknown error' }
          : d.embed ? 'pending' : 'stored',
      ]));
      setEmbedding((es) => es.flatMap((x): Embedding[] => {
        const f = found.get(x.id);
        if (!f || x.status !== 'pending') return [x];
        if (f === 'stored') return [];
        if (f !== 'pending') return [{ ...x, status: 'failed', error: f.error }];
        const polls = x.polls + 1;
        return [{ ...x, polls, status: polls >= maxEmbedPolls ? 'waited' : 'pending' }];
      }));
      // Not tied to this interval: the entry just removed ends it, and the stored version must still be listed.
      if ([...found.values()].includes('stored')) void load();
    }, pollMs);
    return () => { stale = true; clearInterval(t); };
  }, [pending.map((e) => e.id).join(' '), projectKey, pollMs, maxEmbedPolls]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const base = { title: f.name, name: safeName(f.name) };
        const r = isImage(f.type)
          ? await readFile(f, 'dataUrl').then((url) => api.uploadDoc(projectKey, { ...base, image: { mediaType: f.type, data: url.slice(url.indexOf(',') + 1) } }))
          : await api.uploadDoc(projectKey, { ...base, text: await readFile(f, 'text') });
        if (r.pending) setEmbedding((es) => [...es.filter((e) => e.id !== r.id), { id: r.id, name: f.name, chunks: r.chunks, status: 'pending', polls: 0 }]);
      }
      await load();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reread(id: string) {
    try {
      await api.rereadDoc(id);
      await load();
    } catch (e) {
      onError(String(e));
    }
  }

  const [removing, setRemoving] = useState<DocSummary | null>(null);
  const [busyRemoving, setBusyRemoving] = useState(false);
  useEffect(() => setRemoving(null), [projectKey]);

  async function remove(id: string) {
    setBusyRemoving(true);
    try {
      await api.deleteDoc(id);
      setDocs((ds) => ds.filter((d) => d.id !== id));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyRemoving(false);
      setRemoving(null);
    }
  }

  return (
    <Card
      title={`Docs and discussions (${docs.length}${next ? '+' : ''})`}
      actions={
        <label className={buttonClass('secondary', 'sm', `relative cursor-pointer focus-within:outline-2 focus-within:outline-focus ${busy ? 'opacity-60' : ''}`)}>
          <UploadIcon size={13} />
          {busy ? 'uploading…' : 'upload docs or images'}
          <input aria-label="upload document" type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => upload(e.target.files)} disabled={busy} />
        </label>
      }
    >
      {embedding.map((e) => (
        <p key={e.id} className={`flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs ${e.status === 'failed' ? 'text-bad-text' : 'text-muted'}`}>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {e.status === 'pending' && <>{e.name} ({e.chunks.toLocaleString('en-US')} chunks) is being embedded; it shows here once stored.</>}
            {e.status === 'failed' && <>{e.name} could not be stored: {e.error}</>}
            {e.status === 'waited' && <>{e.name} is still being embedded; it shows here once stored, and Activity says if it fails.</>}
          </span>
          {e.status !== 'pending' && (
            <Button size="sm" variant="ghost" aria-label={`dismiss ${e.name}`} onClick={() => setEmbedding((es) => es.filter((x) => x.id !== e.id))}>dismiss</Button>
          )}
        </p>
      ))}
      <ul>
        {docs.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-b-0 hover:bg-sunken">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              {d.kind === 'image' ? (
                <img src={`/api/docs/${encodeURIComponent(d.id)}/image`} alt={d.title} loading="lazy" className="size-9 shrink-0 rounded-sm border border-line object-cover" />
              ) : (
                <Badge>{d.source}</Badge>
              )}
              <span className="min-w-0 truncate">
                {d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:text-accent-text">{d.title}</a> : d.title}
              </span>
              {d.kind !== 'image' && <span className="shrink-0 text-xs text-muted tabular-nums">{plural(d.chunks, 'chunk')}</span>}
              <ReadState d={d} />
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {d.read?.status === 'failed' && (
                <Button size="sm" variant="ghost" aria-label={`retry reading ${d.title}`} title="read it again now (after changing DOCS_LLM, say), without uploading it again" onClick={() => void reread(d.id)}>retry</Button>
              )}
              <Button size="sm" variant="ghost" aria-label={`remove ${d.title}`} onClick={() => setRemoving(d)} className="hover:text-bad-text">remove</Button>
            </span>
          </li>
        ))}
        {docs.length === 0 && (
          <li className="px-3 py-3 text-muted">
            No docs yet. Upload specs, notes, screenshots or diagrams: the worker reads them into facts, and agents get matching facts and excerpts with their task context.
          </li>
        )}
      </ul>
      {next && (
        <div className="border-t border-line px-3 py-2">
          <Button size="sm" variant="secondary" aria-label="load older docs" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'loading…' : 'load older'}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={!!removing}
        title="Remove this document?"
        confirmLabel="Remove document"
        busyLabel="Removing…"
        busy={busyRemoving}
        items={removing ? [removing.title] : []}
        onCancel={() => setRemoving(null)}
        onConfirm={() => { if (removing) void remove(removing.id); }}
      >
        {removing && (
          <>
            Its {plural(removing.chunks, 'chunk')}{removing.read?.facts ? ` and ${plural(removing.read.facts, 'fact')}` : ''} are deleted from <b>{projectKey}</b> and agents stop getting them.{' '}
            {removing.source === 'upload' ? 'Upload it again to bring it back.' : 'The next sync may bring it back while the integration is on.'}
          </>
        )}
      </ConfirmDialog>
    </Card>
  );
}
