'use client';

/**
 * Height-map probing run and the leveling store (current map, map being probed, settings).
 *
 *   G21 G90                       millimetres, absolute work coordinates
 *   G0 Z<clearance>               up to clearance first
 *   per point (snake order):
 *     G0 X<x> Y<y>                move over the point at clearance
 *     G38.2 Z-<depth> F<feed>     probe down (must report contact)
 *     G0 Z<clearance>             back up
 *   <restore distance + units>
 *
 * Contact heights come from `[PRB:…]` (machine coordinates) minus the work offset captured at the
 * start, so the map is in work Z relative to the current Z0. Lines go one at a time
 * (lineSequence.ts); any error, alarm, missing contact, timeout or lost connection stops the run.
 */
import { useSyncExternalStore } from 'react';
import { sendCommand, sendGcode } from '@/lib/cnc/client';
import { moveTimeout, restoreModalLine, SequenceError, sendStep, type SequenceStep } from '@/lib/cnc/lineSequence';
import { workOffset } from '@/lib/cnc/derive';
import { getState, setState } from '@/lib/cnc/store';
import {
  emptyMap,
  gridAxis,
  gridPlanError,
  isComplete,
  loadStoredMap,
  probeOrder,
  storeMap,
  type GridPlan,
  type HeightMap,
} from './heightmap';

export interface LevelingSettings extends GridPlan {
  /** Work Z the tool travels at between points, mm (above the highest point of the stock). */
  clearance: number;
  /** How far below work Z0 each probe may go before giving up, mm. */
  depth: number;
  feed: number;
  /** Margin added around the job area by "Use job area", mm. */
  margin: number;
}

export const DEFAULT_LEVELING_SETTINGS: LevelingSettings = {
  xMin: 0,
  xMax: 50,
  yMin: 0,
  yMax: 50,
  nx: 5,
  ny: 5,
  clearance: 2,
  depth: 1,
  feed: 50,
  margin: 2,
};

export const LEVELING_LIMITS = {
  clearance: { min: 0.5, max: 20, label: 'Clearance', unit: 'mm' },
  depth: { min: 0.2, max: 10, label: 'Probe depth', unit: 'mm' },
  feed: { min: 5, max: 300, label: 'Probe feed', unit: 'mm/min' },
  margin: { min: 0, max: 20, label: 'Margin', unit: 'mm' },
} as const;

export function levelingSettingsError(s: LevelingSettings): string | null {
  const grid = gridPlanError(s);
  if (grid) return grid;
  for (const [key, limit] of Object.entries(LEVELING_LIMITS) as [keyof typeof LEVELING_LIMITS, (typeof LEVELING_LIMITS)[keyof typeof LEVELING_LIMITS]][]) {
    const v = s[key];
    if (!Number.isFinite(v) || v < limit.min || v > limit.max) return `${limit.label} must be between ${limit.min} and ${limit.max} ${limit.unit}`;
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Store
 * ---------------------------------------------------------------------------------------------- */

interface LevelingState {
  /** Last complete map (persisted). */
  map: HeightMap | null;
  /** Map being probed (partial), shown live. */
  probing: HeightMap | null;
  /** Point index being probed, in probe order. */
  current: { i: number; j: number } | null;
  settings: LevelingSettings;
  loaded: boolean;
}

let state: LevelingState = { map: null, probing: null, current: null, settings: DEFAULT_LEVELING_SETTINGS, loaded: false };
const serverSnapshot = state;
const listeners = new Set<() => void>();
const SETTINGS_KEY = 'kinetiq.leveling.settings';

function set(next: Partial<LevelingState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useLeveling(): LevelingState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => serverSnapshot,
  );
}

export function getLeveling(): LevelingState {
  return state;
}

/** Loads the stored map and settings once (browser only). */
export function initLeveling(): void {
  if (state.loaded) return;
  let settings = DEFAULT_LEVELING_SETTINGS;
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<LevelingSettings>;
    settings = { ...DEFAULT_LEVELING_SETTINGS };
    for (const key of Object.keys(DEFAULT_LEVELING_SETTINGS) as (keyof LevelingSettings)[]) {
      const v = stored[key];
      if (typeof v === 'number' && Number.isFinite(v)) settings[key] = v;
    }
  } catch {
    // defaults
  }
  set({ map: loadStoredMap(), settings, loaded: true });
}

export function updateLevelingSettings(patch: Partial<LevelingSettings>): void {
  const settings = { ...state.settings, ...patch };
  set({ settings });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // optional
  }
}

export function setHeightMap(map: HeightMap | null): void {
  storeMap(map);
  set({ map });
}

/* ------------------------------------------------------------------------------------------------
 * Run
 * ---------------------------------------------------------------------------------------------- */

const n = (v: number) => Number(v.toFixed(3)).toString();
let cancelRequested = false;

/** Rough duration in seconds: XY travel at the rapid rate plus each probe down and back up. */
export function estimateSeconds(s: LevelingSettings, rapid: number): number {
  const xs = gridAxis(s.xMin, s.xMax, s.nx);
  const ys = gridAxis(s.yMin, s.yMax, s.ny);
  let travel = 0;
  let prev: [number, number] | null = null;
  for (const { i, j } of probeOrder(s.nx, s.ny)) {
    if (prev) travel += Math.hypot(xs[i] - prev[0], ys[j] - prev[1]);
    prev = [xs[i], ys[j]];
  }
  const probeDown = ((s.clearance + s.depth / 2) / s.feed) * 60;
  const up = (s.clearance / rapid) * 60;
  return Math.round((travel / rapid) * 60 + s.nx * s.ny * (probeDown + up + 0.6));
}

