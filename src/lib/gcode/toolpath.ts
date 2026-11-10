/**
 * G-code → toolpath segments for the 3D view. Pure and dependency-free (runs in a worker or Node).
 *
 * Output is in WORK coordinates, millimetres. Each segment carries the index of the program line it
 * came from, counted the way the CNCjs Sender counts lines (non-empty lines, 0-based), so
 * `sender.received` can split the path into executed / remaining without remapping.
 *
 * Supported: G0/G1/G2/G3 (IJK incremental per GRBL default G91.1, and R form, incl. negative R),
 * G17/G18/G19 planes with helical arcs, G20/G21, G90/G91, comments ( ) and ;, N/checksum words.
 * Not drawn (position tracking only where it is well defined): G28/G30 (unknown stored positions),
 * G53 (machine coordinates), G92 (offsets) — moves after them still draw from the programmed values.
 *
 * Each segment also carries the programmed feed rate (mm/min) and G4 dwells are listed, so the run
 * time can be estimated from the same geometry (`estimate.ts`).
 */

export interface Toolpath {
  /** xyz pairs: segment i is positions[i*6 .. i*6+5]. */
  positions: Float32Array;
  /** Program line index (CNCjs Sender numbering) of each segment. */
  lines: Uint32Array;
  /** 0 = rapid (G0), 1 = feed (G1/G2/G3) per segment. */
  kinds: Uint8Array;
  /** Programmed feed (mm/min) of each feed segment; 0 for rapids and for feeds with no F yet. */
  feeds: Float32Array;
  /** G4 dwells: program line index and seconds. */
  dwells: { line: number; seconds: number }[];
  segmentCount: number;
  /** Non-empty lines in the program (= Sender total for the same text). */
  lineCount: number;
  /** Bounds of feed moves only (what is actually cut); null if the program has no feed moves. */
  feedBounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Bounds of everything drawn. */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  units: 'mm' | 'in' | 'mixed';
  warnings: string[];
  /**
   * For the travel-limit check (lib/machine/travel.ts): targets of G53 moves (machine coordinates,
   * mm; NaN where no G53 move names the axis), what `bounds` cannot account for in X/Y, and the
   * work coordinate systems the program selects.
   */
  machineBounds: { min: [number, number, number]; max: [number, number, number] };
  /**
   * Like `bounds`, but only from positions the program has set (work coordinates, mm; NaN on an
   * axis it never sets). An axis that has not been programmed yet is drawn at 0 but is really
   * wherever the machine is, e.g. X/Y during `G0 Z5` before the first XY move or after `G53` moves.
   */
  fitBounds: { min: [number, number, number]; max: [number, number, number] } | null;
  unchecked: string[];
  wcsUsed: string[];
}

const ARC_TOLERANCE_MM = 0.01; // max chord deviation
const MAX_ARC_SEGMENTS = 720;

