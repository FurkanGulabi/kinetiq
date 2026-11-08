/**
 * Height map: stock-surface heights measured on a rectangular grid, in WORK coordinates (mm).
 *
 * z[j][i] is the surface height at (xs[i], ys[j]) relative to work Z0 at probing time. The work
 * offset (WCO) and WCS are recorded too: the map only lines up with the stock while work X/Y/Z stay
 * where they were when it was probed (checked before a leveled job starts).
 *
 * Pure (no React, no socket): used by the probing run, the compensation and the UI.
 */

export interface GridPlan {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Number of probe points along X and Y (≥ 2 each). */
  nx: number;
  ny: number;
}

export interface HeightMap {
  version: 1;
  id: string;
  createdAt: number;
  wcs: string;
  /** Work coordinate offset (machine − work) at probing time, mm. */
  wco: { x: number; y: number; z: number };
  xs: number[];
  ys: number[];
  /** z[j][i] at (xs[i], ys[j]); null for a point not probed (only while probing). */
  z: (number | null)[][];
  probe: { clearance: number; depth: number; feed: number };
}

export const GRID_LIMITS = { minPoints: 2, maxPoints: 20, maxTotal: 200, minSpacing: 2 };

export function gridAxis(min: number, max: number, n: number): number[] {
  if (n < 2) return [min];
  const step = (max - min) / (n - 1);
  return Array.from({ length: n }, (_, i) => round3(i === n - 1 ? max : min + step * i));
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** First problem with a grid plan, or null. */
export function gridPlanError(p: GridPlan): string | null {
  const values = [p.xMin, p.xMax, p.yMin, p.yMax, p.nx, p.ny];
  if (!values.every(Number.isFinite)) return 'Enter the probe area and the number of points';
  if (p.xMax - p.xMin < 1 || p.yMax - p.yMin < 1) return 'The probe area must be at least 1 mm in X and Y (max greater than min)';
  if (!Number.isInteger(p.nx) || !Number.isInteger(p.ny) || p.nx < GRID_LIMITS.minPoints || p.ny < GRID_LIMITS.minPoints) {
    return `Use at least ${GRID_LIMITS.minPoints} points along X and Y`;
  }
  if (p.nx > GRID_LIMITS.maxPoints || p.ny > GRID_LIMITS.maxPoints) return `Use at most ${GRID_LIMITS.maxPoints} points along X and Y`;
  if (p.nx * p.ny > GRID_LIMITS.maxTotal) return `At most ${GRID_LIMITS.maxTotal} points in total`;
  if ((p.xMax - p.xMin) / (p.nx - 1) < GRID_LIMITS.minSpacing || (p.yMax - p.yMin) / (p.ny - 1) < GRID_LIMITS.minSpacing) {
    return `Points must be at least ${GRID_LIMITS.minSpacing} mm apart`;
  }
  return null;
}

/** Probe order: row by row, alternating direction (snake), so the machine never crosses the stock twice. */
export function probeOrder(nx: number, ny: number): { i: number; j: number }[] {
  const order: { i: number; j: number }[] = [];
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nx; k++) order.push({ i: j % 2 === 0 ? k : nx - 1 - k, j });
  }
  return order;
}

export function emptyMap(plan: GridPlan, wcs: string, wco: HeightMap['wco'], probe: HeightMap['probe']): HeightMap {
  const xs = gridAxis(plan.xMin, plan.xMax, plan.nx);
  const ys = gridAxis(plan.yMin, plan.yMax, plan.ny);
  return {
    version: 1,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    wcs,
    wco,
    xs,
    ys,
    z: ys.map(() => xs.map(() => null)),
    probe,
  };
}

export function isComplete(map: HeightMap): boolean {
  return map.z.every((row) => row.every((v) => v !== null && Number.isFinite(v)));
}

export interface MapStats {
  min: number;
  max: number;
  range: number;
  /** Largest height difference between neighbouring points. */
  maxStep: number;
  probed: number;
  total: number;
}

export function mapStats(map: HeightMap): MapStats | null {
  let min = Infinity;
  let max = -Infinity;
  let probed = 0;
  let maxStep = 0;
  map.z.forEach((row, j) =>
    row.forEach((v, i) => {
      if (v === null) return;
      probed++;
      min = Math.min(min, v);
      max = Math.max(max, v);
      const right = row[i + 1];
      const down = map.z[j + 1]?.[i];
      if (right !== null && right !== undefined) maxStep = Math.max(maxStep, Math.abs(right - v));
      if (down !== null && down !== undefined) maxStep = Math.max(maxStep, Math.abs(down - v));
    }),
  );
  if (probed === 0) return null;
  return { min, max, range: max - min, maxStep, probed, total: map.xs.length * map.ys.length };
}

