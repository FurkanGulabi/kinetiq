/**
 * Pure derivations from MachineState to UI state. All gating rules live here.
 * Connection states follow docs/API_REFERENCE.md §5.2 — no states the backend cannot support.
 */
import { toolpathFor } from '@/lib/gcode/toolpath';
import { AXIS_KEYS, checkFit, LIMIT_EPSILON_MM, type AxisKey, type AxisRange } from '@/lib/machine/travel';
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

/**
 * A Kinetiq operation that is talking to the controller line by line (settings read/save, Z probe).
 * While one runs, other line commands are blocked so they cannot interleave with it.
 */
export function busyReason(s: MachineState): string | null {
  if (s.configBusy) return 'Settings operation in progress';
  if (s.probe.phase === 'running') return 'Probing in progress';
  if (s.leveling.phase === 'running') return 'Height-map probing in progress';
  return null;
}

/**
 * Console input (API_REFERENCE §6.3). Lines go out with `writeln` (direct, not queued), so `$X`,
 * `$H` and `?` work in Alarm. Blocked while a job runs or is paused (hazard H1: an extra `ok` would
 * desynchronise the Sender's character counting) and while a Kinetiq sequence owns the port.
 */
export function consoleView(s: MachineState): ControlState {
  if (s.connection.phase !== 'open') return { enabled: false, reason: 'Connect to a controller first' };
  if (s.workflow !== 'idle') return { enabled: false, reason: 'Not available while a job is running or paused' };
  const busy = busyReason(s);
  if (busy) return { enabled: false, reason: busy };
  return { enabled: true };
}

/**
 * Machine settings editor (docs/SETTINGS_EDITOR.md §4.5, §6): reading the FluidNC config needs a
 * connected controller in Idle or Alarm with no job running, and one operation at a time.
 */
