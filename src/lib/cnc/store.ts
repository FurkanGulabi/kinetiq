'use client';

/**
 * Kinetiq machine store: one immutable state object reduced from verified server events.
 * The server is the source of truth; the only client-side flags are `connection.phase === 'opening'`,
 * `connection.userRequestedClose` and `stopSequence`. See docs/ARCHITECTURE.md §6–7.
 */
import { useSyncExternalStore } from 'react';
import type {
  FeederStatus,
  GrblSettings,
  GrblState,
  MachineLimits,
  SenderStatus,
  SerialPortInfo,
  WorkflowState,
} from './protocol';

export type BackendStatus = 'connecting' | 'online' | 'offline';

export interface ConnectionError {
  kind: 'open-failed' | 'lost' | 'backend';
  port: string | null;
  message?: string;
}

export interface MachineState {
  backend: BackendStatus;
  backendError: string | null;
  baudrates: number[];
  ports: SerialPortInfo[];
  portsLoaded: boolean;
  connection: {
    port: string | null;
    baudrate: number | null;
    phase: 'closed' | 'opening' | 'open';
    userRequestedClose: boolean;
    error: ConnectionError | null;
  };
  controller: {
    type: string | null;
    state: GrblState | null;
    settings: GrblSettings | null;
    firmware: string | null; // e.g. "FluidNC v3.7.8", parsed from the startup banner
  };
  /** Kinetiq travel limits and homed axes (`machine:limits`); null until the backend has sent them. */
  limits: MachineLimits | null;
  workflow: WorkflowState;
  sender: SenderStatus | null;
  feeder: FeederStatus | null;
  /** Program loaded on the controller (`gcode:load`). `gcode` includes the backend's appended %wait line. */
  program: LoadedProgram | null;
  /** Client-side: the safe Stop sequence in progress (ARCHITECTURE §10.5). */
  stopSequence: StopSequence;
  /**
   * Client-side: controller errors seen during the current run, keyed by `sender.startTime`.
   * Needed because CNCjs drops the error hold reason when the Sender is already held by `%wait`
   * (Sender.hold returns early), so a short program with a bad line would otherwise end "Completed".
   */
  jobErrors: JobErrors | null;
  /** Client-side: a machine settings (FluidNC config) operation is talking to the controller. */
  configBusy: boolean;
  /** Client-side: the Z probe sequence (lib/cnc/probe.ts). */
  probe: ProbeRun;
  /** Client-side: the height-map probing run (lib/leveling/run.ts). */
  leveling: LevelingRun;
}

export type LevelingRun =
  | { phase: 'idle' }
  | { phase: 'running'; done: number; total: number; label: string; cancelling: boolean; startedAt: number }
  | { phase: 'done'; at: number }
  | { phase: 'failed'; message: string; hint: string | null; at: number }
  | { phase: 'cancelled'; at: number };

/** Height-map leveling applied to a loaded program (passed in the gcode:load context). */
export interface ProgramLeveling {
  mapId: string;
  wcs: string;
  wco: { x: number; y: number; z: number };
  sourceName: string;
}

export type ProbeRun =
  | { phase: 'idle' }
  | { phase: 'running'; step: number; steps: number; label: string; cancelling: boolean }
  | { phase: 'done'; contactZ: number | null; thickness: number; retract: number; at: number }
  | { phase: 'failed'; message: string; hint: string | null; at: number }
  | { phase: 'cancelled'; at: number };

export interface JobErrors {
  startTime: number;
  messages: string[];
}

export interface LoadedProgram {
  name: string;
  gcode: string;
  /** Job-library id passed in the `gcode:load` context, when the program came from the library. */
  jobId: string | null;
  /** Set when this program is a height-map leveled version (Kinetiq bed leveling). */
  leveling: ProgramLeveling | null;
}

export type StopSequence =
  | { phase: 'idle' }
  | { phase: 'stopping'; startedAt: number }
  | { phase: 'failed'; message: string };

const initialState: MachineState = {
  backend: 'connecting',
  backendError: null,
  baudrates: [],
  ports: [],
  portsLoaded: false,
  connection: {
    port: null,
    baudrate: null,
    phase: 'closed',
    userRequestedClose: false,
    error: null,
  },
  controller: { type: null, state: null, settings: null, firmware: null },
  limits: null,
  workflow: 'idle',
  sender: null,
  feeder: null,
  program: null,
  stopSequence: { phase: 'idle' },
  jobErrors: null,
  configBusy: false,
  probe: { phase: 'idle' },
  leveling: { phase: 'idle' },
};

let state: MachineState = initialState;
const listeners = new Set<() => void>();

export function getState(): MachineState {
  return state;
}

export function setState(updater: (prev: MachineState) => MachineState): void {
  const next = updater(state);
  if (next === state) {
    return;
  }
  state = next;
  listeners.forEach((listener) => listener());
}

/** Low-level subscription for imperative consumers (e.g. the 3D view) that must not re-render React. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to a slice. Selectors must return existing references or primitives. */
export function useMachine<T>(selector: (s: MachineState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initialState),
  );
}

/** Machine-side state is cleared when the port closes; client preferences are kept. */
export function resetMachineState(prev: MachineState): MachineState {
  return {
    ...prev,
    controller: initialState.controller,
    limits: null,
    workflow: 'idle',
    sender: null,
    feeder: null,
    program: null,
    stopSequence: { phase: 'idle' },
    jobErrors: null,
  };
}
