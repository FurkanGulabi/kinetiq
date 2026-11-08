/**
 * Height-map compensation: bends a G-code program's Z to follow the probed stock surface.
 *
 * Every point a cutting move passes through gets Z += surface(x, y). Straight feed moves are split
 * into short segments (a quarter grid cell, 0.5–5 mm) and arcs are first turned into lines, because
 * the surface is only followed at the points that are written out. Rapids get their end point
 * corrected only.
 *
 * It refuses — returns errors and no program — rather than produce something wrong:
 *   - a cutting move before the program has set X, Y and Z (the start point would be a guess).
 *     A feed move from an unknown start that ends ABOVE the highest probed point (+0.2 mm) cuts
 *     nothing, so it is treated like a positioning move (typical first line: `G1 Z5 F2540`).
 *   - a program that never sets Z (2D laser/pen jobs): leveling needs an absolute Z
 *   - relative moves (G91), inverse-time feed (G93)
 *   - G10 / G92 / G43.1 (offset changes inside the program), a different WCS than the map's
 *   - probing (G38.x) and canned cycles (G73, G76, G81–G89)
 *   - a cutting move outside the probed area (no extrapolation)
 * Machine-coordinate moves (G53) and G28/G30 are kept unchanged and make the position unknown again.
 *
 * Pure (no React, no socket). Units: the map is mm; programs in G20 are converted and written in inches.
 */
import { insideMap, minCell, surfaceZ, type HeightMap } from './heightmap';

export interface CompensationStats {
  inputLines: number;
  outputLines: number;
  /** Moves whose Z was corrected (after splitting). */
  correctedPoints: number;
  arcsConverted: number;
  /** Smallest and largest Z correction applied, mm. */
  minCorrection: number;
  maxCorrection: number;
  /** Segment length used to split feed moves, mm. */
  segmentLength: number;
}

export interface CompensationResult {
  ok: boolean;
  gcode: string;
  errors: string[];
  warnings: string[];
  stats: CompensationStats;
}

const ARC_TOLERANCE_MM = 0.01;
const MAX_ARC_SEGMENTS = 2000;
const MAX_ERRORS = 8;
const INSIDE_TOLERANCE_MM = 0.01;

const WORD = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;

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

type Plane = 17 | 18 | 19;

