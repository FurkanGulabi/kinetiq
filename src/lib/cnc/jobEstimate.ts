/**
 * Live remaining-time estimate for the loaded program (docs/API_REFERENCE.md §7.3). Client only; the
 * socket protocol is unchanged and the backend's line-count `remainingTime` stays as the fallback.
 *
 * - The program's toolpath and the machine's `$110–$112` / `$120–$122` give a time model
 *   (`src/lib/gcode/estimate.ts`).
 * - Where the tool is: acknowledged lines (`sender.received`) run ahead of the motion by the planner
 *   depth, so the tool is located on the toolpath from the reported work position instead, searching
 *   forward from the last match up to the last acknowledged segment. If the position is not on the
 *   path (G53/G92/G28 moves, which are not drawn), it falls back to the acknowledged line.
 * - Remaining = model time from that point on, under the current feed / rapid overrides.
 * - Calibration: the time the machine actually spent moving (holds and pauses excluded) is compared
 *   with what the model predicted for the same stretch; the ratio corrects the rest, phased in as
 *   more of the job has run.
 */
import { useSyncExternalStore } from 'react';
import { buildTimeModel, motionLimits, timeDone, timeTotal, withOverrides, type TimeModel, type TimeSplit } from '@/lib/gcode/estimate';
import { toolpathFor, type Toolpath } from '@/lib/gcode/toolpath';
import { reportUnits } from './derive';
import { getState, subscribe, type MachineState } from './store';

export interface JobEstimate {
  /** While a job runs or is paused: estimated time left, ms. */
  remainingMs: number | null;
  /** With a program loaded and no job running: estimated run time, ms (before calibration). */
  totalMs: number | null;
  /** True once the estimate is corrected by the measured speed of this run. */
  calibrated: boolean;
}

const EMPTY: JobEstimate = { remainingMs: null, totalMs: null, calibrated: false };

/** A position within this distance of a segment is on it (mm): arc chords + report rounding. */
const ON_PATH_MM = 0.05;
/** Nearest segment accepted when nothing is within ON_PATH_MM (mm). */
const NEAR_PATH_MM = 0.5;
/** Segments searched per update, counted back from the last acknowledged one. */
const SEARCH_WINDOW = 4000;
/** States in which the machine is not executing the program (time not counted for calibration). */
const NOT_MOVING = new Set(['Hold', 'Door', 'Alarm', 'Sleep', 'Check']);

interface Run {
  startTime: number;
  cursor: number; // segment the tool is on (monotonic)
  fraction: number; // of that segment done
  lastTs: number;
  activeMs: number; // time the machine was executing
  predictedSec: number; // model time for the same stretch, under the overrides of the moment
  lastDone: TimeSplit;
}

let model: { gcode: string; limitsKey: string; toolpath: Toolpath; time: TimeModel } | null = null;
let pendingBuild: ReturnType<typeof setTimeout> | undefined;
let run: Run | null = null;
let snapshot: JobEstimate = EMPTY;
const listeners = new Set<() => void>();
let unsubscribeStore: (() => void) | null = null;

function emit(next: JobEstimate) {
  const same =
    next.calibrated === snapshot.calibrated &&
    roughlyEqual(next.remainingMs, snapshot.remainingMs) &&
    roughlyEqual(next.totalMs, snapshot.totalMs);
  if (same) return;
  snapshot = next;
  for (const l of listeners) l();
}

function roughlyEqual(a: number | null, b: number | null) {
  return a === null || b === null ? a === b : Math.abs(a - b) < 250;
}

function limitsKey(s: MachineState): string {
  const set = s.controller.settings?.settings;
  return ['$110', '$111', '$112', '$120', '$121', '$122'].map((k) => set?.[k] ?? '').join(',');
}

/** The time model for the loaded program, or null while it is being built (off the store event). */
function currentModel(s: MachineState) {
  const gcode = s.program?.gcode;
  if (!gcode) {
    model = null;
    return null;
  }
  const key = limitsKey(s);
  if (model && model.gcode === gcode && model.limitsKey === key) return model;
  if (pendingBuild === undefined) {
    pendingBuild = setTimeout(() => {
      pendingBuild = undefined;
      const now = getState();
      const g = now.program?.gcode;
      if (!g) return;
      const toolpath = toolpathFor(g);
      model = {
        gcode: g,
        limitsKey: limitsKey(now),
        toolpath,
        time: buildTimeModel(toolpath, motionLimits(now.controller.settings?.settings)),
      };
      update();
    }, 0);
  }
  return null;
}

function overrides(s: MachineState): [number, number] {
  const ov = s.controller.state?.status.ov ?? [];
  return [ov[0] || 100, ov[1] || 100];
}

function workPosition(s: MachineState): [number, number, number] | null {
  const w = s.controller.state?.status.wpos;
  if (!w) return null;
  const scale = reportUnits(s) === 'in' ? 25.4 : 1;
  const v = [w.x, w.y, w.z].map((a) => (a === undefined || a === '' ? NaN : Number(a) * scale));
  return v.every(Number.isFinite) ? (v as [number, number, number]) : null;
}

