/**
 * Pure derivations from MachineState to UI state. All gating rules live here.
 * Connection states follow docs/API_REFERENCE.md §5.2 — no states the backend cannot support.
 */
import type { MachineState } from './store';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionView {
  status: ConnectionStatus;
  /** Only when connected: has the controller sent its first status report? */
  controllerReady: boolean;
  label: string;
  detail: string | null;
}

export function connectionView(s: MachineState): ConnectionView {
  const { phase, error, port } = s.connection;

  if (phase === 'opening') {
    return { status: 'connecting', controllerReady: false, label: 'Connecting…', detail: port };
  }
  if (phase === 'open') {
    const ready = Boolean(s.controller.state?.status.activeState);
    return {
      status: 'connected',
      controllerReady: ready,
      label: 'Connected',
      detail: ready ? null : 'Waiting for controller…',
    };
  }
  if (error) {
    return {
      status: 'error',
      controllerReady: false,
      label: 'Connection error',
      detail: error.kind === 'lost' ? 'Connection lost' : 'Could not open port',
    };
  }
  return { status: 'disconnected', controllerReady: false, label: 'Disconnected', detail: null };
}

/** "FluidNC v3.7.8" from the banner, else "Grbl <version>" from controller:settings. */
export function controllerIdentity(s: MachineState): string | null {
  if (s.controller.firmware) {
    return s.controller.firmware;
  }
  const version = s.controller.settings?.version;
  return version ? `Grbl ${version}` : null;
}

export type MachineStateTone = 'neutral' | 'ok' | 'warn' | 'crit' | 'accent';

/** Header badge for the controller's active state (shown once, in the top bar). */
export function machineStateView(s: MachineState): { label: string; tone: MachineStateTone } | null {
  if (s.connection.phase !== 'open') {
    return null;
  }
  const status = s.controller.state?.status;
  const active = status?.activeState;
  if (!active) {
    return { label: 'No status', tone: 'neutral' };
  }
  const sub = Number.isFinite(status?.subState) ? `:${status?.subState}` : '';
  switch (active) {
    case 'Idle':
      return { label: 'Idle', tone: 'neutral' };
    case 'Run':
    case 'Jog':
    case 'Home':
      return { label: active, tone: 'accent' };
    case 'Hold':
    case 'Door':
      return { label: `${active}${sub}`, tone: 'warn' };
    case 'Alarm':
      return { label: 'Alarm', tone: 'crit' };
    default:
      return { label: active, tone: 'neutral' };
  }
}

export interface ControlState {
  enabled: boolean;
  reason?: string;
}

export interface MachineControlsView {
  visible: boolean;
  home: ControlState;
  unlock: ControlState;
  /** Hold and Resume share one slot: Resume replaces Hold while the machine is held. */
  holdMode: 'hold' | 'resume';
  hold: ControlState;
  reset: ControlState;
}

/**
 * Gating for the top-bar machine controls. Real-time Hold and Reset stay available whenever the port
 * is open; Home and Unlock (line commands) require an idle workflow so they cannot disturb streaming
 * (CNCJS_ANALYSIS.md hazard H1).
 */
export function machineControlsView(s: MachineState): MachineControlsView {
  const open = s.connection.phase === 'open';
  const active = s.controller.state?.status.activeState ?? '';
  const subState = s.controller.state?.status.subState;
  const workflowIdle = s.workflow === 'idle';
  const off = (reason: string): ControlState => ({ enabled: false, reason });
  const on: ControlState = { enabled: true };

  if (!open) {
    const reason = 'Not connected';
    return { visible: false, home: off(reason), unlock: off(reason), holdMode: 'hold', hold: off(reason), reset: off(reason) };
  }

  const ready = active !== '';
  const notReady = 'Waiting for controller status';
  const jobActive = 'A job is running or paused';

  const home: ControlState = !ready
    ? off(notReady)
    : !workflowIdle
      ? off(jobActive)
      : active === 'Idle' || active === 'Alarm'
        ? on
        : off(`Not available while ${active}`);

  const unlock: ControlState = !ready
    ? off(notReady)
    : !workflowIdle
      ? off(jobActive)
      : active === 'Alarm'
        ? on
        : off('Only needed in Alarm');

  // Resume when held (Hold:0 = hold complete) or when the job workflow is paused.
  const held = active === 'Hold' || active === 'Door' || s.workflow === 'paused';
  const holdMode: 'hold' | 'resume' = held ? 'resume' : 'hold';
  const hold: ControlState = held
    ? active === 'Hold' && subState === 1
      ? off('Decelerating — wait for the hold to complete')
      : active === 'Door' && subState === 1
        ? off('Door open — close it to resume')
        : on
    : on; // Always available: status lags up to 250 ms, and '!' on an idle machine is harmless.

  return { visible: true, home, unlock, holdMode, hold, reset: on };
}

