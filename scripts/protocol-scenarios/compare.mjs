#!/usr/bin/env node
/**
 * Compares two protocol recordings (record.mts output): `compare.mjs <baselineDir> <newDir>`.
 *
 * Each `<scenario>.trace` holds "<ms>\t<record>" lines written by the fake controller. Normalizing:
 *   - the relative times are dropped;
 *   - status polls (`<?>` and `$G`, sent on the backend's own 250 ms timer) are taken out of the
 *     sequence, because how many land between two commands depends on timing. Their cadence is
 *     reported separately (count, median, p90 and max interval), and a median that moves by more
 *     than max(25 ms, 10 %) counts as a difference, so a polling regression is still caught. Only
 *     polls with at least MIN_SAMPLES in the baseline are judged: a handful of `$G` intervals
 *     stretched by moves the controller answers in order (probing, a streaming job) has no stable
 *     median and is shown for information only.
 * Everything else (lines, real-time bytes, XModem summaries) must match exactly, in order.
 *
 * Prints a unified diff per scenario and exits 1 when anything differs (2 on usage errors).
 * `--ignore-cadence` reports cadence changes without failing on them.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const ignoreCadence = args.includes('--ignore-cadence');
const dirs = args.filter((a) => !a.startsWith('--'));
if (dirs.length !== 2) {
  console.error('usage: compare.mjs [--ignore-cadence] <baselineDir> <newDir>');
  process.exit(2);
}
const [baseDir, newDir] = dirs.map((d) => path.resolve(d));
for (const d of [baseDir, newDir]) {
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
    console.error(`not a directory: ${d}`);
    process.exit(2);
  }
}

const POLLS = ['<?>', '$G'];
const CONTEXT = 3;
const MIN_SAMPLES = 10;

function readTrace(file) {
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const tab = l.indexOf('\t');
      return { ms: Number(l.slice(0, tab)), text: l.slice(tab + 1) };
    });
  const traffic = records.filter((r) => !POLLS.includes(r.text)).map((r) => r.text);
  const cadence = Object.fromEntries(POLLS.map((p) => [p, intervals(records.filter((r) => r.text === p).map((r) => r.ms))]));
  return { traffic, cadence };
}

function intervals(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const at = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] : NaN);
  return { count: times.length, median: at(0.5), p90: at(0.9), max: gaps.length ? gaps[gaps.length - 1] : NaN };
}

/** Line diff (LCS table; traces are a few hundred lines) as a list of [' ' | '-' | '+', text]. */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i++]]);
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

/** Unified-diff hunks with CONTEXT lines around each change. */
function unified(ops, nameA, nameB) {
  const changed = ops.map((o) => o[0] !== ' ');
  if (!changed.includes(true)) return '';
  const out = [`--- ${nameA}`, `+++ ${nameB}`];
  let k = 0;
  while (k < ops.length) {
    if (!changed[k]) {
      k++;
      continue;
    }
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    // Extend the hunk while the next change is within 2 * CONTEXT unchanged lines.
    for (;;) {
      let next = end + 1;
      while (next < ops.length && !changed[next]) next++;
      if (next < ops.length && next - end <= 2 * CONTEXT) end = next;
      else break;
    }
    end = Math.min(ops.length - 1, end + CONTEXT);
    // Line numbers in each file at the hunk start.
    let la = 1;
    let lb = 1;
    for (let x = 0; x < start; x++) {
      if (ops[x][0] !== '+') la++;
      if (ops[x][0] !== '-') lb++;
    }
    const slice = ops.slice(start, end + 1);
    const ca = slice.filter((o) => o[0] !== '+').length;
    const cb = slice.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${la},${ca} +${lb},${cb} @@`);
    for (const [op, text] of slice) out.push(`${op}${text}`);
    k = end + 1;
  }
  return out.join('\n');
}

const fmt = (v) => (Number.isFinite(v) ? `${Math.round(v)}` : '-');
const cadenceText = (c) => `n=${c.count} median=${fmt(c.median)} p90=${fmt(c.p90)} max=${fmt(c.max)} ms`;

function cadenceChanged(a, b) {
  if (a.count < MIN_SAMPLES) return false;
  if (!Number.isFinite(a.median) || !Number.isFinite(b.median)) return Number.isFinite(a.median) !== Number.isFinite(b.median);
  return Math.abs(a.median - b.median) > Math.max(25, a.median * 0.1);
}

const names = [...new Set([baseDir, newDir].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.trace'))))].sort();
if (names.length === 0) {
  console.error('no .trace files found');
  process.exit(2);
}

let differences = 0;
let cadenceDiffs = 0;
console.log(`baseline: ${baseDir}\nnew:      ${newDir}\n`);
for (const file of names) {
  const scenario = file.replace(/\.trace$/, '');
  const fa = path.join(baseDir, file);
  const fb = path.join(newDir, file);
  if (!fs.existsSync(fa) || !fs.existsSync(fb)) {
    differences++;
    console.log(`✗ ${scenario}: only in ${fs.existsSync(fa) ? 'baseline' : 'new'}\n`);
    continue;
  }
  const a = readTrace(fa);
  const b = readTrace(fb);
  const diff = unified(diffLines(a.traffic, b.traffic), `baseline/${file}`, `new/${file}`);
  let cadenceChanges = 0;
  const cadenceLines = POLLS.map((p) => {
    const changed = cadenceChanged(a.cadence[p], b.cadence[p]);
    if (changed) cadenceChanges++;
    return `    ${p.padEnd(4)} baseline ${cadenceText(a.cadence[p])} | new ${cadenceText(b.cadence[p])}${changed ? '   << CADENCE CHANGED' : ''}`;
  });
  cadenceDiffs += cadenceChanges;
  if (diff) differences++;
  const failed = diff || (cadenceChanges && !ignoreCadence);
  const summary = `${a.traffic.length} / ${b.traffic.length} records, traffic ${diff ? 'differs' : 'identical'}${cadenceChanges ? ', poll cadence changed' : ''}`;
  console.log(`${failed ? '✗' : '✓'} ${scenario}: ${summary}`);
  console.log(cadenceLines.join('\n'));
  if (diff) console.log(`\n${diff}`);
  console.log('');
}

const failCadence = cadenceDiffs > 0 && !ignoreCadence;
if (differences || failCadence) {
  console.log(`DIFFERENT: ${differences} scenario(s) with traffic differences, ${cadenceDiffs} poll cadence change(s)${ignoreCadence ? ' (ignored)' : ''}`);
  process.exit(1);
}
console.log(`SAME: ${names.length} scenario(s), identical serial traffic${cadenceDiffs ? ` (${cadenceDiffs} cadence change(s) ignored)` : ''}`);
