/**
 * Travel limits of the machine Kinetiq is built for (a DIY 3-axis router on FluidNC).
 *
 * The machine homes to the bottom-right corner (seen from above) and sets machine X0 Y0 there. From
 * home it can only move left (X−) and up (Y+), and there is no switch at the far ends: running into
 * them crashes the axis. Kinetiq therefore keeps every jog inside the envelope below and refuses to
 * start a job that does not fit in it.
 *
 * Pure and dependency-free: used by the backend (TravelGuard) and by the UI (derive.ts).
 * All values are machine coordinates in millimetres.
 */

/**
 * How far each axis may travel from the home switch (mm).
 *
 * PROVISIONAL: the physical travel is about 400 (X) and 410 (Y), not measured exactly yet. Until
 * it is, both axes are held to 200. Put the measured travel here; SAFETY_MARGIN_MM is kept on top.
 */
export const TRAVEL_LIMIT_MM = { x: 200, y: 200 } as const;

/** Kept free before the far end of each axis (mm), where nothing stops the machine. */
export const SAFETY_MARGIN_MM = 2;

/**
 * Kept free before the home switch (mm). Equal to the FluidNC `pulloff_mm` of X and Y: homing
 * leaves the machine exactly here, and moving closer would trip the switch (hard-limit alarm).
 */
export const HOME_CLEARANCE_MM = 1;

/** Which end of the axis the home switch is on: 'max' = travel runs negative from machine 0. */
export const HOME_END = { x: 'max', y: 'min' } as const;

/** Positions this close to a limit count as on it (mm): report rounding. */
export const LIMIT_EPSILON_MM = 0.005;

export type AxisKey = 'x' | 'y' | 'z';
export const AXIS_KEYS: readonly AxisKey[] = ['x', 'y', 'z'];

export interface AxisRange {
  min: number;
  max: number;
}

/** Allowed machine position per axis; null = not limited by Kinetiq (Z has no switch and no homing). */
export type Envelope = Record<AxisKey, AxisRange | null>;

export type Homed = Record<AxisKey, boolean>;

/** What the backend tells the UI (`machine:limits`). `envelope` null = travel limits are off. */
export interface MachineLimits {
  envelope: Envelope | null;
  /** Axes whose machine position is known: homed since the controller started, no position-losing alarm since. */
  homed: Homed;
}

function axisRange(travel: number, homeEnd: 'min' | 'max'): AxisRange {
  const far = travel - SAFETY_MARGIN_MM;
  return homeEnd === 'max' ? { min: -far, max: -HOME_CLEARANCE_MM } : { min: HOME_CLEARANCE_MM, max: far };
}

/** The envelope from the constants above. */
export function machineEnvelope(): Envelope {
  return {
    x: axisRange(TRAVEL_LIMIT_MM.x, HOME_END.x),
    y: axisRange(TRAVEL_LIMIT_MM.y, HOME_END.y),
    z: null,
  };
}

/** Axes homed by a homing line: `$H` homes every limited axis, `$HX` / `$HXY` the named ones. null = not a homing line. */
export function homingAxes(line: string, envelope: Envelope): AxisKey[] | null {
  const m = /^\$H([XYZABC]*)$/i.exec(line.trim());
  if (!m) return null;
  const named = m[1].toLowerCase();
  return AXIS_KEYS.filter((a) => (named ? named.includes(a) : envelope[a] !== null));
}

/* ------------------------------------------------------------------------------------------------
 * Jog limiting
 * ---------------------------------------------------------------------------------------------- */

const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)';

export interface JogContext {
  envelope: Envelope;
  homed: Homed;
  /** Machine position the jog starts from (mm): where the queued jogs end, else the reported position. */
  from: Record<AxisKey, number>;
  /** Machine − work offset (mm), for absolute jogs in work coordinates. */
  wco: Record<AxisKey, number>;
  /** Modal units and distance mode, used when the jog line does not say. */
  modalInches: boolean;
  modalRelative: boolean;
}

export type JogDecision =
  /** Send the line as it is. `target` is where the machine ends up (mm, machine). */
  | { action: 'pass'; target: Record<AxisKey, number> }
  /** Send `line` instead: the same jog, shortened to the envelope. */
  | { action: 'shorten'; line: string; target: Record<AxisKey, number>; message: string }
  | { action: 'block'; message: string };

const fmt = (v: number) => Number(v.toFixed(3)).toString();

/**
 * Checks a `$J=` line against the envelope. Returns null when the line is not a jog.
 * A jog that would leave the envelope is shortened to end on its edge (per axis); one that cannot
 * move at all, or that moves a limited axis that is not homed, is blocked. An axis that is already
 * outside may move back in, never further out.
 */
