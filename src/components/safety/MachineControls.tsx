'use client';

/**
 * Top-bar machine controls: Home, Unlock, Hold/Resume, Reset.
 * Fixed position at the far right of the top bar (docs/ARCHITECTURE.md §10.6). Every action is an
 * existing CNCjs GrblController command; gating lives in derive.machineControlsView().
 *
 * Reset and Hold are software commands — they do not replace a hard-wired emergency stop.
 */
import { Home, Pause, Play, RotateCcw, Unlock } from 'lucide-react';
import { sendCommand } from '@/lib/cnc/client';
import { machineControlsView } from '@/lib/cnc/derive';
import { getState, useMachine } from '@/lib/cnc/store';
import { Button } from '@/components/ui/Button';

function onHold() {
  // While a job runs, pause the workflow too so the Sender stays consistent with the hold.
  sendCommand(getState().workflow === 'running' ? 'gcode:pause' : 'feedhold');
}

function onResume() {
  sendCommand(getState().workflow === 'paused' ? 'gcode:resume' : 'cyclestart');
}

export function MachineControls() {
  const machine = useMachine((s) => s);
  const view = machineControlsView(machine);
  if (!view.visible) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Machine controls">
      <Button
        variant="secondary"
        onClick={() => sendCommand('homing')}
        disabled={!view.home.enabled}
        disabledReason={view.home.reason}
        title="Home all axes ($H). The machine will move."
      >
        <Home size={14} aria-hidden />
        Home
      </Button>
      <Button
        variant="secondary"
        onClick={() => sendCommand('unlock')}
        disabled={!view.unlock.enabled}
        disabledReason={view.unlock.reason}
        title="Clear the alarm without homing ($X). Machine position may be unknown."
      >
        <Unlock size={14} aria-hidden />
        Unlock
      </Button>

      <div className="mx-1 h-5 w-px bg-line" aria-hidden />

      {view.holdMode === 'hold' ? (
        <Button
          variant="warn"
          className="min-w-[88px]"
          onClick={onHold}
          disabled={!view.hold.enabled}
          disabledReason={view.hold.reason}
          title="Feed hold (!): decelerate and pause motion"
        >
          <Pause size={14} aria-hidden />
          Hold
        </Button>
      ) : (
        <Button
          variant="primary"
          className="min-w-[88px]"
          onClick={onResume}
          disabled={!view.hold.enabled}
          disabledReason={view.hold.reason}
          title="Cycle start (~): resume motion"
        >
          <Play size={14} aria-hidden />
          Resume
        </Button>
      )}
      <Button
        variant="danger"
        onClick={() => sendCommand('reset')}
        title="Soft reset (Ctrl-X): stops motion and clears buffers. Not an emergency stop."
      >
        <RotateCcw size={14} aria-hidden />
        Reset
      </Button>
    </div>
  );
}
