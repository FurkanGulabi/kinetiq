'use client';

/**
 * Client for Kinetiq's job library (src/server/jobs.ts): uploaded G-code files and recent runs.
 * A small shared store so the Job panel and the upload dialog show the same list.
 */
import { useSyncExternalStore } from 'react';
import { getSessionToken, invalidateSessionToken, loadProgram } from '@/lib/cnc/client';

const API = '/api/kinetiq/jobs';
export const ACCEPTED_EXTENSIONS = ['.nc', '.gcode', '.gc', '.ngc', '.tap', '.cnc', '.txt'];
export const MAX_JOB_BYTES = 50 * 1024 * 1024;

export type JobRunStatus = 'completed' | 'cancelled' | 'error';

export interface JobRun {
  status: JobRunStatus;
  startedAt: number;
  endedAt: number;
}

export interface JobRecord {
  id: string;
  name: string;
  size: number;
  lines: number;
  sha256: string;
  uploadedAt: number;
  lastUsedAt: number;
  lastRun: JobRun | null;
}

interface LibraryState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  jobs: JobRecord[];
  error: string | null;
}

let state: LibraryState = { status: 'idle', jobs: [], error: null };
const listeners = new Set<() => void>();
const serverSnapshot: LibraryState = state;

function set(next: Partial<LibraryState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useJobLibrary(): LibraryState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => serverSnapshot,
  );
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
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return res;
}

function upsert(record: JobRecord): void {
  const jobs = [record, ...state.jobs.filter((j) => j.id !== record.id)].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  set({ jobs });
}

export async function refreshJobs(): Promise<void> {
  if (state.status === 'idle') set({ status: 'loading' });
  try {
    const jobs = (await (await request('')).json()) as JobRecord[];
    set({ status: 'ready', jobs, error: null });
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : 'Could not load recent jobs' });
  }
}

export function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Validates locally, stores the file in the library and returns its record plus the text. */
export async function uploadJob(file: File): Promise<{ record: JobRecord; gcode: string }> {
  if (!hasAcceptedExtension(file.name)) {
    throw new Error(`“${file.name}” is not a G-code file. Use ${ACCEPTED_EXTENSIONS.join(', ')}.`);
  }
  if (file.size > MAX_JOB_BYTES) {
    throw new Error(`“${file.name}” is larger than ${MAX_JOB_BYTES / 1024 / 1024} MB.`);
  }
  const gcode = await file.text();
  const res = await request(`?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: gcode,
  });
  const record = (await res.json()) as JobRecord;
  upsert(record);
  return { record, gcode };
}

/** Fetches a library job and loads it onto the controller (CNCjs `gcode:load`). */
export async function loadJob(record: JobRecord, gcode?: string): Promise<void> {
  const text = gcode ?? (await (await request(`/${record.id}/gcode`)).text());
  await loadProgram(record.name, text, record.id);
  touchJob(record.id);
}

function touchJob(id: string): void {
  void request(`/${id}`, { method: 'PATCH', body: JSON.stringify({ touch: true }) })
    .then(async (res) => upsert((await res.json()) as JobRecord))
    .catch(() => undefined);
}

export async function recordRun(id: string, run: JobRun): Promise<void> {
  try {
    const res = await request(`/${id}`, { method: 'PATCH', body: JSON.stringify({ lastRun: run }) });
    const record = (await res.json()) as JobRecord;
    set({ jobs: state.jobs.map((j) => (j.id === id ? record : j)) });
  } catch {
    // History is best-effort; the run itself already happened.
  }
}

export async function removeJob(id: string): Promise<void> {
  await request(`/${id}`, { method: 'DELETE' });
  set({ jobs: state.jobs.filter((j) => j.id !== id) });
}

/* ---------- formatting ---------- */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Middle truncation keeps the extension and the distinguishing tail of long CAM file names. */
export function middleTruncate(name: string, max = 44): string {
  if (name.length <= max) return name;
  const tail = Math.ceil(max * 0.4);
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}
