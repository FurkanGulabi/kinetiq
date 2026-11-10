'use client';

/**
 * Work area: the travel of X and Y in use, and "reverse homing" to measure it (TravelGuard).
 *
 * Measure X / Measure Y (after homing): the axis moves slowly to its far end until the limit switch
 * there raises the hard-limit alarm; the backend reads the machine position and offers it as the
 * new travel. Afterwards the machine is in Alarm on the far switch: Reset, Unlock, Back off, Home.
 */
import { Ruler, Square } from 'lucide-react';
import { useState } from 'react';
import { sendCommand, sendTravelCommand } from '@/lib/cnc/client';
import { jogView } from '@/lib/cnc/derive';
import type { MachineState } from '@/lib/cnc/store';
import { MEASURE_BACKOFF_MM, MEASURE_FEED_MM_PER_MIN, type LimitedAxis } from '@/lib/machine/travel';
import { Button } from '@/components/ui/Button';

const AXES: LimitedAxis[] = ['x', 'y'];
const FAR_SIDE: Record<LimitedAxis, string> = { x: 'left end (X−)', y: 'far end (Y+)' };

export function TravelSection({ machine }: { machine: MachineState }) {
  const [confirm, setConfirm] = useState<LimitedAxis | null>(null);
  const limits = machine.limits;
  if (!limits?.envelope || !limits.travel || machine.connection.phase !== 'open') return null;

  const active = machine.controller.state?.status.activeState ?? '';
  const jog = jogView(machine);
  const m = limits.measure;
  const running = m?.phase === 'moving' || m?.phase === 'tripped';
  const idle = active === 'Idle' && machine.workflow === 'idle';

  const measureBlock = (axis: LimitedAxis): string | null => {
    if (running) return 'A measurement is running';
    if (!limits.homed[axis]) return `Home the machine first: the measurement starts from home`;
    if (!jog.canJog || active !== 'Idle') return jog.reason ?? 'The machine must be Idle';
    return null;
  };

  const start = (axis: LimitedAxis) => {
    setConfirm(null);
    if (measureBlock(axis)) return;
    sendTravelCommand('travel:measure', axis);
  };

  const A = (axis: LimitedAxis) => axis.toUpperCase();
  const backoffReason = !limits.backoff ? undefined : idle ? undefined : 'Reset, then Unlock first, so the machine is Idle';

  return (
    <div className="mt-4 rounded-md border border-line px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="panel-label">Work area</h3>
        <span className="font-mono text-[11px] tabular-nums text-ink-3">
          {AXES.map((a) => `${A(a)} ${limits.travel[a]} mm${limits.measured[a] ? '' : ' (default)'}`).join(' · ')}
        </span>
      </div>

      {/* Idle: the two measure buttons, with a confirmation step */}
      {!m && !confirm ? (
        <div className="mt-2 flex gap-2">
          {AXES.map((a) => (
            <Button
              key={a}
              variant="secondary"
              className="flex-1"
              disabled={!!measureBlock(a)}
              disabledReason={measureBlock(a) ?? undefined}
              onClick={() => setConfirm(a)}
              title={`Move ${A(a)} to its far limit switch and measure the travel`}
            >
              <Ruler size={14} aria-hidden />
              Measure {A(a)}
            </Button>
          ))}
        </div>
      ) : null}

      {!m && confirm ? (
        <div className="mt-2 space-y-2 text-[12px] text-ink-2">
          <p>
            {A(confirm)} moves at {MEASURE_FEED_MM_PER_MIN} mm/min to the {FAR_SIDE[confirm]} until the limit switch there stops
            it. The controller then raises <span className="font-mono">ALARM:1</span> (hard limit). Keep a hand on the e-stop.
          </p>
          <div className="flex gap-2">
            <Button variant="warn" className="flex-1" onClick={() => start(confirm)} disabled={!!measureBlock(confirm)} disabledReason={measureBlock(confirm) ?? undefined}>
              Start measuring {A(confirm)}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {/* Running */}
      {m && running ? (
        <div className="mt-2 flex items-center justify-between gap-3 text-[12px]">
          <span className="text-accent" role="status">
            {m.phase === 'moving' ? `Measuring ${A(m.axis)}: moving to the far switch…` : `Switch hit, reading the position…`}
          </span>
          {m.phase === 'moving' ? (
            <Button variant="danger" onClick={() => sendCommand('jogCancel')} title="Stop the measuring move (jog cancel)">
              <Square size={12} fill="currentColor" aria-hidden />
              Stop
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Result */}
      {m?.phase === 'done' ? (
        <div className="mt-2 space-y-2 text-[12px]">
          <p role="status" className="text-ink">
            {A(m.axis)} travel: <span className="font-mono tabular-nums">{m.travelMm} mm</span>
            <span className="text-ink-3"> (in use: {limits.travel[m.axis]} mm)</span>
          </p>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" onClick={() => sendTravelCommand('travel:apply')}>
              Use {m.travelMm} mm
            </Button>
            <Button variant="ghost" onClick={() => sendTravelCommand('travel:dismiss')}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {m?.phase === 'failed' ? (
        <div className="mt-2 flex items-start justify-between gap-3 text-[12px]">
          <p role="status" className="text-warn">
            Measuring {A(m.axis)} failed: {m.message}
          </p>
          <Button variant="ghost" onClick={() => sendTravelCommand('travel:dismiss')}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {/* Recovery from the far switch */}
      {limits.backoff ? (
        <div className="mt-2 space-y-2 border-t border-line pt-2 text-[12px] text-ink-2">
          <p>
            {A(limits.backoff)} is on its far switch. In the top bar press <b>Reset</b>, then <b>Unlock</b>; then back off and
            home the machine.
          </p>
          <Button
            variant="secondary"
            className="w-full"
            disabled={!idle}
            disabledReason={backoffReason}
            onClick={() => sendTravelCommand('travel:backoff')}
            title={`Move ${A(limits.backoff)} ${MEASURE_BACKOFF_MM} mm toward home, off the switch`}
          >
            Back off {MEASURE_BACKOFF_MM} mm
          </Button>
        </div>
      ) : null}
    </div>
  );
}
