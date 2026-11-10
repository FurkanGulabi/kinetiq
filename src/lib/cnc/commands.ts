/**
 * Command builders. Pure string construction — sending and gating live elsewhere.
 */

export type JogAxis = 'X' | 'Y' | 'Z';
export type Units = 'mm' | 'in';

export const JOG_STEPS: Record<Units, number[]> = {
  mm: [0.01, 0.1, 1, 10, 100],
  in: [0.001, 0.01, 0.1, 1, 4],
};

export const JOG_FEEDS: Record<Units, number[]> = {
  mm: [100, 500, 1000, 3000],
  in: [4, 20, 40, 120],
};

export const MAX_JOG_FEED: Record<Units, number> = { mm: 10000, in: 400 };

/**
 * GRBL v1.1 jog line, e.g. `$J=G91 G21 X10 F1000`.
 * G91 (relative) and G21/G20 apply to this jog only — the modal state is not changed,
 * the firmware rejects it in Alarm or beyond soft limits, and it can be cancelled with 0x85.
 */
export function jogLine(axis: JogAxis, direction: 1 | -1, step: number, feed: number, units: Units): string {
  const distance = trimNumber(direction * step);
  const unitWord = units === 'in' ? 'G20' : 'G21';
  return `$J=G91 ${unitWord} ${axis}${distance} F${trimNumber(feed)}`;
}

/** Diagonal jog: X and Y by `step` each in one move, e.g. `$J=G91 G21 X-10 Y10 F1000` (feed along the diagonal). */
export function jogLineXY(xDirection: 1 | -1, yDirection: 1 | -1, step: number, feed: number, units: Units): string {
  const unitWord = units === 'in' ? 'G20' : 'G21';
  return `$J=G91 ${unitWord} X${trimNumber(xDirection * step)} Y${trimNumber(yDirection * step)} F${trimNumber(feed)}`;
}

function trimNumber(value: number): string {
  // Up to 4 decimals, no trailing zeros, no exponent notation.
  return Number(value.toFixed(4)).toString();
}

export function isValidFeed(value: number, units: Units): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_JOG_FEED[units];
}

export const WCS_P: Record<string, number> = { G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6 };

/**
 * Set the current position as work zero for one axis in the active WCS
 * (same approach as the CNCjs Axes widget: `G10 L20 P<n> <axis>0`). Persisted by the firmware.
 */
export function zeroAxisLine(axis: JogAxis, wcs: string): string {
  return `G10 L20 P${WCS_P[wcs] ?? 1} ${axis}0`;
}

/**
 * Move one axis to an absolute work-coordinate target as a GRBL jog:
 * `$J=G90 G21 X11 F1000`. Feed-limited, soft-limit checked, cancellable with 0x85, modal state untouched.
 */
export function moveAxisLine(axis: JogAxis, target: number, feed: number, units: Units): string {
  const unitWord = units === 'in' ? 'G20' : 'G21';
  return `$J=G90 ${unitWord} ${axis}${trimNumber(target)} F${trimNumber(feed)}`;
}

/** FluidNC single-axis homing (`$HX`, `$HY`, `$HZ`). */
export function homeAxisLine(axis: JogAxis): string {
  return `$H${axis}`;
}

/** Parses a typed coordinate ("11", "-22.5", "11,5"); null when not a finite number. */
export function parseCoordinate(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * "Go to zero": jog to work X0 Y0, and Z0 when `includeZ`. Returned as separate `$J=G90` lines that the
 * Feeder sends in order (each queues behind the previous one in the planner):
 *  - Z excluded → one XY move; Z does not move.
 *  - Z included and the tool is below work Z0 → raise Z to 0 first, then XY (never drag through stock).
 *  - Z included and the tool is at/above Z0 → XY first, then lower Z to 0.
 */
export function goToZeroLines(includeZ: boolean, currentZ: number | null, feed: number, units: Units): string[] {
  const unitWord = units === 'in' ? 'G20' : 'G21';
  const f = `F${trimNumber(feed)}`;
  const xy = `$J=G90 ${unitWord} X0 Y0 ${f}`;
  if (!includeZ) return [xy];
  const z = `$J=G90 ${unitWord} Z0 ${f}`;
  return currentZ !== null && currentZ < 0 ? [z, xy] : [xy, z];
}