export function compensate(gcode: string, map: HeightMap): CompensationResult {
  const errors: string[] = [];
  const warnings = new Set<string>();
  const out: string[] = [];
  const segmentLength = Math.min(5, Math.max(0.5, minCell(map) / 4));
  // Above this work Z the tool cannot touch the stock anywhere on the map.
  const safeZ = Math.max(...map.z.flat().map((v) => v ?? -Infinity)) + 0.2;
  const stats: CompensationStats = {
    inputLines: 0,
    outputLines: 0,
    correctedPoints: 0,
    arcsConverted: 0,
    minCorrection: Infinity,
    maxCorrection: -Infinity,
    segmentLength,
  };
  const fail = (line: number, message: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`Line ${line}: ${message}`);
  };

  // Modal state
  let motion: 0 | 1 | 2 | 3 | null = null;
  let plane: Plane = 17;
  let inches = false;
  let relative = false;
  let arcAbsolute = false;
  let wcs = 'G54';
  const pos = [0, 0, 0]; // mm, work coordinates
  const known = [false, false, false];
  /** Why the position became unknown after being known (G53, G28/G30, $H), for a clear message. */
  let lostBy: string | null = null;

  const fmt = (mm: number) => {
    const v = inches ? mm / 25.4 : mm;
    return Number(v.toFixed(inches ? 4 : 3)).toString();
  };
  const correct = (x: number, y: number) => {
    const dz = surfaceZ(map, x, y);
    stats.correctedPoints++;
    if (dz < stats.minCorrection) stats.minCorrection = dz;
    if (dz > stats.maxCorrection) stats.maxCorrection = dz;
    return dz;
  };

  const rawLines = gcode.split('\n');
  out.push(
    `(Leveled by Kinetiq: height map ${map.id}, ${map.xs.length}x${map.ys.length} points,` +
      ` X${map.xs[0]}..${map.xs[map.xs.length - 1]} Y${map.ys[0]}..${map.ys[map.ys.length - 1]} mm)`,
    '(Do not change work X, Y or Z zero before running this program)',
  );

  for (let r = 0; r < rawLines.length; r++) {
    const raw = rawLines[r].replace(/\r$/, '');
    const lineNo = r + 1;
    if (raw.trim() === '') {
      out.push(raw);
      continue;
    }
    stats.inputLines++;
    const code = stripComments(raw).trim();
    if (!code || code[0] === '%') {
      out.push(raw);
      continue;
    }
    if (code[0] === '$') {
      if (/^\$H/i.test(code)) {
        known.fill(false); // homing moves the machine
        lostBy = 'homing ($H)';
      }
      out.push(raw);
      continue;
    }

    // Words in order; G words separately.
    const tokens: { letter: string; text: string; value: number }[] = [];
    WORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD.exec(code))) tokens.push({ letter: m[1].toUpperCase(), text: `${m[1].toUpperCase()}${m[2]}`, value: Number(m[2]) });
    const words: Record<string, number> = {};
    for (const t of tokens) if (t.letter !== 'G') words[t.letter] = t.value;

    let machineCoords = false;
    let storedPosition = false;
    let blocked = false;
    for (const t of tokens) {
      if (t.letter === 'M' && Math.round(t.value) === 6) {
        warnings.add('The program has a tool change (M6). A new tool must be zeroed at the same surface point, or the height map will not match.');
      }
      if (t.letter !== 'G') continue;
      const gi = Math.round(t.value * 10);
      switch (gi) {
        case 0: motion = 0; break;
        case 10: motion = 1; break;
        case 20: motion = 2; break;
        case 30: motion = 3; break;
        case 170: plane = 17; break;
        case 180: plane = 18; break;
        case 190: plane = 19; break;
        case 200: inches = true; break;
        case 210: inches = false; break;
        case 900: relative = false; break;
        case 910: relative = true; break;
        case 901: arcAbsolute = true; break;
        case 911: arcAbsolute = false; break;
        case 800: motion = null; break;
        case 530: machineCoords = true; break;
        case 280: case 281: case 300: case 301: storedPosition = true; break;
        case 930: fail(lineNo, 'inverse-time feed (G93) cannot be leveled'); blocked = true; break;
        case 100: fail(lineNo, 'G10 changes coordinate offsets inside the program'); blocked = true; break;
        case 920: case 921: case 922: case 923: fail(lineNo, 'G92 changes coordinate offsets inside the program'); blocked = true; break;
        case 431: case 490: if (gi === 431) { fail(lineNo, 'G43.1 changes the tool length offset inside the program'); blocked = true; } break;
        case 540: case 550: case 560: case 570: case 580: case 590: {
          wcs = `G${gi / 10}`;
          if (wcs !== map.wcs) { fail(lineNo, `the program switches to ${wcs}, but the height map was probed in ${map.wcs}`); blocked = true; }
          break;
        }
        default:
          if (gi >= 380 && gi <= 385) { fail(lineNo, 'probing moves (G38.x) cannot be leveled'); blocked = true; }
          else if (gi === 730 || gi === 760 || (gi >= 810 && gi <= 890)) { fail(lineNo, `canned cycles (G${t.value}) cannot be leveled`); blocked = true; }
      }
    }
    if (blocked) {
      out.push(raw);
      continue;
    }

    const axes = ['X', 'Y', 'Z'] as const;
    const hasAxis = axes.some((a) => a in words);
    const hasArcWords = 'I' in words || 'J' in words || 'K' in words || 'R' in words;

    if (machineCoords) {
      for (let k = 0; k < 3; k++) if (axes[k] in words) known[k] = false;
      lostBy = 'a machine-coordinate move (G53)';
      out.push(raw);
      continue;
    }
    if (storedPosition) {
      known.fill(false);
      lostBy = 'a move to a stored position (G28/G30)';
      out.push(raw);
      continue;
    }
    if (motion === null || (!hasAxis && !(motion >= 2 && hasArcWords))) {
      out.push(raw);
      continue;
    }
    if (relative) {
      fail(lineNo, 'relative moves (G91) cannot be leveled. Post the program with absolute coordinates (G90).');
      out.push(raw);
      continue;
    }

    const scale = inches ? 25.4 : 1;
    const start = [pos[0], pos[1], pos[2]];
    const target = [pos[0], pos[1], pos[2]];
    for (let k = 0; k < 3; k++) if (axes[k] in words) target[k] = words[axes[k]] * scale;
    const knownAfter = known.map((v, k) => v || axes[k] in words);

    // Words to keep on the first output line: everything except axes, arc words, line numbers, motion G.
    const keep = tokens
      .filter((t) => !['X', 'Y', 'Z', 'I', 'J', 'K', 'R', 'N'].includes(t.letter) && !(t.letter === 'G' && [0, 10, 20, 30].includes(Math.round(t.value * 10))))
      .map((t) => t.text);

    // A feed move from an unknown start that ends above the stock cuts nothing: position like a rapid.
    const positioning = motion === 0 || (!known.every(Boolean) && knownAfter[2] && target[2] > safeZ);
    if (positioning) {
      if (knownAfter.every(Boolean)) {
        // Rapid: correct the end point only. Outside the map, use the nearest edge height.
        if (!insideMap(map, target[0], target[1], INSIDE_TOLERANCE_MM)) {
          warnings.add('Some rapid moves end outside the probed area; they use the height at the nearest edge of the map.');
        }
        const z = target[2] + correct(target[0], target[1]);
        out.push([motion === 0 ? 'G0' : 'G1', ...keep, `X${fmt(target[0])}`, `Y${fmt(target[1])}`, `Z${fmt(z)}`].join(' '));
      } else {
        out.push(raw); // positioning before the start point is known: left as written
      }
    } else {
      if (!known.every(Boolean) || !knownAfter.every(Boolean)) {
        fail(
          lineNo,
          lostBy
            ? `cutting move after ${lostBy}: the work position is unknown until the program sets X, Y and Z again`
            : !knownAfter[2]
              ? 'the program moves before it has set Z. Leveling needs absolute Z heights (2D jobs that never set Z cannot be leveled).'
              : 'cutting move before the program has set X, Y and Z, so where it cuts is unknown',
        );
        out.push(raw);
      } else {
        const points = motion === 1 ? [target] : arcPoints(start, target, words, scale, motion === 2, plane, arcAbsolute);
        if (points === null) {
          fail(lineNo, 'arc with an invalid radius or centre');
          out.push(raw);
        } else {
          if (motion >= 2) stats.arcsConverted++;
          const split = splitPolyline(start, points, segmentLength);
          const outside = split.find((p) => !insideMap(map, p[0], p[1], INSIDE_TOLERANCE_MM));
          if (outside) {
            fail(lineNo, `cuts outside the probed area (at X${fmt(outside[0])} Y${fmt(outside[1])}). Probe a larger area.`);
            out.push(raw);
          } else {
            split.forEach((p, idx) => {
              const z = p[2] + correct(p[0], p[1]);
              out.push([...(idx === 0 ? ['G1', ...keep] : ['G1']), `X${fmt(p[0])}`, `Y${fmt(p[1])}`, `Z${fmt(z)}`].join(' '));
            });
          }
        }
      }
    }

    for (let k = 0; k < 3; k++) {
      pos[k] = target[k];
      known[k] = knownAfter[k];
    }
    if (known.every(Boolean)) lostBy = null;
  }

  stats.outputLines = out.filter((l) => l.trim() !== '').length;
  if (stats.correctedPoints === 0) {
    stats.minCorrection = 0;
    stats.maxCorrection = 0;
    if (errors.length === 0) errors.push('The program has no moves that could be leveled.');
  }
  const ok = errors.length === 0;
  return { ok, gcode: ok ? `${out.join('\n')}\n` : '', errors, warnings: [...warnings], stats };
}