/** Runs the probing. Callers check derive.levelingView() first. */
export async function runLeveling(s: LevelingSettings, rapid: number): Promise<void> {
  const s0 = getState();
  if (s0.leveling.phase === 'running' || levelingSettingsError(s)) return;
  const modal = s0.controller.state?.parserstate?.modal;
  const wco = workOffset(s0);
  if (!wco) {
    setState((st) => ({ ...st, leveling: { phase: 'failed', message: 'The work offset is not known yet', hint: 'Wait for a status report, then try again.', at: Date.now() } }));
    return;
  }
  const map = emptyMap(s, modal?.wcs || 'G54', wco, { clearance: s.clearance, depth: s.depth, feed: s.feed });
  const order = probeOrder(s.nx, s.ny);
  cancelRequested = false;
  set({ probing: map, current: null });

  const total = order.length;
  const progress = (done: number, label: string) =>
    setState((st) => ({ ...st, leveling: { phase: 'running', done, total, label, cancelling: cancelRequested, startedAt: st.leveling.phase === 'running' ? st.leveling.startedAt : Date.now() } }));

  const rapidTime = (mm: number) => Math.ceil((mm / Math.max(rapid, 100)) * 60000 * 2) + 5000;
  const run = async (step: SequenceStep) => sendStep(step, () => cancelRequested);
  let lastXY: [number, number] | null = null;

  try {
    progress(0, 'Preparing');
    await run({ line: 'G21 G90', label: 'Preparing', timeoutMs: 5000 });
    await run({ line: `G0 Z${n(s.clearance)}`, label: 'Raising to clearance', timeoutMs: 15000 });

    for (let k = 0; k < order.length; k++) {
      const { i, j } = order[k];
      const x = map.xs[i];
      const y = map.ys[j];
      set({ current: { i, j } });
      progress(k, `Moving to point ${k + 1} of ${total}`);
      const travel = lastXY ? Math.hypot(x - lastXY[0], y - lastXY[1]) : 1000;
      await run({ line: `G0 X${n(x)} Y${n(y)}`, label: `Moving to point ${k + 1}`, timeoutMs: rapidTime(travel) });
      progress(k, `Probing point ${k + 1} of ${total}`);
      // The probe's ok only comes after the rapid before it has finished, so allow for that too.
      const result = await run({
        line: `G38.2 Z-${n(s.depth)} F${n(s.feed)}`,
        label: `Probing point ${k + 1}`,
        probe: true,
        timeoutMs: moveTimeout(s.clearance + s.depth, s.feed) + rapidTime(travel),
      });
      const contactZ = result.contact!.z - wco.z;
      if (!Number.isFinite(contactZ) || contactZ > s.clearance + 0.01 || contactZ < -s.depth - 0.01) {
        throw new SequenceError(`Point ${k + 1}: the contact height ${contactZ.toFixed(3)} mm is outside the probed range`, 'Check that work Z0 is on the stock surface.');
      }
      const z = map.z.map((row) => row.slice());
      z[j][i] = Math.round(contactZ * 1000) / 1000;
      map.z = z;
      set({ probing: { ...map } });
      await run({ line: `G0 Z${n(s.clearance)}`, label: `Lifting after point ${k + 1}`, timeoutMs: 15000 });
      lastXY = [x, y];
    }
    await run({ line: restoreModalLine(modal?.distance, modal?.units), label: 'Finishing', timeoutMs: 5000 });
  } catch (err) {
    const e = err instanceof SequenceError ? err : new SequenceError(err instanceof Error ? err.message : 'Probing failed');
    set({ current: null });
    if (cancelRequested || e.cancelled) {
      setState((st) => ({ ...st, leveling: { phase: 'cancelled', at: Date.now() } }));
    } else {
      setState((st) => ({ ...st, leveling: { phase: 'failed', message: e.message, hint: e.hint, at: Date.now() } }));
    }
    if (getState().connection.phase === 'open' && getState().controller.state?.status.activeState !== 'Alarm') {
      sendGcode(restoreModalLine(modal?.distance, modal?.units));
    }
    return;
  }

  set({ current: null });
  if (isComplete(map)) {
    setHeightMap({ ...map, createdAt: Date.now() });
    set({ probing: null });
    setState((st) => ({ ...st, leveling: { phase: 'done', at: Date.now() } }));
  } else {
    setState((st) => ({ ...st, leveling: { phase: 'failed', message: 'Some points were not probed', hint: null, at: Date.now() } }));
  }
}

/** Stops the run: no further lines, then Feed hold and a soft reset to end the current move. */
export function cancelLeveling(): void {
  if (getState().leveling.phase !== 'running') return;
  cancelRequested = true;
  setState((st) => (st.leveling.phase === 'running' ? { ...st, leveling: { ...st.leveling, cancelling: true } } : st));
  sendCommand('feedhold');
  setTimeout(() => sendCommand('reset'), 400);
}

export function clearLevelingResult(): void {
  setState((st) => (st.leveling.phase === 'running' ? st : { ...st, leveling: { phase: 'idle' } }));
}

export function discardProbing(): void {
  if (getState().leveling.phase === 'running') return;
  set({ probing: null, current: null });
}
