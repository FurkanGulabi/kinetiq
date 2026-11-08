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