/** First segment index whose program line is >= `line` (segments are in line order). */
function firstSegmentOfLine(tp: Toolpath, line: number): number {
  let lo = 0;
  let hi = tp.segmentCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tp.lines[mid] < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Distance from p to segment i and the fraction along it of the closest point. */
function distanceToSegment(tp: Toolpath, i: number, p: [number, number, number]): [number, number] {
  const o = i * 6;
  const a = tp.positions;
  const d0 = a[o + 3] - a[o];
  const d1 = a[o + 4] - a[o + 1];
  const d2 = a[o + 5] - a[o + 2];
  const l2 = d0 * d0 + d1 * d1 + d2 * d2;
  let t = l2 > 0 ? ((p[0] - a[o]) * d0 + (p[1] - a[o + 1]) * d1 + (p[2] - a[o + 2]) * d2) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [Math.hypot(a[o] + d0 * t - p[0], a[o + 1] + d1 * t - p[1], a[o + 2] + d2 * t - p[2]), t];
}

/** Moves the run cursor to where the tool is (never backwards). */
function locate(r: Run, tp: Toolpath, received: number, pos: [number, number, number] | null) {
  const end = firstSegmentOfLine(tp, received); // segments before this are acknowledged
  if (end <= r.cursor) return;
  const from = Math.max(r.cursor, end - SEARCH_WINDOW);
  if (pos) {
    let best = -1;
    let bestDist = Infinity;
    let bestT = 0;
    for (let i = from; i < end; i++) {
      const [d, t] = distanceToSegment(tp, i, pos);
      if (d <= ON_PATH_MM) {
        // First match going forward: on a path that retraces itself, the earlier pass comes first.
        if (i > r.cursor || t >= r.fraction) {
          r.cursor = i;
          r.fraction = t;
        }
        return;
      }
      if (d < bestDist) {
        bestDist = d;
        best = i;
        bestT = t;
      }
    }
    if (best >= 0 && bestDist <= NEAR_PATH_MM) {
      r.cursor = best;
      r.fraction = bestT;
      return;
    }
  }
  // Off the drawn path or no position: trust the acknowledged lines.
  r.cursor = Math.max(r.cursor, end - 1);
  r.fraction = 0;
}

function update() {
  const s = getState();
  const m = currentModel(s);
  const sender = s.sender;
  if (!m || !sender) {
    run = null;
    emit(EMPTY);
    return;
  }
  const [feedOv, rapidOv] = overrides(s);
  const total = timeTotal(m.time);

  if (s.workflow === 'idle' || !sender.startTime) {
    run = null;
    const finished = (sender.finishTime ?? 0) > 0 && !!sender.startTime;
    emit({ remainingMs: null, totalMs: finished ? null : withOverrides(total, feedOv, rapidOv) * 1000, calibrated: false });
    return;
  }

  const now = Date.now();
  if (!run || run.startTime !== sender.startTime) {
    run = {
      startTime: sender.startTime,
      cursor: 0,
      fraction: 0,
      lastTs: now,
      activeMs: 0,
      predictedSec: 0,
      lastDone: { feed: 0, rapid: 0, dwell: 0 },
    };
  }
  const r = run;
  const active = s.controller.state?.status.activeState ?? '';
  if (s.workflow === 'running' && !NOT_MOVING.has(active)) r.activeMs += now - r.lastTs;
  r.lastTs = now;

  locate(r, m.toolpath, sender.received, workPosition(s));
  const line = r.cursor < m.toolpath.segmentCount ? m.toolpath.lines[r.cursor] : m.toolpath.lineCount;
  const done = timeDone(m.time, r.cursor, r.fraction, line);
  const step = {
    feed: Math.max(0, done.feed - r.lastDone.feed),
    rapid: Math.max(0, done.rapid - r.lastDone.rapid),
    dwell: Math.max(0, done.dwell - r.lastDone.dwell),
  };
  r.predictedSec += withOverrides(step, feedOv, rapidOv);
  r.lastDone = done;

  const left = withOverrides(
    { feed: total.feed - done.feed, rapid: total.rapid - done.rapid, dwell: total.dwell - done.dwell },
    feedOv,
    rapidOv,
  );
  const activeSec = r.activeMs / 1000;
  let factor = 1;
  let calibrated = false;
  if (r.predictedSec >= 2 && activeSec >= 3) {
    const ratio = Math.max(0.2, Math.min(5, activeSec / r.predictedSec));
    const totalSec = withOverrides(total, feedOv, rapidOv);
    const weight = Math.min(1, r.predictedSec / Math.max(20, 0.25 * totalSec));
    factor = 1 + (ratio - 1) * weight;
    calibrated = true;
  }
  emit({ remainingMs: Math.max(0, left * factor * 1000), totalMs: null, calibrated });
}

function subscribeEstimate(listener: () => void): () => void {
  listeners.add(listener);
  if (!unsubscribeStore) {
    unsubscribeStore = subscribe(update);
    update();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribeStore) {
      unsubscribeStore();
      unsubscribeStore = null;
      run = null;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

/** Remaining / total run-time estimate for the Job widget. */
export function useJobEstimate(): JobEstimate {
  return useSyncExternalStore(subscribeEstimate, getSnapshot, getServerSnapshot);
}
