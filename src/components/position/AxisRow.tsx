'use client';

/**
 * One axis row: readouts + per-axis controls (Go to, Zero, Home).
 *   Go to — absolute jog to a typed work-coordinate target at the current jog feed (`$J=G90 …`).
 *   Zero  — set the current position as work zero in the active WCS (`G10 L20 P<n> <axis>0`).
 *   Home  — FluidNC single-axis homing (`$H<axis>`).
 */
import { useEffect, useState } from 'react';
import { sendGcode, sendLine } from '@/lib/cnc/client';
import { homeAxisLine, moveAxisLine, parseCoordinate, zeroAxisLine, type JogAxis, type Units } from '@/lib/cnc/commands';
import type { AxisControlsView } from '@/lib/cnc/derive';
import { Readout } from '@/components/ui/Readout';

function SmallButton({
  label,
  title,
  disabledReason,
  disabled,
  onClick,
  primary,
}: {
  label: string;
  title: string;
  disabledReason?: string;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : title}
      aria-label={title}
      onClick={onClick}
      className={`pressable h-7 rounded-md px-2 text-[12px] font-medium whitespace-nowrap disabled:cursor-not-allowed ${
        primary
          ? 'bg-accent text-bg hover-fine:bg-[#7cc7ff] disabled:bg-surface-2 disabled:text-ink-3'
          : 'border border-line bg-surface-2 text-ink-2 hover-fine:border-ink-3 hover-fine:text-ink disabled:text-ink-3 disabled:hover:border-line'
      }`}
    >
      {label}
    </button>
  );
}

export function AxisRow({
  axis,
  work,
  machine,
  decimals,
  units,
  feed,
  wcs,
  controls,
  onPreview,
}: {
  axis: JogAxis;
  work: number | null;
  machine: number | null;
  decimals: number;
  units: Units;
  feed: number;
  wcs: string;
  controls: AxisControlsView;
  /** Reports the pending move (or null) so the panel can show it in plain sight before Go. */
  onPreview: (axis: JogAxis, text: string | null) => void;
}) {
  const [targetText, setTargetText] = useState('');
  const target = parseCoordinate(targetText);
  const invalid = targetText.trim() !== '' && target === null;
  const delta = target !== null && work !== null ? target - work : null;
  const canGo = controls.goTo.enabled && target !== null;

  const goTitle =
    target === null
      ? `Type a ${axis} target in work coordinates (${units})`
      : `Move ${axis} to ${target.toFixed(decimals)} ${units}${
          delta !== null ? ` (${delta >= 0 ? '+' : ''}${delta.toFixed(decimals)})` : ''
        } at ${feed} ${units}/min`;

  useEffect(() => {
    onPreview(axis, target !== null && controls.goTo.enabled ? `${goTitle} — press Enter or Go` : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTitle, target, controls.goTo.enabled]);

  const go = () => {
    if (!canGo || target === null) return;
    sendGcode(moveAxisLine(axis, target, feed, units));
    setTargetText('');
  };

  return (
    <div role="row" className="contents">
      <span role="rowheader" className="font-mono text-[15px] font-semibold text-ink-2">
        {axis}
      </span>
      <span role="cell" className="text-right">
        <Readout value={work} decimals={decimals} variant="primary" />
      </span>
      <span role="cell" className="text-right">
        <Readout value={machine} decimals={decimals} variant="secondary" />
      </span>
      <span role="cell" className="flex items-center gap-1">
        <input
          aria-label={`${axis} target (${units}, work coordinates)`}
          aria-invalid={invalid}
          inputMode="decimal"
          placeholder="Go to"
          value={targetText}
          disabled={!controls.goTo.enabled}
          title={controls.goTo.enabled ? goTitle : controls.goTo.reason}
          onChange={(e) => setTargetText(e.target.value.replace(/[^\d.,+-]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
            if (e.key === 'Escape') setTargetText('');
          }}
          className={`h-7 w-[76px] min-w-0 rounded-md border bg-surface-2 px-1.5 text-right font-mono text-[12px] tabular-nums text-ink outline-none placeholder:font-sans placeholder:text-ink-3 focus-visible:border-accent disabled:cursor-not-allowed disabled:text-ink-3 ${
            invalid ? 'border-crit' : 'border-line'
          }`}
        />
        <SmallButton
          label="Go"
          primary
          title={goTitle}
          disabled={!canGo}
          disabledReason={controls.goTo.enabled ? goTitle : controls.goTo.reason}
          onClick={go}
        />
      </span>
      <span role="cell" className="flex items-center gap-1">
        <SmallButton
          label="Zero"
          title={`Set current ${axis} as work zero (${wcs})`}
          disabled={!controls.zero.enabled}
          disabledReason={controls.zero.reason}
          onClick={() => sendGcode(zeroAxisLine(axis, wcs))}
        />
        <SmallButton
          label="Home"
          title={`Home the ${axis} axis ($H${axis}). The machine will move.`}
          disabled={!controls.home.enabled}
          disabledReason={controls.home.reason}
          onClick={() => sendLine(homeAxisLine(axis))}
        />
      </span>
    </div>
  );
}
