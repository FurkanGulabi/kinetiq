'use client';

/**
 * Live feed and spindle overrides (GRBL real-time commands). Usable any time the controller is
 * connected, including while a job runs; values shown are the controller's own `Ov:` report.
 */
import { RotateCcw } from 'lucide-react';
import { sendOverride, type OverrideKind, type OverrideStep } from '@/lib/cnc/client';
import { OVERRIDE_MAX, OVERRIDE_MIN, overridesView, reportUnits } from '@/lib/cnc/derive';
import { useMachine } from '@/lib/cnc/store';

function StepButton({
  label,
  ariaLabel,
  disabled,
  reason,
  onClick,
}: {
  label: React.ReactNode;
  ariaLabel: string;
  disabled: boolean;
  reason?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={disabled ? reason : ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className="pressable flex h-7 min-w-[38px] items-center justify-center rounded-md border border-line bg-surface-2 px-1.5 font-mono text-[12px] text-ink hover-fine:border-ink-3 disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:border-line"
    >
      {label}
    </button>
  );
}

function OverrideRow({
  kind,
  label,
  percent,
  live,
  available,
  reason,
}: {
  kind: OverrideKind;
  label: string;
  percent: number | null;
  live: string;
  available: boolean;
  reason: string | null;
}) {
  const name = kind === 'feed' ? 'feed rate' : 'spindle speed';
  const send = (step: OverrideStep) => sendOverride(kind, step);
  const atMin = percent !== null && percent <= OVERRIDE_MIN;
  const atMax = percent !== null && percent >= OVERRIDE_MAX;
  const off = (limit: boolean) => !available || limit;
  const why = (limit: boolean, limitReason: string) => (!available ? reason ?? undefined : limit ? limitReason : undefined);
  const changed = percent !== null && percent !== 100;

  return (
    <div className="grid grid-cols-[64px_auto_64px_auto_auto_1fr] items-center gap-1.5">
      <span className="panel-label text-[10px]">{label}</span>
      <div className="flex gap-1">
        <StepButton
          label="−10"
          ariaLabel={`Decrease ${name} override by 10%`}
          disabled={off(atMin)}
          reason={why(atMin, `Minimum is ${OVERRIDE_MIN}%`)}
          onClick={() => send(-10)}
        />
        <StepButton
          label="−1"
          ariaLabel={`Decrease ${name} override by 1%`}
          disabled={off(atMin)}
          reason={why(atMin, `Minimum is ${OVERRIDE_MIN}%`)}
          onClick={() => send(-1)}
        />
      </div>
      <output
        aria-label={`${label} override`}
        className={`text-center font-mono text-[15px] font-semibold tabular-nums ${changed ? 'text-accent' : 'text-ink'}`}
        title={percent === null ? 'Not reported by the controller yet (GRBL starts at 100%)' : undefined}
      >
        {percent === null ? '—' : `${percent}%`}
      </output>
      <div className="flex gap-1">
        <StepButton
          label="+1"
          ariaLabel={`Increase ${name} override by 1%`}
          disabled={off(atMax)}
          reason={why(atMax, `Maximum is ${OVERRIDE_MAX}%`)}
          onClick={() => send(1)}
        />
        <StepButton
          label="+10"
          ariaLabel={`Increase ${name} override by 10%`}
          disabled={off(atMax)}
          reason={why(atMax, `Maximum is ${OVERRIDE_MAX}%`)}
          onClick={() => send(10)}
        />
      </div>
      <StepButton
        label={<RotateCcw size={13} aria-hidden />}
        ariaLabel={`Reset ${name} override to 100%`}
        disabled={!available || percent === 100}
        reason={!available ? reason ?? undefined : 'Already at 100%'}
        onClick={() => send(0)}
      />
      <span className="truncate text-right font-mono text-[12px] text-ink-3 tabular-nums">{live}</span>
    </div>
  );
}

export function Overrides() {
  const machine = useMachine((s) => s);
  const view = overridesView(machine);
  const units = reportUnits(machine);
  const fmt = (v: number | null, suffix: string) => (v === null ? '—' : `${Math.round(v).toLocaleString()} ${suffix}`);

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3" role="group" aria-label="Overrides">
      <div className="flex items-center justify-between">
        <h3 className="panel-label">Overrides</h3>
        <span className="text-[11px] text-ink-3">Live · applies immediately, also while running</span>
      </div>
      <OverrideRow
        kind="feed"
        label="Feed"
        percent={view.feed}
        live={fmt(view.feedrate, `${units}/min`)}
        available={view.available}
        reason={view.reason}
      />
      <OverrideRow
        kind="spindle"
        label="Spindle"
        percent={view.spindle}
        live={fmt(view.spindleSpeed, 'rpm')}
        available={view.available}
        reason={view.reason}
      />
    </div>
  );
}
