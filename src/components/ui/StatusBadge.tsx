import { AlertTriangle, Circle, CircleDot, Loader2, Octagon, Play } from 'lucide-react';

export type Tone = 'neutral' | 'ok' | 'warn' | 'crit' | 'accent';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-ink-2',
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  accent: 'text-accent',
};

const ICONS = {
  idle: Circle,
  dot: CircleDot,
  busy: Loader2,
  play: Play,
  warning: AlertTriangle,
  alarm: Octagon,
} as const;

export type BadgeIcon = keyof typeof ICONS;

/**
 * Status is never color-alone: every badge pairs an icon with a text label
 * (dataviz validator: ok/crit are not separable under deuteranopia).
 */
export function StatusBadge({
  tone,
  icon,
  label,
  className = '',
}: {
  tone: Tone;
  icon: BadgeIcon;
  label: string;
  className?: string;
}) {
  const Icon = ICONS[icon];
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[12px] font-medium ${TONE_CLASS[tone]} ${className}`}
    >
      <Icon aria-hidden size={12} strokeWidth={2.5} className={icon === 'busy' ? 'animate-spin motion-reduce:animate-none' : ''} />
      <span>{label}</span>
    </span>
  );
}