/** Index of the grid cell containing v (clamped to the edge cells). */
function cellIndex(values: number[], v: number): number {
  let i = 0;
  while (i < values.length - 2 && values[i + 1] <= v) i++;
  return i;
}

/** True when (x, y) lies inside the probed rectangle, with `tolerance` mm of slack. */
export function insideMap(map: HeightMap, x: number, y: number, tolerance = 0): boolean {
  return (
    x >= map.xs[0] - tolerance &&
    x <= map.xs[map.xs.length - 1] + tolerance &&
    y >= map.ys[0] - tolerance &&
    y <= map.ys[map.ys.length - 1] + tolerance
  );
}

/**
 * Bilinear surface height at (x, y). Points outside the grid are clamped to its edge (callers decide
 * whether that is acceptable). Requires a complete map.
 */
export function surfaceZ(map: HeightMap, x: number, y: number): number {
  const { xs, ys } = map;
  const cx = Math.min(Math.max(x, xs[0]), xs[xs.length - 1]);
  const cy = Math.min(Math.max(y, ys[0]), ys[ys.length - 1]);
  const i = cellIndex(xs, cx);
  const j = cellIndex(ys, cy);
  const z = map.z as number[][];
  const a = (cx - xs[i]) / (xs[i + 1] - xs[i]);
  const b = (cy - ys[j]) / (ys[j + 1] - ys[j]);
  return z[j][i] * (1 - a) * (1 - b) + z[j][i + 1] * a * (1 - b) + z[j + 1][i] * (1 - a) * b + z[j + 1][i + 1] * a * b;
}

/** Smallest grid spacing (mm): compensation splits moves well below this. */
export function minCell(map: HeightMap): number {
  const gaps = [...map.xs.slice(1).map((x, i) => x - map.xs[i]), ...map.ys.slice(1).map((y, j) => y - map.ys[j])];
  return Math.min(...gaps);
}

/* ------------------------------------------------------------------------------------------------
 * Persistence
 * ---------------------------------------------------------------------------------------------- */

const KEY = 'kinetiq.heightmap';

/** Checks a value is a usable, complete height map (stored, or imported from a file). */
export function validateHeightMap(value: unknown): HeightMap | null {
  const m = value as HeightMap;
  if (!m || m.version !== 1 || !Array.isArray(m.xs) || !Array.isArray(m.ys) || !Array.isArray(m.z)) return null;
  if (m.xs.length < 2 || m.ys.length < 2 || m.z.length !== m.ys.length) return null;
  if (!m.xs.every(Number.isFinite) || !m.ys.every(Number.isFinite)) return null;
  for (let k = 1; k < m.xs.length; k++) if (!(m.xs[k] > m.xs[k - 1])) return null;
  for (let k = 1; k < m.ys.length; k++) if (!(m.ys[k] > m.ys[k - 1])) return null;
  if (!m.z.every((row) => Array.isArray(row) && row.length === m.xs.length && row.every((v) => typeof v === 'number' && Number.isFinite(v)))) return null;
  if (!m.wco || ![m.wco.x, m.wco.y, m.wco.z].every(Number.isFinite) || typeof m.wcs !== 'string') return null;
  return m;
}

export function loadStoredMap(): HeightMap | null {
  try {
    return validateHeightMap(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch {
    return null;
  }
}

export function storeMap(map: HeightMap | null): void {
  try {
    if (map) localStorage.setItem(KEY, JSON.stringify(map));
    else localStorage.removeItem(KEY);
  } catch {
    // optional
  }
}

/** How far the current work offset is from the one the map was probed with (mm), per axis. */
export function offsetDrift(map: HeightMap, wco: { x: number; y: number; z: number }, wcs: string): { ok: boolean; message: string | null } {
  if (wcs !== map.wcs) return { ok: false, message: `The active coordinate system is ${wcs}, but the height map was probed in ${map.wcs}.` };
  const moved = (['x', 'y', 'z'] as const).filter((a) => Math.abs(wco[a] - map.wco[a]) > 0.005);
  if (moved.length === 0) return { ok: true, message: null };
  return {
    ok: false,
    message: `Work ${moved.map((a) => a.toUpperCase()).join('/')} zero changed since the height map was probed, so the map no longer lines up with the stock. Probe the map again.`,
  };
}
