'use client';

import { forwardRef, useId } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warn';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-bg font-semibold hover-fine:bg-[#7cc7ff] disabled:bg-surface-2 disabled:text-ink-3',
  secondary: 'bg-surface-2 text-ink border border-line hover-fine:border-ink-3 disabled:text-ink-3',
  ghost: 'text-ink-2 hover-fine:text-ink hover-fine:bg-surface-2 disabled:text-ink-3',
  danger: 'bg-surface-2 text-crit border border-crit/60 hover-fine:border-crit disabled:text-ink-3 disabled:border-line',
  warn: 'bg-surface-2 text-warn border border-warn/60 hover-fine:border-warn disabled:text-ink-3 disabled:border-line',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** When set and the button is disabled, the reason is exposed as a tooltip and to assistive tech. */
  disabledReason?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', disabledReason, className = '', disabled, children, ...rest },
  ref,
) {
  const reasonId = useId();
  const showReason = disabled && disabledReason;
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        title={showReason ? disabledReason : rest.title}
        aria-describedby={showReason ? reasonId : undefined}
        className={`pressable inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] whitespace-nowrap disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
        {...rest}
      >
        {children}
      </button>
      {showReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
});
