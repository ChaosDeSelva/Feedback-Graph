import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronIcon } from './icons.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
type Size = 'sm' | 'md';

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium whitespace-nowrap select-none transition-[background-color,border-color,color,transform] duration-100 disabled:pointer-events-none disabled:opacity-45';
const SIZES: Record<Size, string> = { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3 text-[13px]' };
const VARIANTS: Record<ButtonVariant, string> = {
  // A pressable lip under the solid buttons: it sinks by a pixel on press.
  primary:
    'border border-accent-edge bg-accent font-semibold text-accent-ink shadow-[0_1px_0_0_var(--color-accent-edge)] hover:brightness-[1.04] active:translate-y-px active:shadow-none',
  secondary:
    'border border-field bg-surface text-text shadow-[0_1px_0_0_var(--color-field)] hover:bg-hover active:translate-y-px active:shadow-none',
  ghost: 'text-muted hover:bg-hover hover:text-text',
  danger:
    'border border-bad bg-bad font-semibold text-on-strong shadow-[0_1px_0_0_var(--color-bad-text)] hover:brightness-105 active:translate-y-px active:shadow-none',
  'danger-outline': 'border border-field bg-surface text-bad-text hover:border-bad hover:bg-bad-soft',
};

export const buttonClass = (variant: ButtonVariant = 'secondary', size: Size = 'md', extra = '') =>
  `${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${extra}`;

export function Button({ variant = 'secondary', size = 'md', className = '', type = 'button', ...rest }: { variant?: ButtonVariant; size?: Size } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

/**
 * Copies `text` to the clipboard and says "Copied" for a moment. A clipboard the browser refuses (no permission, not a
 * secure context) calls `onError` instead, so the caller can show the text to copy by hand.
 */
export function CopyButton({ text, label = 'Copy', onError, variant = 'secondary', size = 'sm', className = '' }: {
  text: string;
  label?: string;
  onError?: (e: unknown) => void;
  variant?: ButtonVariant;
  size?: Size;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => setCopied(false), [text]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (e) {
      setCopied(false);
      onError?.(e);
    }
  }
  return <Button variant={variant} size={size} className={className} onClick={copy}>{copied ? 'Copied' : label}</Button>;
}

export const fieldClass =
  'rounded-sm border border-field bg-surface text-text placeholder:text-muted hover:border-muted focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/20';

export function Input({ className = '', size = 'md', ...rest }: { size?: Size } & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>) {
  return <input className={`${fieldClass} ${size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-[13px]'} min-w-0 ${className}`} {...rest} />;
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldClass} min-w-0 px-2.5 py-1.5 text-[13px] leading-relaxed ${className}`} {...rest} />;
}

export function Select({ className = '', size = 'md', children, ...rest }: { size?: Size; children: ReactNode } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>) {
  return (
    <span className={`relative inline-flex min-w-0 ${className}`}>
      <select
        className={`${fieldClass} w-full min-w-0 cursor-pointer appearance-none truncate pr-7 ${size === 'sm' ? 'h-7 pl-2 text-xs' : 'h-8 pl-2.5 text-[13px]'}`}
        {...rest}
      >
        {children}
      </select>
      <ChevronIcon size={12} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rotate-90 text-muted" />
    </span>
  );
}

/** A segmented switch between a few views of one list (statuses). Each option is a pressed/unpressed button. */
export function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: readonly T[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={o === value}
          onClick={() => onChange(o)}
          className={`h-6 rounded-sm px-2.5 text-xs font-medium capitalize transition-colors ${
            o === value ? 'bg-surface text-text shadow-[0_0_0_1px_var(--color-line),var(--shadow-card)]' : 'text-muted hover:text-text'
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
