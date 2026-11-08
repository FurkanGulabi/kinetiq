import type { Tone } from './StatusBadge';

const FILL: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
};

/** Track + fill meter (dataviz: a number and a meter, not a chart). Width changes are not animated. */
export function Meter({ value, tone = 'accent', label }: { value: number; tone?: Tone; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div className={`h-full rounded-full ${FILL[tone]}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}