/** Splits each segment of the polyline start → points into pieces no longer than `maxLen` (XY distance). */
function splitPolyline(start: number[], points: number[][], maxLen: number): number[][] {
  const result: number[][] = [];
  let prev = start;
  for (const p of points) {
    const dxy = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const n = Math.max(1, Math.ceil(dxy / maxLen - 1e-9));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      result.push(s === n ? [p[0], p[1], p[2]] : [prev[0] + (p[0] - prev[0]) * t, prev[1] + (p[1] - prev[1]) * t, prev[2] + (p[2] - prev[2]) * t]);
    }
    prev = p;
  }
  return result;
}

/**
 * Points along a G2/G3 arc (end point included, start excluded), any plane, helical allowed.
 * Same geometry as the 3D view (toolpath.ts): IJK incremental unless G90.1, R form with negative R
 * for the long arc. Returns null when the arc is not well defined.
 */
function arcPoints(
  start: number[],
  target: number[],
  words: Record<string, number>,
  scale: number,
  clockwise: boolean,
  plane: Plane,
  arcAbsolute: boolean,
): number[][] | null {
  const [u, v, w] = plane === 17 ? [0, 1, 2] : plane === 18 ? [2, 0, 1] : [1, 2, 0];
  const offsetWord = ['I', 'J', 'K'];
  const su = start[u], sv = start[v];
  const eu = target[u], ev = target[v];
  let cu: number;
  let cv: number;

  if ('R' in words) {
    let radius = words.R * scale;
    const dx = eu - su, dy = ev - sv;
    const d2 = dx * dx + dy * dy;
    if (d2 === 0 || radius === 0) return null;
    let h2 = radius * radius - d2 / 4;
    if (h2 < -1e-6 * radius * radius) return null; // radius too small for the chord
    if (h2 < 0) h2 = 0;
    let h = Math.sqrt(h2) / Math.sqrt(d2);
    if (clockwise) h = -h;
    if (radius < 0) {
      h = -h;
      radius = -radius;
    }
    cu = su + dx / 2 - h * dy;
    cv = sv + dy / 2 + h * dx;
  } else {
    const ou = (words[offsetWord[u]] ?? 0) * scale;
    const ov = (words[offsetWord[v]] ?? 0) * scale;
    cu = arcAbsolute ? ou : su + ou;
    cv = arcAbsolute ? ov : sv + ov;
  }

  const radius = Math.hypot(su - cu, sv - cv);
  const endRadius = Math.hypot(eu - cu, ev - cv);
  if (radius < 1e-6) return null;
  // GRBL rejects arcs whose end point is not on the circle (error 33): 0.005 mm or 0.1 % of radius.
  if (Math.abs(endRadius - radius) > Math.max(0.005, radius * 0.001)) return null;

  const a0 = Math.atan2(sv - cv, su - cu);
  const a1 = Math.atan2(ev - cv, eu - cu);
  let sweep = a1 - a0;
  if (clockwise) {
    if (sweep >= -1e-9) sweep -= Math.PI * 2;
  } else if (sweep <= 1e-9) sweep += Math.PI * 2;

  const maxStep = radius > ARC_TOLERANCE_MM ? 2 * Math.acos(1 - ARC_TOLERANCE_MM / radius) : Math.PI / 4;
  const steps = Math.min(MAX_ARC_SEGMENTS, Math.max(4, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-4))));
  const sw = start[w], ew = target[w];
  const points: number[][] = [];
  for (let s = 1; s <= steps; s++) {
    if (s === steps) {
      points.push([target[0], target[1], target[2]]);
      break;
    }
    const t = s / steps;
    const a = a0 + sweep * t;
    const p = [0, 0, 0];
    p[u] = cu + radius * Math.cos(a);
    p[v] = cv + radius * Math.sin(a);
    p[w] = sw + (ew - sw) * t;
    points.push(p);
  }
  return points;
}
