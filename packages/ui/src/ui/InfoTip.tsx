import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { InfoIcon } from './icons.tsx';

/** The gap kept between the tip and the viewport's edges, and below the button. */
const EDGE = 8;

/**
 * An info button whose tooltip (`text`) shows on hover, on keyboard focus and on a tap, and hides on Escape, on leaving
 * and on scroll. The text is the button's accessible description (aria-describedby), so a screen reader hears it with
 * the button whether or not the tip is drawn. The tip is placed under the button and kept inside the viewport.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Whether it was open as the press began: a tap also focuses the button (which opens it), so the tap's toggle reads this.
  const openAtPress = useRef(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !button.current || !tip.current) return;
    const b = button.current.getBoundingClientRect();
    const width = tip.current.offsetWidth;
    setAt({ left: Math.max(EDGE, Math.min(b.left, innerWidth - width - EDGE)), top: b.bottom + 6 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: PointerEvent) => { if (!button.current?.contains(e.target as Node)) setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onPointerDown={() => { openAtPress.current = open; }}
        // A tap (no hover on touch) toggles it; a mouse click after hovering leaves it shown.
        onClick={(e) => setOpen((e.nativeEvent as PointerEvent).pointerType === 'touch' ? !openAtPress.current : true)}
        className="grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-text"
      >
        <InfoIcon size={16} />
      </button>
      <div
        ref={tip}
        id={id}
        role="tooltip"
        hidden={!open}
        style={at ? { left: at.left, top: at.top } : { left: EDGE, top: 0, visibility: 'hidden' }}
        className="fixed z-50 w-max max-w-[min(22rem,calc(100vw-1rem))] rounded-md border border-line bg-surface px-3 py-2 text-left text-[12.5px] leading-snug font-normal tracking-normal text-text text-balance shadow-pop"
      >
        {text}
      </div>
    </>
  );
}
