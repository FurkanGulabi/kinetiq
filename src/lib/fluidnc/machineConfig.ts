'use client';

/**
 * Client for the machine settings editor API (src/server/fluidnc/machineConfig.ts).
 * Stage S1: read the FluidNC config. While a read runs, `configBusy` in the machine store
 * disables jog, homing and job start (derive.ts), so no other line competes for the serial port.
 */
import { useSyncExternalStore } from 'react';
import { getSessionToken, invalidateSessionToken } from '@/lib/cnc/client';
import { setState } from '@/lib/cnc/store';

const API = '/api/kinetiq/machine-config';

export type BootLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'other';

export interface ConfigDifference {
  path: string;
  saved: string;
  running: string;
}

export interface MachineConfigSnapshot {
  filename: string;
  saved: string;
  savedSha256: string;
  running: string;
  bootLog: { level: BootLogLevel; text: string }[];
  fs: { files: { name: string; size: number }[]; free: string | null; used: string | null; total: string | null };
  differences: ConfigDifference[];
  defaultsCount: number;
  readAt: number;
}

interface MachineConfigState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  snapshot: MachineConfigSnapshot | null;
  error: string | null;
}

let state: MachineConfigState = { status: 'idle', snapshot: null, error: null };
const serverSnapshot = state;
const listeners = new Set<() => void>();

function set(next: Partial<MachineConfigState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useMachineConfig(): MachineConfigState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => serverSnapshot,
  );
}

async function request(retried = false): Promise<Response> {
  const token = await getSessionToken();
  const res = await fetch(API, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 403 && !retried) {
    invalidateSessionToken();
    return request(true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return res;
}

/** Reads the config from the controller. Keeps the previous snapshot visible if the read fails. */
export async function readMachineConfig(): Promise<void> {
  if (state.status === 'loading') return;
  set({ status: 'loading', error: null });
  setState((s) => ({ ...s, configBusy: true }));
  try {
    const snapshot = (await (await request()).json()) as MachineConfigSnapshot;
    set({ status: 'ready', snapshot, error: null });
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : 'Could not read the machine config' });
  } finally {
    setState((s) => ({ ...s, configBusy: false }));
  }
}
