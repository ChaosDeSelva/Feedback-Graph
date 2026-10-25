import { useEffect, useState } from 'react';
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

/** The server only accepts plain file names. */
const safeName = (n: string) => n.replace(/[^\w .()-]/g, '_').replace(/^[^\w]+/, '') || 'document.txt';

/** An upload's reading, in a few words: what the worker has made of it so far. */
function ReadState({ d }: { d: DocSummary }) {
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
export function ProjectDocs({ projectKey, onError, pollMs = 5000 }: { projectKey: string; onError: (e: string) => void; pollMs?: number }) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const load = (stale = () => false) => api.docs(projectKey).then((d) => { if (!stale()) setDocs(d); }, (e) => { if (!stale()) onError(String(e)); });
  useEffect(() => {
    let stale = false;
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

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const base = { title: f.name, name: safeName(f.name) };
        if (isImage(f.type)) {
          const url = await readFile(f, 'dataUrl');
          await api.uploadDoc(projectKey, { ...base, image: { mediaType: f.type, data: url.slice(url.indexOf(',') + 1) } });
        } else {
          await api.uploadDoc(projectKey, { ...base, text: await readFile(f, 'text') });
        }
      }
      await load();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
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
      title={`Docs and discussions (${docs.length})`}
      actions={
        <label className={buttonClass('secondary', 'sm', `cursor-pointer focus-within:outline-2 focus-within:outline-focus ${busy ? 'opacity-60' : ''}`)}>
          <UploadIcon size={13} />
          {busy ? 'uploading…' : 'upload docs or images'}
          <input aria-label="upload document" type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => upload(e.target.files)} disabled={busy} />
        </label>
      }
    >
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
            <Button size="sm" variant="ghost" aria-label={`remove ${d.title}`} onClick={() => setRemoving(d)} className="shrink-0 hover:text-bad-text">remove</Button>
          </li>
        ))}
        {docs.length === 0 && (
          <li className="px-3 py-3 text-muted">
            No docs yet. Upload specs, notes, screenshots or diagrams: the worker reads them into facts, and agents get matching facts and excerpts with their task context.
          </li>
        )}
      </ul>
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