/** Position units follow GRBL `$13` (report inches), not the G20/G21 modal state. */
export function reportUnits(s: MachineState): 'mm' | 'in' {
  return s.controller.settings?.settings?.['$13'] === '1' ? 'in' : 'mm';
}

export interface AxisReadout {
  axis: 'X' | 'Y' | 'Z';
  work: number | null;
  machine: number | null;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function positionView(s: MachineState): { ready: boolean; wcs: string; axes: AxisReadout[] } {
  const status = s.controller.state?.status;
  const ready = s.connection.phase === 'open' && Boolean(status?.activeState);
  const wcs = s.controller.state?.parserstate?.modal?.wcs || 'G54';
  const axes = (['x', 'y', 'z'] as const).map((a) => ({
    axis: a.toUpperCase() as AxisReadout['axis'],
    work: ready ? toNumber(status?.wpos?.[a]) : null,
    machine: ready ? toNumber(status?.mpos?.[a]) : null,
  }));
  return { ready, wcs, axes };
}

/**
 * Jog gating (API_REFERENCE.md §9): connected and ready, workflow idle, controller Idle or Jog,
 * and no Feeder line awaiting its ok. Cancel stays available whenever a jog may be running.
 */
export function jogView(s: MachineState): { canJog: boolean; canCancel: boolean; reason: string | null } {
  if (s.connection.phase !== 'open') {
    return { canJog: false, canCancel: false, reason: 'Connect to a controller to jog' };
  }
  const active = s.controller.state?.status.activeState ?? '';
  if (!active) {
    return { canJog: false, canCancel: false, reason: 'Waiting for controller status' };
  }
  // Stop-jog (0x85) is harmless when nothing is jogging, and status lags up to 250 ms — keep it available.
  const canCancel = true;
  if (s.workflow !== 'idle') {
    return { canJog: false, canCancel, reason: 'Jog is disabled while a job is running or paused' };
  }
  if (active === 'Alarm') {
    return { canJog: false, canCancel, reason: 'Alarm — use Home or Unlock in the top bar first' };
  }
  if (active !== 'Idle' && active !== 'Jog') {
    return { canJog: false, canCancel, reason: `Jog is not available while ${active}` };
  }
  if (s.feeder?.pending) {
    return { canJog: false, canCancel, reason: 'Waiting for the previous command to be accepted' };
  }
  return { canJog: true, canCancel, reason: null };
}

export interface AxisControlsView {
  home: ControlState;
  zero: ControlState;
  goTo: ControlState;
}

/**
 * Per-axis controls. Home works from Idle or Alarm (direct write); Zero and Go-to go through the
 * Feeder, so they need Idle (Go-to also allows Jog, like the jog pad). All require an idle workflow.
 */
export function axisControlsView(s: MachineState): AxisControlsView {
  const off = (reason: string): ControlState => ({ enabled: false, reason });
  const on: ControlState = { enabled: true };
  if (s.connection.phase !== 'open') {
    const r = off('Not connected');
    return { home: r, zero: r, goTo: r };
  }
  const active = s.controller.state?.status.activeState ?? '';
  if (!active) {
    const r = off('Waiting for controller status');
    return { home: r, zero: r, goTo: r };
  }
  if (s.workflow !== 'idle') {
    const r = off('Not available while a job is running or paused');
    return { home: r, zero: r, goTo: r };
  }
  const alarm = 'Alarm — use Home or Unlock first';
  const busy = (what: string) => off(`${what} is not available while ${active}`);
  const pending = s.feeder?.pending ? off('Waiting for the previous command to be accepted') : null;
  return {
    home: active === 'Idle' || active === 'Alarm' ? on : busy('Homing'),
    zero: active === 'Alarm' ? off(alarm) : active !== 'Idle' ? busy('Zeroing') : pending ?? on,
    goTo: active === 'Alarm' ? off(alarm) : active !== 'Idle' && active !== 'Jog' ? busy('Go to') : pending ?? on,
  };
}

export function connectionErrorMessage(s: MachineState): string | null {
  const error = s.connection.error;
  if (!error) {
    return null;
  }
  const port = error.port ?? 'the selected port';
  if (error.kind === 'lost') {
    return `Connection to ${port} was lost. The controller may still finish moves it had already received.`;
  }
  return `Could not open ${port}. Check that the cable is connected and that no other program is using the port.`;
}