class GrowableF32 {
  data = new Float32Array(1 << 16);
  length = 0;
  push6(a: number, b: number, c: number, d: number, e: number, f: number) {
    if (this.length + 6 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.length;
    this.data[o] = a;
    this.data[o + 1] = b;
    this.data[o + 2] = c;
    this.data[o + 3] = d;
    this.data[o + 4] = e;
    this.data[o + 5] = f;
    this.length += 6;
  }
}

class GrowableU32 {
  data = new Uint32Array(1 << 14);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

class GrowableF32Single {
  data = new Float32Array(1 << 14);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

class GrowableU8 {
  data = new Uint8Array(1 << 14);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Uint8Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

/** Removes ( ) and ; comments; keeps code. */
function stripComments(line: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ';' && depth === 0) break;
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

const WORD = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;

type Plane = 17 | 18 | 19;

export function parseToolpath(gcode: string): Toolpath {
  const positions = new GrowableF32();
  const lineIdx = new GrowableU32();
  const kinds = new GrowableU8();
  const feedRates = new GrowableF32Single();
  const dwells: { line: number; seconds: number }[] = [];
  const warnings: string[] = [];
  let feed = 0; // modal F, mm/min (0 = not set yet)
  let inverseTime = false; // G93: F is 1/minutes per block, not a rate

  // Modal state
  let motion: 0 | 1 | 2 | 3 | null = null;
  let plane: Plane = 17;
  let inches = false;
  let relative = false;
  let arcAbsolute = false; // G90.1
  let sawInch = false;
  let sawMm = false;
  const unsupportedWarned = new Set<string>();

  // Current position (mm). An axis is "unknown" until first set (the machine starts wherever it is,
  // not necessarily at 0); unknown axes read as 0.
  const pos = [0, 0, 0];
  const known = [false, false, false];

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const fmin = [Infinity, Infinity, Infinity];
  const fmax = [-Infinity, -Infinity, -Infinity];
  const kmin = [Infinity, Infinity, Infinity];
  const kmax = [-Infinity, -Infinity, -Infinity];
  const mmin: [number, number, number] = [NaN, NaN, NaN];
  const mmax: [number, number, number] = [NaN, NaN, NaN];
  const unchecked = new Set<string>();
  const wcsUsed = new Set<string>();

  let index = -1; // Sender line index
  const addSegment = (a: number[], b: number[], kind: 0 | 1, line: number) => {
    positions.push6(a[0], a[1], a[2], b[0], b[1], b[2]);
    lineIdx.push(line);
    kinds.push(kind);
    feedRates.push(kind === 1 && !inverseTime ? feed : 0);
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(a[k], b[k]);
      const hi = Math.max(a[k], b[k]);
      if (lo < min[k]) min[k] = lo;
      if (hi > max[k]) max[k] = hi;
      // Unknown axes are not drawn while they move, so an unknown axis here stands still at a made-up 0.
      if (known[k]) {
        if (lo < kmin[k]) kmin[k] = lo;
        if (hi > kmax[k]) kmax[k] = hi;
      }
      if (kind === 1) {
        if (lo < fmin[k]) fmin[k] = lo;
        if (hi > fmax[k]) fmax[k] = hi;
      }
    }
  };

  const rawLines = gcode.split('\n');
  for (let r = 0; r < rawLines.length; r++) {
    const raw = rawLines[r];
    if (raw.trim().length === 0) continue;
    index++;
    const code = stripComments(raw).trim();
    if (!code || code[0] === '%' || code[0] === '$') continue;

    const words: Record<string, number> = {};
    const gWords: number[] = [];
    WORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD.exec(code))) {
      const letter = m[1].toUpperCase();
      const value = Number(m[2]);
      if (letter === 'G') gWords.push(value);
      else words[letter] = value;
    }

    let nonModalMove = false; // a G-word that consumes axis words (G10, G28, G30, G53, G92, G4)
    let nonModalWord = '';
    let skipDraw = false;
    for (const g of gWords) {
      const gi = Math.round(g * 10);
      switch (gi) {
        case 0: motion = 0; break;
        case 10: motion = 1; break;
        case 20: motion = 2; break;
        case 30: motion = 3; break;
        case 170: plane = 17; break;
        case 180: plane = 18; break;
        case 190: plane = 19; break;
        case 200: inches = true; sawInch = true; break;
        case 210: inches = false; sawMm = true; break;
        case 900: relative = false; break;
        case 910: relative = true; break;
        case 901: arcAbsolute = true; break;
        case 911: arcAbsolute = false; break;
        case 40: // G4 dwell: P is time in seconds (GRBL), no axis words consumed for motion
          if (words.P > 0) dwells.push({ line: index, seconds: words.P });
          break;
        case 930:
          inverseTime = true;
          if (!unsupportedWarned.has('G93')) {
            unsupportedWarned.add('G93');
            warnings.push('G93 (inverse time) feeds are not used for the time estimate');
          }
          break;
        case 940:
          inverseTime = false;
          break;
        case 100: case 280: case 300: case 920:
          nonModalMove = true;
          nonModalWord = `G${g}`;
          break;
        case 540: case 550: case 560: case 570: case 580: case 590:
          wcsUsed.add(`G${g}`);
          break;
        case 530:
          skipDraw = true; // machine coordinates: work position unknown without WCO
          break;
        case 800:
          motion = null;
          break;
        default: {
          const key = `G${g}`;
          if (gi >= 380 && gi <= 385 && !unsupportedWarned.has(key)) {
            unsupportedWarned.add(key);
            warnings.push(`${key} (probe) moves are not drawn`);
          }
        }
      }
    }

