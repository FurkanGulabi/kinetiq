'use client';

/**
 * Console log (API_REFERENCE §6): what the controller sends
 * (`serialport:read`) and what is written to it (`serialport:write`), newest last.
 *
 * - Ring buffer of MAX_LINES entries, so a long session cannot grow without bound.
 * - Appends are batched per animation frame: a `$$` or a config dump arrives as dozens of lines
 *   in one burst and should cost one render, not one per line.
 * - Echo: every write comes back from the server as `serialport:write` to every tab, with the
 *   sender's `__sender__`. Nothing is echoed locally, so there are no duplicates, and a command
 *   typed in another tab shows up here too.
 * - Status-report polling (`?`, `$G`) is written by the server without an echo, and its replies are
 *   forwarded only when a user asked for them (GrblController actionMask), so they never flood.
 */
import { useSyncExternalStore } from 'react';

export const MAX_LINES = 2000;

/** API_REFERENCE §6.1 classes for incoming lines, plus `out` for writes. */
export type ConsoleKind = 'out' | 'error' | 'alarm' | 'msg' | 'status' | 'ok' | 'response' | 'program';
export type MsgLevel = 'info' | 'warn' | 'err' | null;
/** Who wrote an `out` line: this tab, another tab, or Kinetiq's own server-side sequences. */
export type ConsoleOrigin = 'self' | 'other' | 'kinetiq';

export interface ConsoleEntry {
  id: number;
  kind: ConsoleKind;
  text: string;
  time: number;
  origin?: ConsoleOrigin;
  level?: MsgLevel;
}

export function classify(line: string): { kind: ConsoleKind; level?: MsgLevel } {
  if (/^error:/i.test(line)) return { kind: 'error' };
  if (/^ALARM:/i.test(line)) return { kind: 'alarm' };
  if (/^\[MSG:/i.test(line)) {
    const level = /^\[MSG:\s*WARN/i.test(line) ? 'warn' : /^\[MSG:\s*ERR/i.test(line) ? 'err' : /^\[MSG:\s*INFO/i.test(line) ? 'info' : null;
    return { kind: 'msg', level };
  }
  if (line.startsWith('<')) return { kind: 'status' };
  if (/^ok$/i.test(line)) return { kind: 'ok' };
  // While a program runs, CNCjs reports the line an error came from as "> <line> (ln=N)".
  if (line.startsWith('> ')) return { kind: 'program' };
  return { kind: 'response' };
}

let entries: ConsoleEntry[] = [];
let pending: ConsoleEntry[] = [];
let nextId = 1;
let frame = 0;
const listeners = new Set<() => void>();

function flush() {
  frame = 0;
  if (pending.length === 0) return;
  const merged = entries.concat(pending);
  entries = merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
  pending = [];
  for (const l of listeners) l();
}

function push(entry: Omit<ConsoleEntry, 'id' | 'time'>) {
  pending.push({ ...entry, id: nextId++, time: Date.now() });
  if (pending.length > MAX_LINES) pending = pending.slice(pending.length - MAX_LINES);
  if (!frame) {
    // A background tab gets no animation frames; fall back to a timer so the buffer still drains.
    frame =
      typeof document !== 'undefined' && document.visibilityState === 'visible'
        ? requestAnimationFrame(flush)
        : (setTimeout(flush, 250) as unknown as number);
  }
}

/** A line from the controller (`serialport:read`). */
export function consoleRead(line: string): void {
  const text = line.replace(/\s+$/, '');
  if (!text) return;
  push({ text, ...classify(text) });
}

/** A line written to the controller (`serialport:write`), echoed by the server to every tab. */
export function consoleWrite(data: string, sender: string | undefined, clientId: string): void {
  const text = data.replace(/[\r\n]+$/, '');
  if (!text.trim()) return;
  // Real-time bytes (0x80+: overrides, jog cancel) are not readable text.
  if (/^[\x80-\xff]$/.test(text)) return;
  const origin: ConsoleOrigin = !sender ? 'kinetiq' : sender === clientId ? 'self' : 'other';
  push({ kind: 'out', text, origin });
}

export function clearConsole(): void {
  if (frame) {
    cancelAnimationFrame(frame);
    clearTimeout(frame);
    frame = 0;
  }
  pending = [];
  entries = [];
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => entries;
const EMPTY: ConsoleEntry[] = [];
const getServerSnapshot = () => EMPTY;

export function useConsole(): ConsoleEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// --- input history (per tab, newest last) -------------------------------------------------------

const HISTORY_KEY = 'kinetiq.consoleHistory';
const MAX_HISTORY = 50;

export function loadHistory(): string[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(-MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

export function pushHistory(history: string[], line: string): string[] {
  const next = history[history.length - 1] === line ? history : [...history, line].slice(-MAX_HISTORY);
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // History is a convenience.
  }
  return next;
}