export function limitJog(line: string, ctx: JogContext): JogDecision | null {
  const m = /^\$J\s*=(.*)$/i.exec(line.trim());
  if (!m) return null;
  const body = m[1].toUpperCase().replace(/\s+/g, '');

  const gWords = Array.from(body.matchAll(new RegExp(`G(${NUM})`, 'g')), (g) => Number(g[1]));
  const machine = gWords.includes(53);
  const relative = gWords.includes(91) ? true : gWords.includes(90) ? false : ctx.modalRelative;
  const inches = gWords.includes(20) ? true : gWords.includes(21) ? false : ctx.modalInches;
  const scale = inches ? 25.4 : 1;
  const word = (letter: string): number | null => {
    const w = new RegExp(`${letter}(${NUM})`).exec(body);
    return w ? Number(w[1]) : null;
  };

  const target = { ...ctx.from };
  const wanted = { ...ctx.from };
  const moved: AxisKey[] = [];
  const shortened: AxisKey[] = [];
  for (const a of AXIS_KEYS) {
    const v = word(a.toUpperCase());
    if (v === null) continue;
    moved.push(a);
    const range = ctx.envelope[a];
    const from = ctx.from[a];
    if (range && !ctx.homed[a]) {
      return { action: 'block', message: `${a.toUpperCase()} is not homed: home the machine before moving ${a.toUpperCase()}` };
    }
    if (!Number.isFinite(from) || (!relative && !machine && !Number.isFinite(ctx.wco[a]))) {
      if (!range) continue; // unlimited axis: nothing to check, the firmware takes the line as it is
      return { action: 'block', message: `${a.toUpperCase()} position is not known yet` };
    }
    const to = relative ? from + v * scale : machine ? v * scale : v * scale + ctx.wco[a];
    wanted[a] = to;
    target[a] = to;
    if (!range) continue;
    const allowed = Math.min(Math.max(to, Math.min(range.min, from)), Math.max(range.max, from));
    if (Math.abs(allowed - to) > LIMIT_EPSILON_MM) {
      target[a] = allowed;
      shortened.push(a);
    }
  }

  if (shortened.length === 0) return { action: 'pass', target };

  const names = shortened.map((a) => a.toUpperCase()).join(' and ');
  const travel = Math.max(...moved.map((a) => Math.abs(target[a] - ctx.from[a])));
  if (!(travel > LIMIT_EPSILON_MM)) {
    return { action: 'block', message: `${names} is at the travel limit` };
  }
  const feed = word('F');
  const words = moved.filter((a) => Number.isFinite(target[a])).map((a) => `${a.toUpperCase()}${fmt(target[a])}`);
  const feedWord = feed !== null ? ` F${fmt(feed * scale)}` : '';
  const cut = shortened.map((a) => `${a.toUpperCase()} by ${fmt(Math.abs(wanted[a] - target[a]))} mm`).join(', ');
  return {
    action: 'shorten',
    line: `$J=G53 G90 G21 ${words.join(' ')}${feedWord}`,
    target,
    message: `Jog shortened to the travel limit (${cut})`,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Does a program fit?
 * ---------------------------------------------------------------------------------------------- */

export interface ProgramExtent {
  /** Bounds of every drawn move, work coordinates (mm); null when the program has no moves. */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Bounds of `G53` targets, machine coordinates (mm), per axis; NaN where no G53 move names the axis. */
  machineBounds: { min: [number, number, number]; max: [number, number, number] };
  /** Things in the program the bounds cannot account for (e.g. "G92 changes the work offset"). */
  unchecked: string[];
  /** Work coordinate systems the program selects (`G54`…`G59`). */
  wcsUsed: string[];
}

export interface FitResult {
  /** False when some move ends outside the envelope. */
  fits: boolean;
  /** One entry per side that is exceeded, e.g. "X− by 12.5 mm". */
  overflows: string[];
  /** Not checked: the program may still leave the envelope there. */
  unchecked: string[];
}

/**
 * Compares a program's extent with the envelope, given the current work offset (machine − work, mm)
 * and the active coordinate system. Only limited axes are checked.
 */
export function checkFit(extent: ProgramExtent, envelope: Envelope, wco: Record<AxisKey, number>, activeWcs: string): FitResult {
  const overflows: string[] = [];
  const over = (a: AxisKey, lo: number, hi: number, what: string) => {
    const range = envelope[a];
    if (!range) return;
    const name = a.toUpperCase();
    // Toolpath positions are float32: allow for their rounding on top of the report rounding.
    const eps = LIMIT_EPSILON_MM * 2;
    if (lo < range.min - eps) overflows.push(`${name}− by ${fmt(range.min - lo)} mm${what}`);
    if (hi > range.max + eps) overflows.push(`${name}+ by ${fmt(hi - range.max)} mm${what}`);
  };
  AXIS_KEYS.forEach((a, k) => {
    if (extent.bounds) over(a, extent.bounds.min[k] + wco[a], extent.bounds.max[k] + wco[a], '');
    const lo = extent.machineBounds.min[k];
    const hi = extent.machineBounds.max[k];
    if (Number.isFinite(lo) && Number.isFinite(hi)) over(a, lo, hi, ' (G53 move)');
  });
  const unchecked = [...extent.unchecked];
  const otherWcs = extent.wcsUsed.filter((w) => w !== activeWcs);
  if (otherWcs.length) unchecked.push(`the program selects ${otherWcs.join(', ')} (checked against the active ${activeWcs})`);
  return { fits: overflows.length === 0, overflows, unchecked };
}