    // F applies to this block's motion, in the units in force after this line's G20/G21.
    if ('F' in words && words.F > 0) feed = words.F * (inches ? 25.4 : 1);

    const hasAxis = 'X' in words || 'Y' in words || 'Z' in words;
    const hasArcWords = 'I' in words || 'J' in words || 'K' in words || 'R' in words;
    if (nonModalMove) {
      // G28/G30 go to stored positions; G92/G10 change offsets: the work position is no longer known.
      known[0] = known[1] = known[2] = false;
      // For the travel-limit check: only X/Y matter (Z is not limited). G28/G30 with no axis
      // words move every axis.
      const stored = nonModalWord === 'G28' || nonModalWord === 'G30';
      if ('X' in words || 'Y' in words || (stored && !hasAxis)) {
        unchecked.add(stored ? `${nonModalWord} moves to a stored position` : `${nonModalWord} changes the work offset`);
      }
      continue;
    }
    if (motion === null || (!hasAxis && !(motion >= 2 && hasArcWords))) continue;

    const axes = ['X', 'Y', 'Z'];
    if (skipDraw) {
      const machineScale = inches ? 25.4 : 1;
      for (let k = 0; k < 3; k++) {
        if (!(axes[k] in words)) continue;
        known[k] = false;
        const t = words[axes[k]] * machineScale;
        mmin[k] = Number.isNaN(mmin[k]) ? t : Math.min(mmin[k], t);
        mmax[k] = Number.isNaN(mmax[k]) ? t : Math.max(mmax[k], t);
      }
      continue;
    }
    // Relative moves from an unknown position are drawn relative to the program start (0).
    if (relative) {
      for (let k = 0; k < 3; k++) {
        if (known[k]) continue;
        if (k < 2 && axes[k] in words) unchecked.add('relative moves (G91) from wherever the machine is at the start');
        pos[k] = 0;
        known[k] = true;
      }
    }

    const scale = inches ? 25.4 : 1;
    const start = [pos[0], pos[1], pos[2]];
    const target = [pos[0], pos[1], pos[2]];
    for (let k = 0; k < 3; k++) {
      const v = words[axes[k]];
      if (v !== undefined) target[k] = relative ? pos[k] + v * scale : v * scale;
    }
    // Skip a segment only when an axis that moves starts from an unknown position (the first
    // positioning move per axis). An axis that never moves (e.g. Z in a 2D laser job) is drawn at 0.
    const drawable =
      (known[0] || target[0] === start[0]) && (known[1] || target[1] === start[1]) && (known[2] || target[2] === start[2]);

