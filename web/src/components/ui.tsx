import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../api/client';
import { formatPctPoints, formatRate, signClass } from '../lib/format';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export const btn = {
  primary:
    'inline-flex items-center justify-center gap-1 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 dark:text-slate-900 dark:hover:bg-white disabled:cursor-not-allowed disabled:opacity-50',
  secondary:
    'inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 disabled:cursor-not-allowed disabled:opacity-50',
  small:
    'inline-flex items-center justify-center rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 disabled:cursor-not-allowed disabled:opacity-50',
};

export const inputClass =
  'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-300/70 dark:focus:border-sky-400 dark:focus:ring-sky-500/40 disabled:bg-slate-100 dark:disabled:bg-slate-700';

export function Card({ title, actions, children, className }: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('min-w-0 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-700/60 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Loading({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500 dark:text-slate-400" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-slate-700 dark:border-t-slate-200" />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-6 text-center text-sm text-rose-700 dark:text-rose-300">
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className={btn.small} onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">{children}</div>;
}

export function Alert({ tone, children }: { tone: 'error' | 'info' | 'success' | 'warning'; children: ReactNode }) {
  const tones = {
    error: 'border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300',
    info: 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/40 text-slate-700 dark:text-slate-200',
    success: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
    warning: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300',
  };
  return (
    <div className={cx('rounded-lg border px-3 py-2 text-sm', tones[tone])} role={tone === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

export function Badge({ tone = 'slate', children }: {
  tone?: 'slate' | 'violet' | 'sky' | 'emerald' | 'amber' | 'rose' | 'orange';
  children: ReactNode;
}) {
  const tones = {
    slate: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200',
    violet: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300',
    sky: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300',
    emerald: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300',
    rose: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300',
    orange: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300',
  };
  return (
    <span className={cx('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

/** Fraction rendered as a signed, colored percent. */
export function RateText({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span className={cx('tabular-nums', signClass(value), className)}>{formatRate(value)}</span>;
}

/** Percent points rendered as a signed, colored percent. */
export function PctText({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span className={cx('tabular-nums', signClass(value), className)}>{formatPctPoints(value)}</span>;
}

export function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="truncate text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{children}</div>
      {hint && <div className="text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

/**
 * Dialog rendered into document.body (above the sticky header, outside any page stacking context).
 * The body scrolls inside the max height; `footer` stays pinned below it (use `form="id"` on submit
 * buttons that live in the footer).
 */
export function Modal({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 dark:bg-black/70 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-white dark:bg-slate-800 shadow-xl ring-1 ring-slate-900/5 dark:ring-white/10 sm:max-h-[calc(100dvh-2rem)] sm:max-w-lg sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-slate-100 dark:border-slate-700/60 px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700" aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex shrink-0 justify-end gap-2 border-t border-slate-100 dark:border-slate-700/60 px-5 py-3">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
