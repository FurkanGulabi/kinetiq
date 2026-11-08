'use client';

import { useRef } from 'react';

export interface Segment<T extends string | number> {
  value: T;
  label: string;
}

/** Radio-group segmented control with arrow-key navigation. */
export function SegmentedControl<T extends string | number>({
  segments,
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  segments: Segment<T>[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = segments.findIndex((s) => s.value === value);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + segments.length) % segments.length;
    onChange(segments[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex h-8 rounded-md border border-line bg-surface-2 p-0.5">
      {segments.map((segment, index) => {
        const selected = segment.value === value;
        return (
          <button
            key={String(segment.value)}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (selectedIndex === -1 && index === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(segment.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={`pressable flex-1 rounded-[5px] px-2 font-mono text-[12px] tabular-nums disabled:cursor-not-allowed ${
              selected ? 'bg-accent text-bg font-semibold' : 'text-ink-2 hover-fine:text-ink disabled:text-ink-3'
            }`}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
