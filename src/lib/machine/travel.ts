/**
 * Travel limits of the machine Kinetiq is built for (a DIY 3-axis router on FluidNC).
 *
 * The machine homes to the bottom-right corner (seen from above) and sets machine X0 Y0 there. From
 * home it can only move left (X−) and up (Y+). Both ends have limit switches, so these limits are
 * not crash protection: they define the work area. Kinetiq keeps every jog inside the envelope
 * below and refuses to start a job that does not fit in it.
 *
 * Pure and dependency-free: used by the backend (TravelGuard) and by the UI (derive.ts).
 * All values are machine coordinates in millimetres.
 */

/**
 * How far each axis may travel from the home switch (mm).
 *
 * Default only: the physical travel is about 400 (X) and 410 (Y). "Measure X / Y" in the Position
 * widget measures it on the machine and saves it in the config (`kinetiq.travel`), which overrides
 * these values. SAFETY_MARGIN_MM is kept on top.
 */
export const TRAVEL_LIMIT_MM = { x: 200, y: 200 } as const;

/** Travel of the limited axes from the home switch (mm): the defaults above, or measured values saved in the config. */
export interface TravelMm {
  x: number;
  y: number;
}

/** A saved travel outside this range is ignored (mm). */
export const TRAVEL_RANGE_MM = { min: 50, max: 1000 } as const;

/*
 * Measuring the travel ("reverse homing"): after homing, the axis moves slowly to the far end until
 * the limit switch there trips the hard limit (ALARM:1). The machine position in the first status
 * report after the alarm is the travel. Both ends share one switch input, so FluidNC cannot home to
 * the far end itself.
 */
/** Furthest the measuring move goes (mm). The switch is expected well before this. */
export const MEASURE_SEARCH_MM = 600;
/** Feed of the measuring move (mm/min): slow, so the hard-limit stop is short and the reading exact. */
export const MEASURE_FEED_MM_PER_MIN = 200;
/** How far "Back off" moves the axis off the far switch, toward home (mm). */
export const MEASURE_BACKOFF_MM = 5;

export type LimitedAxis = 'x' | 'y';

export interface TravelMeasure {
  axis: LimitedAxis;
  /** moving: on the way to the far switch · tripped: switch hit, waiting for the position · done · failed */
  phase: 'moving' | 'tripped' | 'done' | 'failed';
  /** Measured travel (mm), when done. */
  travelMm?: number;
  /** Why it failed. */
  message?: string;
}

/** Kept free before the far end of each axis (mm). */
export const SAFETY_MARGIN_MM = 2;

/**
 * Kept free before machine 0 on the home side (mm). FluidNC pulls off the switch and then sets the
 * position to `mpos_mm` (0), so machine 0 is already clear of the switch and needs no extra margin.
 */
export const HOME_CLEARANCE_MM = 0;

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
  /** Travel in use (mm) and whether each axis's value was measured (saved) rather than the default. */
  travel: TravelMm;
  measured: Record<LimitedAxis, boolean>;
  /** The travel measurement in progress or just finished; null when there is none. */
  measure: TravelMeasure | null;
  /** Axis that can be backed off its far switch (after a measurement tripped it); null otherwise. */
  backoff: LimitedAxis | null;
  /** Axes whose machine position is known: homed since the controller started, no position-losing alarm since. */
  homed: Homed;
}

function axisRange(travel: number, homeEnd: 'min' | 'max'): AxisRange {
  const far = travel - SAFETY_MARGIN_MM;
  return homeEnd === 'max' ? { min: -far, max: -HOME_CLEARANCE_MM } : { min: HOME_CLEARANCE_MM, max: far };
}

/** The envelope for a travel (default: the constants above). */
export function machineEnvelope(travel: TravelMm = TRAVEL_LIMIT_MM): Envelope {
  return {
    x: axisRange(travel.x, HOME_END.x),
    y: axisRange(travel.y, HOME_END.y),
    z: null,
  };
}

/** True for a usable travel value (mm). */
export function validTravel(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= TRAVEL_RANGE_MM.min && v <= TRAVEL_RANGE_MM.max;
}

/** The measuring move: machine coordinates, toward the far end of the axis. */
export function measureJogLine(axis: LimitedAxis): string {
  const far = HOME_END[axis] === 'max' ? -MEASURE_SEARCH_MM : MEASURE_SEARCH_MM;
  return `$J=G53 G90 G21 ${axis.toUpperCase()}${far} F${MEASURE_FEED_MM_PER_MIN}`;
}

/** The back-off move: relative, toward home, off the far switch. */
export function backoffJogLine(axis: LimitedAxis): string {
  const toward = HOME_END[axis] === 'max' ? MEASURE_BACKOFF_MM : -MEASURE_BACKOFF_MM;
  return `$J=G91 G21 ${axis.toUpperCase()}${toward} F${MEASURE_FEED_MM_PER_MIN}`;
}

/** Distance from home (mm) of a machine position on an axis, rounded down to 0.1 mm. */
export function travelFromPosition(axis: LimitedAxis, machineMm: number): number {
  const d = HOME_END[axis] === 'max' ? -machineMm : machineMm;
  return Math.floor(d * 10 + 1e-6) / 10;
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
  /** Bounds of the moves, work coordinates (mm); null when the program has no moves, NaN on an axis that cannot be checked. */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Bounds of `G53` targets, machine coordinates (mm), per axis; NaN where no G53 move names the axis. */
  machineBounds: { min: [number, number, number]; max: [number, number, number] };
  /** Offsets from the job's start position reached by relative (G91) moves (mm, NaN per axis where none); optional. */
  startBounds?: { min: [number, number, number]; max: [number, number, number] } | null;
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
 * and the active coordinate system. Only limited axes are checked. `startPos` (machine, mm) is where
 * the job will start, for the program's relative moves; without it they are listed as unchecked.
 */
export function checkFit(
  extent: ProgramExtent,
  envelope: Envelope,
  wco: Record<AxisKey, number>,
  activeWcs: string,
  startPos?: Record<AxisKey, number>,
): FitResult {
  const overflows: string[] = [];
  let relativeUnchecked = false;
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
    if (extent.bounds && Number.isFinite(extent.bounds.min[k]) && Number.isFinite(extent.bounds.max[k])) {
      over(a, extent.bounds.min[k] + wco[a], extent.bounds.max[k] + wco[a], '');
    }
    const lo = extent.machineBounds.min[k];
    const hi = extent.machineBounds.max[k];
    if (Number.isFinite(lo) && Number.isFinite(hi)) over(a, lo, hi, ' (G53 move)');
    const sb = extent.startBounds;
    if (sb && envelope[a] && Number.isFinite(sb.min[k]) && Number.isFinite(sb.max[k])) {
      if (startPos && Number.isFinite(startPos[a])) over(a, sb.min[k] + startPos[a], sb.max[k] + startPos[a], ' (relative move from the current position)');
      else relativeUnchecked = true;
    }
  });
  const unchecked = [...extent.unchecked];
  if (relativeUnchecked) unchecked.push('relative moves (G91) from wherever the machine is at the start');
  const otherWcs = extent.wcsUsed.filter((w) => w !== activeWcs);
  if (otherWcs.length) unchecked.push(`the program selects ${otherWcs.join(', ')} (checked against the active ${activeWcs})`);
  return { fits: overflows.length === 0, overflows, unchecked };
}
