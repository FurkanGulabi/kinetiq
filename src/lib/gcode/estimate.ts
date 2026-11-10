/**
 * Run-time estimate for a parsed toolpath. Pure and dependency-free.
 *
 * Model (docs/API_REFERENCE.md §7.3):
 * - Each segment runs at its programmed feed (rapids at the machine's max rate), capped by the
 *   per-axis max rates ($110–$112) along the segment's direction.
 * - Acceleration ($120–$122) costs time where the machine has to slow down: from rest at the start,
 *   to rest at the end, and at every corner. A full stop from v and back costs v/a; a corner costs a
 *   share of that growing with the angle ((1 − cos θ)/2: 0 straight on, 1 for a reversal). The speed
 *   used for a corner is capped by what a short neighbouring segment can reach (√(a·L)).
 * - G4 dwells add their time.
 * Not modelled: GRBL's exact junction-deviation planner, arcs as GRBL splits them, spindle spin-up,
 * M0/M6 pauses (operator time). The live tracker (`src/lib/cnc/jobEstimate.ts`) corrects the
 * remaining systematic error by comparing the prediction with the real elapsed time.
 *
 * Times are kept as feed time and rapid time separately so feed and rapid overrides can be applied
 * to the remaining part without re-running the model.
 */
import type { Toolpath } from './toolpath';

export interface MotionLimits {
  /** Max rate per axis, mm/min (X, Y, Z). */
  maxRate: [number, number, number];
  /** Acceleration per axis, mm/s² (X, Y, Z); Infinity when unknown (no acceleration cost). */
  accel: [number, number, number];
}

/** Used for an axis whose `$11x` setting is missing. */
export const DEFAULT_MAX_RATE = 1000;
/** Used when a feed move has no F at all (GRBL would reject it; keeps the estimate finite). */
const FALLBACK_FEED = 100;

export interface TimeModel {
  segmentCount: number;
  /** Seconds of feed / rapid motion of each segment, acceleration share included. */
  feedSec: Float64Array;
  rapidSec: Float64Array;
  /** Cumulative feed / rapid seconds BEFORE segment i (length segmentCount + 1). */
  feedBefore: Float64Array;
  rapidBefore: Float64Array;
  /** Dwells sorted by program line, with cumulative seconds before each one. */
  dwellLines: Uint32Array;
  dwellBefore: Float64Array; // length dwellLines.length + 1
  totalFeedSec: number;
  totalRapidSec: number;
  totalDwellSec: number;
}

