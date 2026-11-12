import type { ReactNode } from 'react';

/**
 * The slim bar at the top of every page: what this page is, a line or two on what it is for, and its controls. On a
 * phone the controls share an even grid (each as wide as its column, one gap between all), not a ragged wrap; from
 * md up they sit in a row at their own widths.
 */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5 md:min-h-14 md:px-5">
      <div className="min-w-0 flex-1 basis-60">
        <h1 className="text-[17px] leading-tight font-semibold tracking-[-0.01em] [font-stretch:88%]">{title}</h1>
        {description && <p title={description} className="text-xs text-muted md:line-clamp-2">{description}</p>}
      </div>
      {actions && (
        <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] items-center gap-2 max-md:[&>*]:w-full! max-md:[&>*]:min-w-0 md:flex md:w-auto md:max-w-full md:flex-wrap">
          {actions}
        </div>
      )}
    </header>
  );
}
