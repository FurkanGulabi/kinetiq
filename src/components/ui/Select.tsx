'use client';

import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  ariaLabel,
  className = '',
}: {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    // Always controlled: '' shows the placeholder (avoids React's uncontrolled→controlled warning).
    <RadixSelect.Root value={value ?? ''} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        className={`pressable inline-flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-left text-[13px] text-ink hover-fine:border-ink-3 disabled:cursor-not-allowed disabled:text-ink-3 data-[placeholder]:text-ink-3 ${className}`}
      >
        <span className="truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="shrink-0 text-ink-3">
          <ChevronDown size={14} aria-hidden />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] origin-[var(--radix-select-content-transform-origin)] overflow-hidden rounded-md border border-line bg-surface-2 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
        >
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                className="relative flex cursor-default items-center gap-2 py-1.5 pr-3 pl-7 text-[13px] text-ink outline-none select-none data-[highlighted]:bg-line"
              >
                <RadixSelect.ItemIndicator className="absolute left-2 text-accent">
                  <Check size={13} aria-hidden />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                {option.hint ? <span className="ml-auto pl-3 text-[12px] text-ink-3">{option.hint}</span> : null}
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
