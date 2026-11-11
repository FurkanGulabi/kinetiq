'use client';

/**
 * Client for Kinetiq's macro API (src/server/macros.ts, docs/API_REFERENCE.md §7.6).
 *
 * The macro list is not machine state: it is kept in this small store, refreshed from the server
 * (when the Macros widget mounts or opens, when the tab regains focus, and after every change), so
 * two open tabs agree at the latest when one of them is reopened, refocused or refreshed. Running a
 * macro is `runMacro(id)` in lib/cnc/client.ts; only the id goes over the socket.
 */
import { useSyncExternalStore } from 'react';
import { getSessionToken, invalidateSessionToken } from '@/lib/cnc/client';
import { validateMacroInput, type Macro } from './macro';

export type { Macro } from './macro';

const API = '/api/kinetiq/macros';

interface MacroLibraryState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  macros: Macro[];
  error: string | null;
}

let state: MacroLibraryState = { status: 'idle', macros: [], error: null };
const listeners = new Set<() => void>();
const serverSnapshot: MacroLibraryState = state;

function set(next: Partial<MacroLibraryState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useMacroLibrary(): MacroLibraryState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => serverSnapshot,
  );
}

/** An API error with the server's message and HTTP status. */
export class MacroApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const token = await getSessionToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (res.status === 403 && !retried) {
    invalidateSessionToken(); // expired token: mint a fresh one once
    return request(path, init, true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new MacroApiError(body?.error || `Request failed (${res.status})`, res.status);
  }
  return res;
}

let refreshing: Promise<void> | null = null;

export function refreshMacros(): Promise<void> {
  if (refreshing) return refreshing;
  if (state.status === 'idle') set({ status: 'loading' });
  refreshing = (async () => {
    try {
      const macros = (await (await request('')).json()) as Macro[];
      set({ status: 'ready', macros, error: null });
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : 'Could not load the macros' });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function check(name: string, content: string): { name: string; content: string } {
  const result = validateMacroInput(name, content);
  if (!result.ok) throw new MacroApiError(result.error, 400);
  return { name: result.name, content: result.content };
}

/** A 404 means another tab deleted it: refresh so this tab's list catches up. */
function refreshOnMissing(err: unknown): never {
  if (err instanceof MacroApiError && err.status === 404) void refreshMacros();
  throw err;
}

export async function createMacro(name: string, content: string): Promise<Macro> {
  const body = check(name, content);
  const res = await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const macro = (await res.json()) as Macro;
  set({ macros: [...state.macros.filter((m) => m.id !== macro.id), macro] });
  return macro;
}

export async function updateMacro(id: string, name: string, content: string): Promise<Macro> {
  const body = check(name, content);
  try {
    const res = await request(`/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const macro = (await res.json()) as Macro;
    set({ macros: state.macros.map((m) => (m.id === id ? macro : m)) });
    return macro;
  } catch (err) {
    return refreshOnMissing(err);
  }
}

export async function deleteMacro(id: string): Promise<void> {
  try {
    await request(`/${id}`, { method: 'DELETE' });
  } catch (err) {
    // Already gone elsewhere: the result the operator wanted.
    if (!(err instanceof MacroApiError && err.status === 404)) throw err;
  }
  set({ macros: state.macros.filter((m) => m.id !== id) });
}
