'use client';

/**
 * Kinetiq machine store: one immutable state object reduced from verified server events.
 * The server is the source of truth; the only client-side flags are `connection.phase === 'opening'`,
 * `connection.userRequestedClose` and (later) `stopSequence`. See docs/ARCHITECTURE.md §6–7.
 */
import { useSyncExternalStore } from 'react';
import type {
  FeederStatus,
  GrblSettings,
  GrblState,
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
  workflow: WorkflowState;
  sender: SenderStatus | null;
  feeder: FeederStatus | null;
  program: { name: string } | null;
}

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
  workflow: 'idle',
  sender: null,
  feeder: null,
  program: null,
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

function subscribe(listener: () => void): () => void {
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
    workflow: 'idle',
    sender: null,
    feeder: null,
    program: null,
  };
}