    if (motion <= 1) {
      if (drawable) addSegment(start, target, motion === 0 ? 0 : 1, index);
    } else if (drawable) {
      // Arc in the active plane: (u, v) are the plane axes, w the linear (helical) axis.
      const [u, v, w] = plane === 17 ? [0, 1, 2] : plane === 18 ? [2, 0, 1] : [1, 2, 0];
      const offsetWord = ['I', 'J', 'K'];
      const su = start[u], sv = start[v];
      const eu = target[u], ev = target[v];
      const clockwise = motion === 2;
      let cu: number, cv: number;

      if ('R' in words) {
        let radius = words.R * scale;
        const dx = eu - su, dy = ev - sv;
        const d2 = dx * dx + dy * dy;
        if (d2 === 0) {
          warnings.push(`Line ${index + 1}: R-form arc with identical start and end skipped`);
          for (let k = 0; k < 3; k++) { pos[k] = target[k]; if (axes[k] in words) known[k] = true; }
          continue;
        }
        let h2 = radius * radius - d2 / 4;
        if (h2 < 0) h2 = 0; // numerical slack: treat as a half circle
        let h = Math.sqrt(h2) / Math.sqrt(d2);
        // GRBL: CW with positive R → centre to the right of travel; negative R selects the long arc.
        if (clockwise) h = -h;
        if (radius < 0) { h = -h; radius = -radius; }
        cu = su + dx / 2 - h * dy;
        cv = sv + dy / 2 + h * dx;
      } else {
        const ou = (words[offsetWord[u]] ?? 0) * scale;
        const ov = (words[offsetWord[v]] ?? 0) * scale;
        cu = arcAbsolute ? ou : su + ou;
        cv = arcAbsolute ? ov : sv + ov;
      }

      const radius = Math.hypot(su - cu, sv - cv);
      const a0 = Math.atan2(sv - cv, su - cu);
      const a1 = Math.atan2(ev - cv, eu - cu);
      let sweep = a1 - a0;
      if (clockwise) { if (sweep >= -1e-9) sweep -= Math.PI * 2; }
      else if (sweep <= 1e-9) sweep += Math.PI * 2;
      // G18 uses (u, v) = (Z, X) like GRBL, so CW/CCW keep their GRBL meaning in every plane.

      const maxStep = radius > ARC_TOLERANCE_MM ? 2 * Math.acos(1 - ARC_TOLERANCE_MM / radius) : Math.PI / 4;
      const steps = Math.min(MAX_ARC_SEGMENTS, Math.max(4, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-3))));
      const sw = start[w], ew = target[w];
      let prev = start;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const a = a0 + sweep * t;
        const p = [0, 0, 0];
        if (s === steps) {
          p[0] = target[0]; p[1] = target[1]; p[2] = target[2];
        } else {
          p[u] = cu + radius * Math.cos(a);
          p[v] = cv + radius * Math.sin(a);
          p[w] = sw + (ew - sw) * t;
        }
        addSegment(prev, p, 1, index);
        prev = p;
      }
    }

    for (let k = 0; k < 3; k++) {
      if (axes[k] in words) known[k] = true;
      pos[k] = target[k];
    }
  }

  const segmentCount = kinds.length;
  const box = (lo: number[], hi: number[]) =>
    Number.isFinite(lo[0])
      ? { min: [lo[0], lo[1], lo[2]] as [number, number, number], max: [hi[0], hi[1], hi[2]] as [number, number, number] }
      : null;

  return {
    positions: positions.data.slice(0, positions.length),
    lines: lineIdx.data.slice(0, segmentCount),
    kinds: kinds.data.slice(0, segmentCount),
    feeds: feedRates.data.slice(0, segmentCount),
    dwells,
    segmentCount,
    lineCount: index + 1,
    feedBounds: box(fmin, fmax),
    bounds: box(min, max),
    units: sawInch && sawMm ? 'mixed' : sawInch ? 'in' : 'mm',
    warnings,
    machineBounds: { min: mmin, max: mmax },
    fitBounds: segmentCount
      ? {
          min: kmin.map((v) => (Number.isFinite(v) ? v : NaN)) as [number, number, number],
          max: kmax.map((v) => (Number.isFinite(v) ? v : NaN)) as [number, number, number],
        }
      : null,
    unchecked: [...unchecked],
    wcsUsed: [...wcsUsed],
  };
}

/**
 * The last parsed toolpath, keyed by the exact G-code string. The visualisation and the time
 * estimate both need the toolpath of the loaded program; this keeps it to one parse per load.
 */
let cached: { gcode: string; toolpath: Toolpath } | null = null;
export function toolpathFor(gcode: string): Toolpath {
  if (cached?.gcode !== gcode) cached = { gcode, toolpath: parseToolpath(gcode) };
  return cached.toolpath;
}
