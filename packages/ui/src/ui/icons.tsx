import type { ReactNode, SVGProps } from 'react';

/** Small line icons drawn inline (no icon font or CDN: the API's CSP allows nothing external). */
function Icon({ children, size = 16, ...rest }: { children: ReactNode; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

type P = { size?: number; className?: string };

export const DashboardIcon = (p: P) => (
  <Icon {...p}><rect x="2" y="2" width="5" height="6" rx="1" /><rect x="9" y="2" width="5" height="3.5" rx="1" /><rect x="2" y="10" width="5" height="4" rx="1" /><rect x="9" y="7.5" width="5" height="6.5" rx="1" /></Icon>
);
export const InboxIcon = (p: P) => (
  <Icon {...p}><path d="M2 9.5 3.6 3.3A1 1 0 0 1 4.6 2.5h6.8a1 1 0 0 1 1 .8L14 9.5V13a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 2 13Z" /><path d="M2 9.5h3.2l.8 1.5h4l.8-1.5H14" /></Icon>
);
export const LessonIcon = (p: P) => (
  <Icon {...p}><path d="M3 2.5h7.5L13 5v8.5H3Z" /><path d="m5.5 9 1.7 1.7L10.5 7.3" /></Icon>
);
export const GraphIcon = (p: P) => (
  <Icon {...p}><circle cx="4" cy="4" r="1.8" /><circle cx="12" cy="5.5" r="1.8" /><circle cx="6.5" cy="12" r="1.8" /><path d="M5.7 4.4 10.2 5.2M5 5.6l.9 4.6M10.8 6.9 7.7 10.7" /></Icon>
);
export const PatternIcon = (p: P) => (
  <Icon {...p}><path d="M2.5 13.5h11" /><path d="M4 11V8M7 11V4.5M10 11V7M13 11V3" /></Icon>
);
export const FolderIcon = (p: P) => (
  <Icon {...p}><path d="M2 4.2c0-.4.3-.7.7-.7h3.5l1.4 1.5h5.7c.4 0 .7.3.7.7v7.1c0 .4-.3.7-.7.7H2.7a.7.7 0 0 1-.7-.7Z" /></Icon>
);
export const ActivityIcon = (p: P) => (
  <Icon {...p}><path d="M1.5 8.5h3l1.8-4.5 3.2 8 1.8-3.5h3.2" /></Icon>
);
export const SessionIcon = (p: P) => (
  <Icon {...p}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" /><path d="M5 6h6M5 8.2h4" /></Icon>
);
/** A speech bubble with a question mark: the Ask page. */
export const AskIcon = (p: P) => (
  <Icon {...p}><path d="M2.5 3.5h11v7.5H8l-3 2.5V11H2.5Z" /><path d="M6.6 5.9a1.4 1.4 0 1 1 1.9 1.3c-.3.1-.5.4-.5.7v.3" /><path d="M8 9.6v.01" /></Icon>
);
export const DocIcon = (p: P) => (
  <Icon {...p}><path d="M4 1.8h5.3L12.5 5v9.2H4Z" /><path d="M9 1.8V5.3h3.5M6 8.5h4.5M6 11h4.5" /></Icon>
);
export const GearIcon = (p: P) => (
  <Icon {...p}><path d="M12.76 6.82L14.23 7.06L14.23 8.94L12.76 9.18L12.20 10.53L13.07 11.74L11.74 13.07L10.53 12.20L9.18 12.76L8.94 14.23L7.06 14.23L6.82 12.76L5.47 12.20L4.26 13.07L2.93 11.74L3.80 10.53L3.24 9.18L1.77 8.94L1.77 7.06L3.24 6.82L3.80 5.47L2.93 4.26L4.26 2.93L5.47 3.80L6.82 3.24L7.06 1.77L8.94 1.77L9.18 3.24L10.53 3.80L11.74 2.93L13.07 4.26L12.20 5.47Z" /><circle cx="8" cy="8" r="2" /></Icon>
);
export const SunIcon = (p: P) => (
  <Icon {...p}><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" /></Icon>
);
export const MoonIcon = (p: P) => (
  <Icon {...p}><path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8Z" /></Icon>
);
export const CollapseIcon = (p: P) => (
  <Icon {...p}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11M10.5 6.3 8.8 8l1.7 1.7" /></Icon>
);
export const ExpandIcon = (p: P) => (
  <Icon {...p}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11M9 6.3 10.7 8 9 9.7" /></Icon>
);
export const MenuIcon = (p: P) => (
  <Icon {...p}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></Icon>
);
export const CloseIcon = (p: P) => (
  <Icon {...p}><path d="m4 4 8 8M12 4l-8 8" /></Icon>
);
export const TrashIcon = (p: P) => (
  <Icon {...p}><path d="M2.5 4.5h11M6.5 4.5V2.8h3v1.7M4 4.5l.7 9h6.6l.7-9M6.7 7v4M9.3 7v4" /></Icon>
);
export const SearchIcon = (p: P) => (
  <Icon {...p}><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></Icon>
);
export const UploadIcon = (p: P) => (
  <Icon {...p}><path d="M8 10.5V2.5M5 5.3 8 2.5l3 2.8M2.5 10v3.5h11V10" /></Icon>
);
export const DownloadIcon = (p: P) => (
  <Icon {...p}><path d="M8 2.5v8M5 7.7 8 10.5l3-2.8M2.5 10v3.5h11V10" /></Icon>
);
/** A pushpin; `filled` when pinned. */
export const PinIcon = ({ filled = false, ...p }: P & { filled?: boolean }) => (
  <Icon {...p}><path d="M6 2.5h4l-.5 4 2 2v1H4.5v-1l2-2Z" fill={filled ? 'currentColor' : 'none'} /><path d="M8 9.5V14" /></Icon>
);
export const ChevronIcon = (p: P) => (
  <Icon {...p}><path d="m6 4 4 4-4 4" /></Icon>
);

/** The product mark: three linked nodes, one of them lit. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect width="20" height="20" rx="5" className="fill-text" />
      <path d="M6 6.5 13.5 9 7.5 14" className="stroke-canvas" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <circle cx="6" cy="6.5" r="2" className="fill-canvas" />
      <circle cx="7.5" cy="14" r="2" className="fill-canvas" />
      <circle cx="13.5" cy="9" r="2.6" className="fill-accent" />
    </svg>
  );
}