export function settingsView(s: MachineState): ControlState {
  if (s.connection.phase !== 'open') return { enabled: false, reason: 'Connect to the controller first' };
  const active = s.controller.state?.status.activeState ?? '';
  if (!active) return { enabled: false, reason: 'Waiting for controller status' };
  if (s.workflow !== 'idle') return { enabled: false, reason: 'Not available while a job is running or paused' };
  if (active !== 'Idle' && active !== 'Alarm') return { enabled: false, reason: `Machine is ${active}: wait until it is Idle` };
  if (s.feeder?.pending) return { enabled: false, reason: 'Waiting for the previous command to be accepted' };
  const busy = busyReason(s);
  if (busy) return { enabled: false, reason: busy };
  return { enabled: true };
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
      : busyReason(s)
        ? off(busyReason(s)!)
        : active === 'Idle' || active === 'Alarm'
        ? on
        : off(`Not available while ${active}`);

  const unlock: ControlState = !ready
    ? off(notReady)
    : !workflowIdle
      ? off(jobActive)
      : busyReason(s)
        ? off(busyReason(s)!)
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
  if (busyReason(s)) {
    return { canJog: false, canCancel, reason: busyReason(s) };
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
  if (busyReason(s)) {
    const r = off(busyReason(s)!);
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

/* ------------------------------------------------------------------------------------------------
 * Job (Widget 4) — API_REFERENCE.md §7.2–7.3
 * ---------------------------------------------------------------------------------------------- */

export type JobStatus = 'idle' | 'running' | 'paused' | 'error' | 'completed' | 'cancelled';

export interface JobView {
  status: JobStatus;
  label: string;
  tone: MachineStateTone;
  /** Hold reason (M0/M1/M6/%wait/error) shown under the badge. */
  reason: string | null;
  stopping: boolean;
  stopFailure: string | null;
  program: { name: string; lines: number; jobId: string | null } | null;
  /** Acknowledged lines over total (total includes the backend's %wait line). */
  progress: { received: number; sent: number; total: number; percent: number } | null;
  startTime: number | null;
  finishTime: number | null; // only when Completed — never predicted
  elapsedMs: number | null;
  remainingMs: number | null; // estimate, hidden until the backend has one
  canLoad: ControlState;
  canUnload: ControlState;
  start: ControlState;
  pauseMode: 'pause' | 'resume';
  pause: ControlState;
  stop: ControlState;
}

const JOB_STATUS: Record<JobStatus, { label: string; tone: MachineStateTone }> = {
  idle: { label: 'Idle', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warn' },
  error: { label: 'Error', tone: 'crit' },
  completed: { label: 'Completed', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Controller errors recorded for the current run (client memory; see store.jobErrors). */
export function runErrors(s: MachineState): string[] {
  const start = s.sender?.startTime;
  return start && s.jobErrors?.startTime === start ? s.jobErrors.messages : [];
}

export function jobStatus(s: MachineState): JobStatus {
  const sender = s.sender;
  const active = s.controller.state?.status.activeState;
  const errored = runErrors(s).length > 0;
  if (s.workflow !== 'idle' && active === 'Alarm') return 'error';
  if (s.workflow === 'running') return 'running';
  if (s.workflow === 'paused') return sender?.holdReason?.err || errored ? 'error' : 'paused';
  if (!s.program || !sender || !sender.startTime) return 'idle';
  if (sender.finishTime > 0) return errored ? 'error' : 'completed';
  return 'cancelled';
}

/** `now` is passed in so the elapsed clock stays a pure function of (state, time). */
export function jobView(s: MachineState, now: number): JobView {
  const status = jobStatus(s);
  const sender = s.sender;
  const open = s.connection.phase === 'open';
  const active = s.controller.state?.status.activeState ?? '';
  const subState = s.controller.state?.status.subState;
  const stopping = s.stopSequence.phase === 'stopping';
  const off = (reason: string): ControlState => ({ enabled: false, reason });
  const on: ControlState = { enabled: true };

  const program = s.program
    ? {
        name: s.program.name,
        // The backend appends one "%wait" line; show the file's own line count.
        lines: Math.max(0, (sender?.total ?? 0) - 1),
        jobId: s.program.jobId,
      }
    : null;

  const total = sender?.total ?? 0;
  // The backend rewinds the Sender when the workflow stops, so a Completed job reports received = 0.
  const finished = s.workflow === 'idle' && (sender?.finishTime ?? 0) > 0 && !!sender?.startTime;
  const received = finished ? total : sender?.received ?? 0;
  const progress =
    s.program && sender && total > 0
      ? {
          received,
          sent: finished ? total : sender.sent,
          total,
          percent: Math.min(100, (received / total) * 100),
        }
      : null;

  const startTime = sender?.startTime || null;
  const finishTime = finished ? sender?.finishTime || null : null;
  let elapsedMs: number | null = null;
  if (startTime) {
    if (finishTime) elapsedMs = finishTime - startTime;
    else if (s.workflow !== 'idle') elapsedMs = Math.max(0, now - startTime);
  }
  const remainingMs =
    (status === 'running' || status === 'paused') && sender && sender.remainingTime > 0 ? sender.remainingTime : null;

  let reason: string | null = null;
  const errors = runErrors(s);
  if (status === 'paused' || status === 'error') {
    const hold = sender?.holdReason;
    const label = hold?.data ? HOLD_LABELS[hold.data] ?? hold.data : null;
    // msg is a %msg text or the original program line (e.g. "M0 (check pause)"); skip it for %wait.
    const showMsg = hold?.msg && hold.msg !== hold.data && !hold.msg.startsWith('%');
    reason = label ? (showMsg ? `${label} · ${hold?.msg}` : label) : hold?.msg || null;
    if (status === 'error') {
      if (active === 'Alarm' && s.workflow !== 'idle') reason = 'Controller entered Alarm during the job';
      else if (errors.length > 0) {
        const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
        reason = `${s.workflow === 'idle' ? 'Finished with errors: ' : ''}${errors[0]}${more}`;
      }
    }
    if (status === 'paused' && !reason) reason = 'Paused by operator';
  }

  // --- control gating ---
  const ready = open && active !== '';
  const notReady = open ? 'Waiting for controller status' : 'Connect to a controller first';
  const jobBusy = 'Stop the current job first';

  const canLoad = !ready
    ? off(notReady)
    : s.workflow !== 'idle'
      ? off(jobBusy)
      : stopping
        ? off('Stopping…')
        : busyReason(s)
          ? off(busyReason(s)!)
          : on;
  const canUnload = !s.program ? off('No program loaded') : !ready ? off(notReady) : s.workflow !== 'idle' ? off(jobBusy) : on;

  let start: ControlState;
  if (!ready) start = off(notReady);
  else if (!s.program) start = off('Load a program first');
  else if (s.workflow !== 'idle') start = off('The job is already running');
  else if (active === 'Alarm') start = off('Alarm — use Home or Unlock in the top bar first');
  else if (active !== 'Idle') start = off(`Cannot start while ${active}`);
  else if (s.feeder?.pending) start = off('Waiting for the previous command to be accepted');
  else if (busyReason(s)) start = off(busyReason(s)!);
  else if (s.program.leveling && levelingDrift(s, s.program.leveling)) start = off(levelingDrift(s, s.program.leveling)!);
  else if (programFitView(s).blocks) start = off(programFitView(s).blocks!);
  else start = on;

  const pauseMode: 'pause' | 'resume' = s.workflow === 'paused' ? 'resume' : 'pause';
  let pause: ControlState;
  if (!ready) pause = off(notReady);
  else if (stopping) pause = off('Stopping…');
  else if (pauseMode === 'pause') pause = s.workflow === 'running' ? on : off('No job is running');
  else if (active === 'Hold' && subState === 1) pause = off('Decelerating — wait for the hold to complete');
  else if (active === 'Door' && subState === 1) pause = off('Door open — close it to resume');
  else if (active === 'Alarm') pause = off('Alarm — stop the job, then Home or Unlock');
  else pause = on;

  const stop: ControlState = !ready
    ? off(notReady)
    : s.workflow === 'idle'
      ? off('No job is running')
      : stopping
        ? off('Stopping…')
        : on;

  return {
    status,
    ...JOB_STATUS[status],
    reason,
    stopping,
    stopFailure: s.stopSequence.phase === 'failed' ? s.stopSequence.message : null,
    program,
    progress,
    startTime,
    finishTime,
    elapsedMs,
    remainingMs,
    canLoad,
    canUnload,
    start,
    pauseMode,
    pause,
    stop,
  };
}

const HOLD_LABELS: Record<string, string> = {
  M0: 'M0 program pause',
  M1: 'M1 optional stop',
  M6: 'Tool change (M6)',
  '%wait': 'Waiting for the planner to empty',
};

/* ------------------------------------------------------------------------------------------------
 * Overrides — GRBL real-time feed / spindle overrides (10–200 %)
 * ---------------------------------------------------------------------------------------------- */

export const OVERRIDE_MIN = 10;
export const OVERRIDE_MAX = 200;

export interface OverridesView {
  available: boolean;
  reason: string | null;
  /** Percent from the last `Ov:` report; null until the controller has reported one. */
  feed: number | null;
  spindle: number | null;
  /** Live values from `FS:` (units/min, rpm). */
  feedrate: number | null;
  spindleSpeed: number | null;
}

export function overridesView(s: MachineState): OverridesView {
  const status = s.controller.state?.status;
  const ready = s.connection.phase === 'open' && Boolean(status?.activeState);
  const ov = status?.ov ?? [];
  const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    available: ready,
    reason: s.connection.phase !== 'open' ? 'Connect to a controller first' : ready ? null : 'Waiting for controller status',
    feed: ready ? pct(ov[0]) : null,
    spindle: ready ? pct(ov[2]) : null,
    feedrate: ready ? pct(status?.feedrate) : null,
    spindleSpeed: ready ? pct(status?.spindle) : null,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Z probe — lib/cnc/probe.ts
 * ---------------------------------------------------------------------------------------------- */

export interface ProbeView {
  /** Live probe input from the status report: null when unknown (not connected / no status). */
  touching: boolean | null;
  canProbe: ControlState;
  canCancel: boolean;
}

/**
 * Probing moves Z, so it needs: connected and ready, no job, controller Idle (FluidNC refuses
 * motion in Alarm), no line awaiting its ok, no other Kinetiq operation, and the probe not already
 * touching (G38.2 would fail with ALARM:4).
 */
export function probeView(s: MachineState): ProbeView {
  const off = (reason: string): ControlState => ({ enabled: false, reason });
  const running = s.probe.phase === 'running';
  if (s.connection.phase !== 'open') return { touching: null, canProbe: off('Connect to a controller first'), canCancel: false };
  const status = s.controller.state?.status;
  const active = status?.activeState ?? '';
  if (!active) return { touching: null, canProbe: off('Waiting for controller status'), canCancel: running };
  const touching = !!status?.pinState && status.pinState.includes('P');
  const canProbe: ControlState = running ? off('Probing in progress') : probingGate(s, active, touching);
  return { touching, canProbe, canCancel: running };
}

/**
 * Shared start conditions for a sequence of lines through the Feeder that moves the machine (Z probe,
 * height map, macros): no job, controller Idle, no line awaiting its ok, no other Kinetiq operation.
 */
function feederSequenceGate(s: MachineState, active: string): ControlState | null {
  const off = (reason: string): ControlState => ({ enabled: false, reason });
  if (s.workflow !== 'idle') return off('Not available while a job is running or paused');
  if (active === 'Alarm') return off('Alarm — use Home or Unlock in the top bar first');
  if (active !== 'Idle') return off(`Not available while ${active}`);
  if (s.feeder?.pending) return off('Waiting for the previous command to be accepted');
  if (busyReason(s)) return off(busyReason(s)!);
  return null;
}

/** Shared start conditions for probing sequences (Z probe, height map). */
function probingGate(s: MachineState, active: string, touching: boolean): ControlState {
  const gate = feederSequenceGate(s, active);
  if (gate) return gate;
  if (touching) return { enabled: false, reason: 'The probe reads as touching. Check the clip before probing.' };
  return { enabled: true };
}

export interface LevelingView {
  touching: boolean | null;
  canProbe: ControlState;
  canCancel: boolean;
}

/** Height-map probing: same start conditions as the Z probe. */
export function levelingView(s: MachineState): LevelingView {
  const running = s.leveling.phase === 'running';
  if (s.connection.phase !== 'open') return { touching: null, canProbe: { enabled: false, reason: 'Connect to a controller first' }, canCancel: false };
  const status = s.controller.state?.status;
  const active = status?.activeState ?? '';
  if (!active) return { touching: null, canProbe: { enabled: false, reason: 'Waiting for controller status' }, canCancel: running };
  const touching = !!status?.pinState && status.pinState.includes('P');
  const canProbe: ControlState = running ? { enabled: false, reason: 'Height-map probing in progress' } : probingGate(s, active, touching);
  return { touching, canProbe, canCancel: running };
}

/** Work offset (machine − work) from the status report, or null. */
export function workOffset(s: MachineState): { x: number; y: number; z: number } | null {
  const status = s.controller.state?.status;
  if (!status) return null;
  const off = (a: 'x' | 'y' | 'z') => Number(status.mpos?.[a]) - Number(status.wpos?.[a]);
  const wco = { x: off('x'), y: off('y'), z: off('z') };
  return [wco.x, wco.y, wco.z].every(Number.isFinite) ? wco : null;
}

/**
 * Why a leveled program must not start: the work zero or coordinate system changed since its
 * height map was probed, so the map no longer lines up with the stock. null when it still matches.
 */
export function levelingDrift(s: MachineState, leveling: { wcs: string; wco: { x: number; y: number; z: number } }): string | null {
  const wcs = s.controller.state?.parserstate?.modal?.wcs || 'G54';
  if (wcs !== leveling.wcs) return `Leveled for ${leveling.wcs}, but ${wcs} is active`;
  const wco = workOffset(s);
  if (!wco) return 'Waiting for the work position';
  const moved = (['x', 'y', 'z'] as const).filter((a) => Math.abs(wco[a] - leveling.wco[a]) > 0.005);
  return moved.length ? `Work ${moved.map((a) => a.toUpperCase()).join('/')} zero changed since leveling: probe the height map again` : null;
}

/* ------------------------------------------------------------------------------------------------
 * Travel limits — lib/machine/travel.ts (the backend enforces jogs; this is what the UI shows)
 * ---------------------------------------------------------------------------------------------- */

export interface AxisTravel {
  /** Allowed machine range (mm); null = Kinetiq does not limit this axis. */
  range: AxisRange | null;
  homed: boolean;
  /** Distance left to the − and + limit, in report units; null when not limited or not known. */
  roomNeg: number | null;
  roomPos: number | null;
}

/** Machine position in mm (the status report is in `$13` units). */
function machinePositionMm(s: MachineState): Record<AxisKey, number> {
  const mpos = s.controller.state?.status.mpos;
  const scale = reportUnits(s) === 'in' ? 25.4 : 1;
  const mm = (a: AxisKey) => (mpos?.[a] === undefined || mpos[a] === '' ? NaN : Number(mpos[a]) * scale);
  return { x: mm('x'), y: mm('y'), z: mm('z') };
}

/** Work offset (machine − work) in mm. */
function workOffsetMm(s: MachineState): Record<AxisKey, number> | null {
  const wco = workOffset(s);
  if (!wco) return null;
  const scale = reportUnits(s) === 'in' ? 25.4 : 1;
  return { x: wco.x * scale, y: wco.y * scale, z: wco.z * scale };
}

/** Per-axis travel state. `active` is false when the backend has travel limits turned off. */
export function travelView(s: MachineState): { active: boolean; axes: Record<'X' | 'Y' | 'Z', AxisTravel> } {
  const envelope = s.limits?.envelope ?? null;
  const pos = machinePositionMm(s);
  const scale = reportUnits(s) === 'in' ? 25.4 : 1;
  const axis = (a: AxisKey): AxisTravel => {
    const range = envelope?.[a] ?? null;
    const homed = s.limits?.homed[a] ?? false;
    const known = range !== null && homed && Number.isFinite(pos[a]);
    return {
      range,
      homed,
      roomNeg: known ? Math.max(0, pos[a] - range.min) / scale : null,
      roomPos: known ? Math.max(0, range.max - pos[a]) / scale : null,
    };
  };
  return { active: envelope !== null, axes: { X: axis('x'), Y: axis('y'), Z: axis('z') } };
}

/** Why an axis must not be moved yet (limited but not homed), or null. */
export function axisNotHomed(s: MachineState, axis: 'X' | 'Y' | 'Z'): string | null {
  const t = travelView(s).axes[axis];
  return t.range && !t.homed ? `${axis} is not homed: home the machine first (its position is not known)` : null;
}

/** One jog-pad button: off when the axis is not homed or already at the limit in that direction. */
export function jogDirectionView(s: MachineState, axis: 'X' | 'Y' | 'Z', direction: 1 | -1): ControlState {
  const notHomed = axisNotHomed(s, axis);
  if (notHomed) return { enabled: false, reason: notHomed };
  const t = travelView(s).axes[axis];
  const room = direction > 0 ? t.roomPos : t.roomNeg;
  if (room !== null && room * (reportUnits(s) === 'in' ? 25.4 : 1) <= LIMIT_EPSILON_MM) {
    return { enabled: false, reason: `${axis}${direction > 0 ? '+' : '−'} is at the travel limit` };
  }
  return { enabled: true };
}

/**
 * One step jog in one direction — the jog-pad button and its keyboard key share this gate: the
 * shared jog gating (jogView) first, then this direction's homing and travel limit (jogDirectionView).
 */
export function jogButtonView(s: MachineState, axis: 'X' | 'Y' | 'Z', direction: 1 | -1): ControlState {
  const jog = jogView(s);
  if (!jog.canJog) return { enabled: false, reason: jog.reason ?? 'Jog is not available' };
  return jogDirectionView(s, axis, direction);
}

export interface KeyboardJogView {
  /** Keys are listened to at all: the operator turned keyboard jog on and the Position widget is open. */
  active: boolean;
  /** Escape may send jog cancel. */
  cancel: ControlState;
  /** Why keys do nothing although keyboard jog is on (shown next to the key map); null when keys can move. */
  reason: string | null;
}

/**
 * Keyboard jog (Position widget, opt-in). Motion keys use exactly the pad gate (jogButtonView); this adds:
 *  - keys only work while the Position widget is expanded, so the operator can see the key map and
 *    the readouts the keys change;
 *  - Escape (jog cancel) is limited to an idle workflow, so no key sends anything while a job is
 *    running or paused (0x85 does not stop a job, and Escape must not look as if it did).
 */
export function keyboardJogView(s: MachineState, opts: { enabled: boolean; collapsed: boolean }): KeyboardJogView {
  if (!opts.enabled) return { active: false, cancel: { enabled: false, reason: 'Keyboard jog is off' }, reason: 'Keyboard jog is off' };
  if (opts.collapsed) {
    const reason = 'Keyboard jog is paused while the Position widget is collapsed';
    return { active: false, cancel: { enabled: false, reason }, reason };
  }
  const jog = jogView(s);
  const cancel: ControlState = !jog.canCancel
    ? { enabled: false, reason: jog.reason ?? 'Jog cancel is not available' }
    : s.workflow !== 'idle'
      ? { enabled: false, reason: 'Keys are disabled while a job is running or paused' }
      : { enabled: true };
  return { active: true, cancel, reason: jog.canJog ? null : jog.reason };
}

export interface ProgramFitView {
  /** Set when the job must not start: not homed, or it does not fit. */
  blocks: string | null;
  /** 'off' = travel limits off or no program. */
  status: 'off' | 'unknown' | 'fits' | 'overflow';
  /** Sides the program exceeds, e.g. "X− by 12.5 mm". */
  overflows: string[];
  /** Parts of the program the check cannot cover (not blocking; the firmware's soft limits still apply). */
  unchecked: string[];
}

const NO_FIT: ProgramFitView = { blocks: null, status: 'off', overflows: [], unchecked: [] };
let fitCache: { key: string; gcode: string; view: ProgramFitView } | null = null;

/**
 * Does the loaded program fit inside the travel limits with the current work zero? Checked in
 * machine coordinates: the toolpath bounds (work) plus the work offset, against the envelope.
 */
export function programFitView(s: MachineState): ProgramFitView {
  const envelope = s.limits?.envelope;
  const gcode = s.program?.gcode;
  if (!envelope || !gcode) return NO_FIT;

  const limited = AXIS_KEYS.filter((a) => envelope[a] !== null);
  const notHomed = limited.filter((a) => !s.limits?.homed[a]);
  if (notHomed.length) {
    const names = notHomed.map((a) => a.toUpperCase()).join(' and ');
    return { blocks: `Home the machine first: ${names} is not homed, so the job cannot be checked against the travel limits`, status: 'unknown', overflows: [], unchecked: [] };
  }
  const wco = workOffsetMm(s);
  if (!wco) return { blocks: 'Waiting for the work position', status: 'unknown', overflows: [], unchecked: [] };

  const wcs = s.controller.state?.parserstate?.modal?.wcs || 'G54';
  const tp = toolpathFor(gcode);
  // A program with relative moves from its start is checked from where the machine is now.
  const start = tp.startBounds ? machinePositionMm(s) : null;
  const key = `${wcs}|${limited.map((a) => wco[a].toFixed(3)).join(',')}|${start ? limited.map((a) => start[a].toFixed(3)).join(',') : ''}`;
  if (fitCache && fitCache.gcode === gcode && fitCache.key === key) return fitCache.view;

  const fit = checkFit({ ...tp, bounds: tp.fitBounds }, envelope, wco, wcs, start ?? undefined);
  const view: ProgramFitView = {
    blocks: fit.fits ? null : `Does not fit in the travel limits: ${fit.overflows.join(', ')}. Move the work zero or the job.`,
    status: fit.fits ? 'fits' : 'overflow',
    overflows: fit.overflows,
    unchecked: fit.unchecked,
  };
  fitCache = { key, gcode, view };
  return view;
}

/**
 * Why a rectangle in work coordinates (mm) cannot be reached: an axis is not homed or the
 * area leaves the travel limits. null when it is fine or travel limits are off. Used for the
 * height-map probing grid.
 */
export function workAreaFit(s: MachineState, area: { xMin: number; xMax: number; yMin: number; yMax: number }): string | null {
  const envelope = s.limits?.envelope;
  if (!envelope) return null;
  for (const axis of ['X', 'Y'] as const) {
    const notHomed = axisNotHomed(s, axis);
    if (notHomed) return notHomed;
  }
  const wco = workOffsetMm(s);
  if (!wco) return 'Waiting for the work position';
  const extent = {
    bounds: { min: [area.xMin, area.yMin, 0] as [number, number, number], max: [area.xMax, area.yMax, 0] as [number, number, number] },
    machineBounds: { min: [NaN, NaN, NaN] as [number, number, number], max: [NaN, NaN, NaN] as [number, number, number] },
    unchecked: [],
    wcsUsed: [],
  };
  const fit = checkFit(extent, { ...envelope, z: null }, wco, '');
  return fit.fits ? null : `The area leaves the travel limits: ${fit.overflows.join(', ')}`;
}

/* ------------------------------------------------------------------------------------------------
 * Macros — saved G-code snippets run with `macro:run` (lib/macros, src/server/macros.ts)
 * ---------------------------------------------------------------------------------------------- */

export interface MacroView {
  /** Run (any macro): the same conditions the backend checks before it queues the lines. */
  run: ControlState;
  /**
   * What the Feeder is doing (macro, jog or probe lines): 'held' after M0/M1/M6 (only Reset releases
   * it), 'sending' while lines are queued or one awaits its ok. null when it is empty.
   */
  feeder: { phase: 'held' | 'sending'; queued: number } | null;
}

/**
 * Run is enabled only when connected and ready, no job, controller Idle, the Feeder empty (nothing
 * queued, in flight or held) and no other Kinetiq operation (probe, height map, settings).
 * Editing macros needs no connection and is not gated here.
 */
export function macroView(s: MachineState): MacroView {
  const off = (reason: string): ControlState => ({ enabled: false, reason });
  const f = s.feeder;
  const feeder = f?.hold ? { phase: 'held' as const, queued: f.queue } : f && (f.queue > 0 || f.pending) ? { phase: 'sending' as const, queued: f.queue } : null;
  if (s.connection.phase !== 'open') return { run: off('Connect to a controller first'), feeder: null };
  const active = s.controller.state?.status.activeState ?? '';
  if (!active) return { run: off('Waiting for controller status'), feeder };
  const gate = feederSequenceGate(s, active);
  if (gate) return { run: gate, feeder };
  if (feeder?.phase === 'held') return { run: off('Earlier commands are held (M0/M1/M6): Reset clears them'), feeder };
  if (feeder) return { run: off('Earlier commands are still being sent'), feeder };
  return { run: { enabled: true }, feeder };
}
