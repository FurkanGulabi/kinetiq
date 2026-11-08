'use client';

/**
 * Client for the machine settings editor API (src/server/fluidnc/machineConfig.ts): read, save,
 * restart and backups. While any of these talks to the controller, `configBusy` in the machine
 * store disables jog, homing and job start (derive.ts), so no other line competes for the port.
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

export interface BackupInfo {
  id: string;
  filename: string;
  size: number;
  savedAt: number;
}

export interface SaveResult {
  filename: string;
  savedSha256: string;
  bytes: number;
  backup: BackupInfo;
  restartRequired: true;
}

export interface RestartResult {
  bootLog: { level: BootLogLevel; text: string }[];
  banner: string | null;
}

export type Operation = 'reading' | 'saving' | 'restarting' | 'restoring';

interface MachineConfigState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  snapshot: MachineConfigSnapshot | null;
  error: string | null;
  /** The operation talking to the controller right now, if any. */
  operation: Operation | null;
  /** The last successful save since the panel was opened; cleared by a restart. */
  lastSave: SaveResult | null;
  lastRestart: RestartResult | null;
  /** Error of the last save/restart/restore (reads use `error`). */
  operationError: string | null;
}

let state: MachineConfigState = {
  status: 'idle',
  snapshot: null,
  error: null,
  operation: null,
  lastSave: null,
  lastRestart: null,
  operationError: null,
};
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

async function request(path = '', init: RequestInit = {}, retried = false): Promise<Response> {
  const token = await getSessionToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (res.status === 403 && !retried) {
    invalidateSessionToken();
    return request(path, init, true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return res;
}

/** Runs one controller operation with the busy flag set; returns null if another one is running. */
async function operate<T>(operation: Operation, task: () => Promise<T>): Promise<T | null> {
  if (state.operation) return null;
  set({ operation, operationError: null });
  setState((s) => ({ ...s, configBusy: true }));
  try {
    return await task();
  } catch (err) {
    set({ operationError: err instanceof Error ? err.message : 'The operation failed' });
    return null;
  } finally {
    set({ operation: null });
    setState((s) => ({ ...s, configBusy: false }));
  }
}

/** Reads the config from the controller. Keeps the previous snapshot visible if the read fails. */
export async function readMachineConfig(): Promise<void> {
  if (state.operation) return;
  set({ status: 'loading', error: null, operation: 'reading' });
  setState((s) => ({ ...s, configBusy: true }));
  try {
    const snapshot = (await (await request()).json()) as MachineConfigSnapshot;
    set({ status: 'ready', snapshot, error: null });
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : 'Could not read the machine config' });
  } finally {
    set({ operation: null });
    setState((s) => ({ ...s, configBusy: false }));
  }
}

/** Backs up, uploads and verifies `text` as the active config file. Re-reads afterwards. */
export async function saveMachineConfig(text: string, baseSha256: string): Promise<SaveResult | null> {
  const result = await operate('saving', async () => {
    const res = await request('', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, baseSha256 }),
    });
    return (await res.json()) as SaveResult;
  });
  if (result) {
    set({ lastSave: result });
    await readMachineConfig();
  }
  return result;
}

/** `$Bye`: FluidNC restarts with the saved file and comes back in Alarm. Re-reads afterwards. */
export async function restartController(): Promise<RestartResult | null> {
  const result = await operate('restarting', async () => {
    const res = await request('/restart', { method: 'POST' });
    return (await res.json()) as RestartResult;
  });
  if (result) {
    set({ lastRestart: result, lastSave: null });
    // Give the controller a moment to report status before reading again.
    await new Promise((r) => setTimeout(r, 1500));
    await readMachineConfig();
  }
  return result;
}

export async function listBackups(): Promise<BackupInfo[]> {
  return (await (await request('/backups')).json()) as BackupInfo[];
}

export async function fetchBackup(id: string): Promise<string> {
  return (await request(`/backups/${encodeURIComponent(id)}`)).text();
}

/** Writes a backup back as the active config file (same checks as a save). */
export async function restoreBackup(id: string): Promise<SaveResult | null> {
  const result = await operate('restoring', async () => {
    const res = await request(`/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    return (await res.json()) as SaveResult;
  });
  if (result) {
    set({ lastSave: result });
    await readMachineConfig();
  }
  return result;
}

export function clearOperationError(): void {
  set({ operationError: null });
}