/** Reads $110–$112 and $120–$122 from the `$$` settings (GRBL units: mm/min, mm/s²). */
export function motionLimits(settings: Record<string, string> | undefined): MotionLimits {
  const read = (key: string) => {
    const v = Number(settings?.[key]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const rate = (k: string) => read(k) ?? DEFAULT_MAX_RATE;
  const acc = (k: string) => read(k) ?? Infinity;
  return {
    maxRate: [rate('$110'), rate('$111'), rate('$112')],
    accel: [acc('$120'), acc('$121'), acc('$122')],
  };
}

export function buildTimeModel(tp: Toolpath, limits: MotionLimits): TimeModel {
  const n = tp.segmentCount;
  const feedSec = new Float64Array(n);
  const rapidSec = new Float64Array(n);
  const p = tp.positions;

  // Per segment: length, unit direction, cruise speed (mm/s), acceleration along it (mm/s²).
  const len = new Float64Array(n);
  const dir = new Float64Array(n * 3);
  const speed = new Float64Array(n);
  const acc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const d0 = p[o + 3] - p[o];
    const d1 = p[o + 4] - p[o + 1];
    const d2 = p[o + 5] - p[o + 2];
    const L = Math.hypot(d0, d1, d2);
    len[i] = L;
    if (L === 0) continue;
    const u = [d0 / L, d1 / L, d2 / L];
    dir[i * 3] = u[0];
    dir[i * 3 + 1] = u[1];
    dir[i * 3 + 2] = u[2];
    let vMax = Infinity; // mm/min
    let aMax = Infinity;
    for (let k = 0; k < 3; k++) {
      const c = Math.abs(u[k]);
      if (c < 1e-9) continue;
      vMax = Math.min(vMax, limits.maxRate[k] / c);
      aMax = Math.min(aMax, limits.accel[k] / c);
    }
    const programmed = tp.kinds[i] === 0 ? Infinity : tp.feeds[i] > 0 ? tp.feeds[i] : FALLBACK_FEED;
    speed[i] = Math.min(vMax, programmed) / 60;
    acc[i] = aMax;
  }

  // Speed a segment can actually reach and carry through a corner: a short segment between two
  // stops tops out near √(a·L).
  const reachable = (i: number) => (Number.isFinite(acc[i]) ? Math.min(speed[i], Math.sqrt(acc[i] * len[i])) : speed[i]);

  let prev = -1; // previous segment with a length
  for (let i = 0; i < n; i++) {
    const L = len[i];
    if (L === 0) continue;
    let t = L / speed[i];
    const a = acc[i];
    if (Number.isFinite(a)) {
      if (prev < 0) {
        t += reachable(i) / (2 * a); // start from rest
      } else {
        const cos = dir[prev * 3] * dir[i * 3] + dir[prev * 3 + 1] * dir[i * 3 + 1] + dir[prev * 3 + 2] * dir[i * 3 + 2];
        const share = (1 - Math.max(-1, Math.min(1, cos))) / 2;
        if (share > 1e-6) {
          const v = Math.min(reachable(prev), reachable(i));
          t += (share * v) / Math.min(a, acc[prev]);
        }
      }
    }
    if (tp.kinds[i] === 0) rapidSec[i] = t;
    else feedSec[i] = t;
    prev = i;
  }
  if (prev >= 0 && Number.isFinite(acc[prev])) {
    const stop = reachable(prev) / (2 * acc[prev]); // to rest at the end
    if (tp.kinds[prev] === 0) rapidSec[prev] += stop;
    else feedSec[prev] += stop;
  }

  const feedBefore = new Float64Array(n + 1);
  const rapidBefore = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    feedBefore[i + 1] = feedBefore[i] + feedSec[i];
    rapidBefore[i + 1] = rapidBefore[i] + rapidSec[i];
  }

  const dwells = [...tp.dwells].sort((x, y) => x.line - y.line);
  const dwellLines = Uint32Array.from(dwells, (d) => d.line);
  const dwellBefore = new Float64Array(dwells.length + 1);
  dwells.forEach((d, i) => (dwellBefore[i + 1] = dwellBefore[i] + d.seconds));

  return {
    segmentCount: n,
    feedSec,
    rapidSec,
    feedBefore,
    rapidBefore,
    dwellLines,
    dwellBefore,
    totalFeedSec: feedBefore[n],
    totalRapidSec: rapidBefore[n],
    totalDwellSec: dwellBefore[dwells.length],
  };
}

/** Program time split by kind, in seconds. */
export interface TimeSplit {
  feed: number;
  rapid: number;
  dwell: number;
}

/**
 * Time already covered at a point in the program: segment `seg`, fraction `t` (0..1) of it done, and
 * dwells on lines before `line` done.
 */
export function timeDone(m: TimeModel, seg: number, t: number, line: number): TimeSplit {
  const s = Math.max(0, Math.min(m.segmentCount, seg));
  const f = s < m.segmentCount ? Math.max(0, Math.min(1, t)) : 0;
  let feed = m.feedBefore[s];
  let rapid = m.rapidBefore[s];
  if (s < m.segmentCount) {
    feed += m.feedSec[s] * f;
    rapid += m.rapidSec[s] * f;
  }
  // Dwells strictly before `line`.
  let lo = 0;
  let hi = m.dwellLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m.dwellLines[mid] < line) lo = mid + 1;
    else hi = mid;
  }
  return { feed, rapid, dwell: m.dwellBefore[lo] };
}

export function timeTotal(m: TimeModel): TimeSplit {
  return { feed: m.totalFeedSec, rapid: m.totalRapidSec, dwell: m.totalDwellSec };
}

/** Seconds for a time split under feed / rapid overrides (percent). Dwells are not overridden. */
export function withOverrides(t: TimeSplit, feedPct: number, rapidPct: number): number {
  const fp = feedPct > 0 ? feedPct : 100;
  const rp = rapidPct > 0 ? rapidPct : 100;
  return (t.feed * 100) / fp + (t.rapid * 100) / rp + t.dwell;
}
