import { useEffect, useState } from 'react';
import { api, type ImportResult } from './api.ts';
import { buttonClass } from './ui/controls.tsx';
import { plural } from './ui/display.tsx';
import { CloseIcon, UploadIcon } from './ui/icons.tsx';

const readText = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(f);
  });

function summary(r: ImportResult): string {
  const parts = [`Imported ${plural(r.lessons.added, 'lesson')} (${r.lessons.approved} approved, ${r.lessons.proposed} proposed), ${plural(r.facts.added, 'fact')}.`];
  if (r.lessons.existing) parts.push(`${plural(r.lessons.existing, 'lesson')} already here, left alone.`);
  if (r.facts.skippedProjects.length) parts.push(`Facts kept for ${r.facts.skippedProjects.join(', ')} (already scanned).`);
  return parts.join(' ');
}

/** Projects page: bring an export bundle (from this or another machine) back in. Lessons wait for approval by default. */
export function ImportBundle({ onImported, clearAfterMs = 20_000 }: { onImported?: () => void; clearAfterMs?: number }) {
  const [keepApproved, setKeepApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // It sits in the page header: dismissible, and gone by itself after a while (a wrong file dropped here is no emergency).
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), clearAfterMs);
    return () => clearTimeout(t);
  }, [message, clearAfterMs]);

  async function pick(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await readText(f);
      let bundle: unknown;
      try {
        bundle = JSON.parse(text);
      } catch {
        throw new Error(`${f.name} is not a JSON export bundle`);
      }
      setMessage({ ok: true, text: summary(await api.importBundle(bundle, keepApproved)) });
      onImported?.();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1.5 text-muted">
        <input type="checkbox" aria-label="keep approved lessons approved" checked={keepApproved} onChange={(e) => setKeepApproved(e.target.checked)} />
        keep approved
      </label>
      <label className={buttonClass('secondary', 'sm', `cursor-pointer focus-within:outline-2 focus-within:outline-focus ${busy ? 'opacity-60' : ''}`)}>
        <UploadIcon size={13} />
        {busy ? 'importing…' : 'Import bundle'}
        <input aria-label="import bundle file" type="file" accept=".json,application/json" className="sr-only" disabled={busy}
          onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
      </label>
      {message && (
        <span className="flex max-w-md items-start gap-1">
          <span role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-muted' : 'text-bad-text'}>{message.text}</span>
          <button type="button" aria-label="dismiss" onClick={() => setMessage(null)} className="grid size-4 shrink-0 place-items-center rounded-sm text-muted hover:bg-sunken hover:text-text">
            <CloseIcon size={10} />
          </button>
        </span>
      )}
    </div>
  );
}
