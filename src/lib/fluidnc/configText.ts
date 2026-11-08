/**
 * The FluidNC config as text: the single source of truth for the settings editor.
 *
 * The form is a view of the text. Edits replace only the value on one line (or insert one line),
 * so comments, order and formatting stay exactly as the user wrote them, and the saved file
 * differs from the old one only where something was changed. FluidNC files are block-style YAML
 * (`key: value`, nested by indentation), which is all this parser needs; the full YAML parser
 * (`yaml`) is used for syntax checking.
 */
import { parseDocument } from 'yaml';
import schemaJson from './schema.json';

/* ------------------------------------------------------------------------------------------------
 * Schema (generated from FluidNC docs/config_items.yaml by scripts/build-fluidnc-schema.mjs)
 * ---------------------------------------------------------------------------------------------- */

export interface FieldSpec {
  type: string;
  description: string;
  default?: string;
  defaultNote?: string;
  min?: number;
  max?: number;
  values?: string[];
  tuning?: string;
  pinAttributes?: string;
}

const schema = schemaJson as { source: { repo: string; commit: string; file: string }; fields: Record<string, FieldSpec> };
export const schemaSource = schema.source;
const fieldsLower = new Map(Object.entries(schema.fields).map(([k, v]) => [k.toLowerCase(), { key: k, spec: v }]));

/** "axes/x/motor0/standard_stepper/step_pin" → "axes/<letter>/motorN/standard_stepper/step_pin". */
export function schemaPath(path: string[]): string {
  return path
    .map((seg, i) => {
      if (i === 1 && path[0].toLowerCase() === 'axes' && /^[xyzabcuvw]$/i.test(seg)) return '<letter>';
      if (/^motor[01]$/i.test(seg)) return 'motorN';
      if (/^i2c\d$/i.test(seg)) return 'i2cN';
      if (/^uart\d$/i.test(seg)) return 'uartN';
      if (/^uart_channel\d$/i.test(seg)) return 'uart_channelN';
      if (/^pinextender\d$/i.test(seg)) return 'pinextenderN';
      return seg;
    })
    .join('/');
}

export function fieldSpec(path: string[]): FieldSpec | null {
  return fieldsLower.get(schemaPath(path).toLowerCase())?.spec ?? null;
}

/** Fields the schema defines directly under a section (for "settings using defaults"). */
export function sectionFields(path: string[]): { name: string; spec: FieldSpec }[] {
  const base = schemaPath(path).toLowerCase();
  const prefix = base ? `${base}/` : '';
  const out: { name: string; spec: FieldSpec }[] = [];
  for (const [lower, { key, spec }] of fieldsLower) {
    if (lower.startsWith(prefix) && !lower.slice(prefix.length).includes('/')) {
      out.push({ name: key.slice(prefix.length), spec });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------------------------------- */

export interface ConfigNode {
  key: string;
  path: string[];
  /** 0-based line index of `key:`. */
  line: number;
  indent: number;
  /** Raw value text after `key:` (without comment), '' for sections. */
  value: string;
  /** Last line (inclusive) belonging to this node, children included. */
  endLine: number;
  children: ConfigNode[];
  isSection: boolean;
}

const KEY_LINE = /^(\s*)([^\s#:'"][^:#]*?|'[^']*'|"[^"]*"):(?:\s+(.*?))?\s*$/;

/** Splits "value  # comment" (a # only starts a comment after whitespace, outside quotes). */
function splitComment(rest: string): { value: string; comment: string } {
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(rest[i - 1]))) {
      return { value: rest.slice(0, i).trimEnd(), comment: rest.slice(i) };
    }
  }
  return { value: rest.trimEnd(), comment: '' };
}

export function parseConfig(text: string): ConfigNode[] {
  const lines = text.split('\n');
  const roots: ConfigNode[] = [];
  const stack: ConfigNode[] = [];
  lines.forEach((raw, index) => {
    if (!raw.trim() || raw.trim().startsWith('#')) return;
    const m = KEY_LINE.exec(raw);
    if (!m) return;
    const indent = m[1].length;
    const key = m[2].replace(/^['"](.*)['"]$/, '$1');
    const { value } = splitComment(m[3] ?? '');
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const node: ConfigNode = {
      key,
      path: [...(parent?.path ?? []), key],
      line: index,
      indent,
      value,
      endLine: index,
      children: [],
      isSection: value === '' || value === '{}',
    };
    (parent ? parent.children : roots).push(node);
    for (const ancestor of stack) ancestor.endLine = index;
    stack.push(node);
  });
  return roots;
}

export function findNode(roots: ConfigNode[], path: string[]): ConfigNode | null {
  let level = roots;
  let found: ConfigNode | null = null;
  for (const seg of path) {
    found = level.find((n) => n.key.toLowerCase() === seg.toLowerCase()) ?? null;
    if (!found) return null;
    level = found.children;
  }
  return found;
}

/* ------------------------------------------------------------------------------------------------
 * Edits
 * ---------------------------------------------------------------------------------------------- */

/** YAML needs quotes for values that would otherwise be misread (": ", " #", leading specials). */
export function formatValue(value: string): string {
  const v = value.trim();
  if (v === '') return "''";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^[\s'"&*!|>%@`{[\],?-]/.test(v) || /: |\s#/.test(v) || v.endsWith(':')) {
    return `'${v.replace(/'/g, "''")}'`;
  }
  return v;
}

/** Display form of a raw YAML scalar: strips matching quotes. */
export function plainValue(raw: string): string {
  const v = raw.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1);
  return v;
}

/** Replaces the value of the leaf at `path`, keeping indentation and any trailing comment. */
export function setValue(text: string, path: string[], value: string): string {
  const node = findNode(parseConfig(text), path);
  if (!node || node.isSection) return text;
  const lines = text.split('\n');
  const raw = lines[node.line];
  const m = KEY_LINE.exec(raw);
  if (!m) return text;
  const { comment } = splitComment(m[3] ?? '');
  const head = raw.slice(0, raw.indexOf(':', m[1].length) + 1);
  lines[node.line] = `${head} ${formatValue(value)}${comment ? `  ${comment}` : ''}`;
  return lines.join('\n');
}

/** Adds `name: value` as the last entry of the section at `sectionPath`. */
export function addValue(text: string, sectionPath: string[], name: string, value: string): string {
  const roots = parseConfig(text);
  const lines = text.split('\n');
  const entry = (indent: number) => `${' '.repeat(indent)}${name}: ${formatValue(value)}`;
  if (sectionPath.length === 0) {
    const insertAt = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(insertAt, 0, entry(0));
    return lines.join('\n');
  }
  const section = findNode(roots, sectionPath);
  if (!section) return text;
  const childIndent = section.children[0]?.indent ?? section.indent + 2;
  if (section.value === '{}') {
    // "kinematics: {}" → turn the empty flow mapping into a block section first
    lines[section.line] = lines[section.line].replace(/:\s*\{\}/, ':');
  }
  lines.splice(section.endLine + 1, 0, entry(childIndent));
  return lines.join('\n');
}

/* ------------------------------------------------------------------------------------------------
 * Labels and units
 * ---------------------------------------------------------------------------------------------- */

const UNIT_SUFFIXES: [RegExp, string][] = [
  [/_mm_per_min$/, 'mm/min'],
  [/_mm_per_sec2$/, 'mm/s²'],
  [/_mm_per_sec$/, 'mm/s'],
  [/^steps_per_mm$/, 'steps/mm'],
  [/_mm$/, 'mm'],
  [/_ms$/, 'ms'],
  [/_us$/, 'µs'],
  [/_hz$/, 'Hz'],
  [/_rpm$/i, 'RPM'],
  [/_percent$/, '%'],
];

export function unitFor(key: string): string | null {
  for (const [re, unit] of UNIT_SUFFIXES) if (re.test(key)) return unit;
  return null;
}

const LABEL_OVERRIDES: Record<string, string> = {
  steps_per_mm: 'Steps per mm',
  max_rate_mm_per_min: 'Max rate',
  acceleration_mm_per_sec2: 'Acceleration',
  max_travel_mm: 'Max travel',
  mpos_mm: 'Machine position after homing',
  seek_mm_per_min: 'Seek rate',
  feed_mm_per_min: 'Feed rate',
  pulloff_mm: 'Pull-off distance',
  pwm_hz: 'PWM frequency',
  idle_ms: 'Motor idle timeout',
  pulse_us: 'Step pulse length',
  dir_delay_us: 'Direction delay',
  disable_delay_us: 'Enable delay',
  s0_with_disable: 'S0 when disabled',
  disable_with_s0: 'Disable at S0',
};

export function labelFor(key: string): string {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  let base = key;
  for (const [re] of UNIT_SUFFIXES) base = base.replace(re, '');
  base = base.replace(/_pin$/, ' pin').replace(/_/g, ' ').trim() || key;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Short explanations for sections, which the field reference does not describe. */
const SECTION_TEXT: Record<string, string> = {
  axes: 'Axis definitions: travel, speeds, homing and the motor wiring for each axis.',
  'axes/<letter>': 'Resolution, speed, acceleration and travel limits for this axis.',
  'axes/<letter>/homing': 'How this axis finds its home switch: order, direction and speeds.',
  'axes/<letter>/motorN': 'One motor on this axis: its limit switches and driver wiring.',
  'axes/<letter>/motorN/standard_stepper': 'A step/direction driver such as the TB6600.',
  stepping: 'How step pulses are generated for all motors.',
  kinematics: 'How axis motion maps to the machine’s mechanics. Cartesian is a normal X/Y/Z machine.',
  PWM: 'A spindle controlled by a PWM signal plus an enable pin.',
  probe: 'The touch probe input used for G38 probing.',
  start: 'Behaviour at power-up and reset.',
  control: 'Inputs for physical buttons such as feed hold, cycle start and reset.',
  coolant: 'Outputs for flood and mist coolant (M7/M8/M9).',
  macros: 'G-code run at startup or from macro buttons.',
  parking: 'Parking motion when the safety door opens.',
  user_outputs: 'Extra digital and analog outputs (M62–M68).',
  user_inputs: 'Extra digital and analog inputs (M66).',
  spi: 'SPI bus pins, used by SD cards and some drivers.',
  sdcard: 'SD card reader pins.',
};

export function sectionText(path: string[]): string | null {
  const key = schemaPath(path);
  return SECTION_TEXT[key] ?? SECTION_TEXT[path[path.length - 1]] ?? null;
}

/* ------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

export interface Issue {
  level: 'error' | 'warning';
  message: string;
  /** 0-based line, when the issue belongs to one. */
  line?: number;
  path?: string[];
}

const PIN = /^(no_pin|void|gpio\.\d+|i2so\.\d+|pinext\d\.\d+|uart_channel\d\.\d+)(:[a-z0-9_]+)*$/i;

/** Checks one value against its field spec; returns a message or null. */
export function checkValue(spec: FieldSpec | null, raw: string): string | null {
  if (!spec) return null;
  const v = plainValue(raw);
  switch (spec.type) {
    case 'boolean':
      return /^(true|false)$/i.test(v) ? null : 'Must be true or false';
    case 'integer': {
      if (!/^-?\d+$/.test(v)) return 'Must be a whole number';
      return range(spec, Number(v));
    }
    case 'float': {
      if (v === '' || !Number.isFinite(Number(v))) return 'Must be a number';
      return range(spec, Number(v));
    }
    case 'enum':
      return spec.values && !spec.values.some((x) => x.toLowerCase() === v.toLowerCase())
        ? `Must be one of: ${spec.values.join(', ')}`
        : null;
    case 'pin':
      return PIN.test(v) ? null : 'Not a valid pin (for example gpio.25, gpio.5:low or NO_PIN)';
    default:
      return null;
  }
}

function range(spec: FieldSpec, n: number): string | null {
  if (spec.min !== undefined && n < spec.min) return `Must be at least ${spec.min}`;
  if (spec.max !== undefined && n > spec.max) return `Must be at most ${spec.max}`;
  return null;
}

function walk(nodes: ConfigNode[], visit: (n: ConfigNode) => void): void {
  for (const n of nodes) {
    visit(n);
    walk(n.children, visit);
  }
}

export function validateConfig(text: string, freeBytes: number | null): Issue[] {
  const issues: Issue[] = [];
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    if (line.includes('\t')) issues.push({ level: 'error', line: i, message: `Line ${i + 1} uses a tab. FluidNC needs spaces for indentation.` });
  });
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    issues.push({ level: 'error', message: 'The file contains control characters. It must be plain text.' });
  }

  const doc = parseDocument(text, { uniqueKeys: true });
  for (const e of doc.errors) {
    const line = e.linePos?.[0]?.line;
    issues.push({ level: 'error', line: line ? line - 1 : undefined, message: `YAML error${line ? ` on line ${line}` : ''}: ${e.message.split('\n')[0]}` });
  }
  if (doc.errors.length > 0) return issues; // the structure below is unreliable

  const roots = parseConfig(text);
  const pins = new Map<string, string[]>();
  walk(roots, (n) => {
    if (n.isSection) return;
    const message = checkValue(fieldSpec(n.path), n.value);
    if (message) issues.push({ level: 'error', line: n.line, path: n.path, message: `${n.path.join('/')}: ${message}` });
    if (/_pin$|^pin$/.test(n.key)) {
      const gpio = /^gpio\.(\d+)/i.exec(plainValue(n.value))?.[1];
      if (gpio) pins.set(gpio, [...(pins.get(gpio) ?? []), n.path.join('/')]);
    }
  });

  for (const [gpio, users] of pins) {
    if (users.length > 1) {
      issues.push({ level: 'warning', message: `gpio.${gpio} is used ${users.length} times: ${users.join(', ')}. Check this is intended.` });
    }
  }

  // Homing toward an end that has no switch (FluidNC warns about this at boot).
  const axes = findNode(roots, ['axes']);
  for (const axis of axes?.children ?? []) {
    if (!/^[xyzabcuvw]$/i.test(axis.key)) continue;
    const homing = findNode(axis.children, ['homing']);
    const positive = findNode(homing?.children ?? [], ['positive_direction']);
    const cycle = findNode(homing?.children ?? [], ['cycle']);
    if (!homing || !positive || (cycle && Number(plainValue(cycle.value)) <= 0)) continue;
    const toPositive = /^true$/i.test(plainValue(positive.value));
    for (const motor of axis.children.filter((c) => /^motor[01]$/i.test(c.key))) {
      const pin = (name: string) => plainValue(findNode(motor.children, [name])?.value ?? 'NO_PIN');
      const has = (name: string) => !/^no[_ ]pin$/i.test(pin(name));
      if (has('limit_all_pin')) continue;
      if (toPositive && !has('limit_pos_pin') && has('limit_neg_pin')) {
        issues.push({
          level: 'warning',
          line: positive.line,
          path: positive.path,
          message: `Axis ${axis.key.toUpperCase()} homes in the positive direction, but ${motor.key} only has a negative limit switch. Homing would move away from the switch.`,
        });
      }
      if (!toPositive && !has('limit_neg_pin') && has('limit_pos_pin')) {
        issues.push({
          level: 'warning',
          line: positive.line,
          path: positive.path,
          message: `Axis ${axis.key.toUpperCase()} homes in the negative direction, but ${motor.key} only has a positive limit switch. Homing would move away from the switch.`,
        });
      }
    }
  }

  if (!findNode(roots, ['axes'])) {
    issues.push({ level: 'warning', message: 'There is no axes: section. The machine would have no axes after a restart.' });
  }
  const bytes = new TextEncoder().encode(text).length;
  if (freeBytes !== null && bytes + 2048 > freeBytes) {
    issues.push({ level: 'error', message: `The file (${bytes} bytes) does not fit in the controller’s free space.` });
  }
  return issues;
}

/* ------------------------------------------------------------------------------------------------
 * Diff
 * ---------------------------------------------------------------------------------------------- */

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Line diff (LCS). Config files are a few hundred lines at most. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i], oldLine: i + 1 });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'removed', text: a[i], oldLine: ++i });
  while (j < m) out.push({ kind: 'added', text: b[j], newLine: ++j });
  return out;
}

/** Changed lines: a modified line counts once (one removed + one added). */
export function changeCount(before: string, after: string): number {
  const diff = diffLines(before, after);
  const added = diff.filter((d) => d.kind === 'added').length;
  const removed = diff.filter((d) => d.kind === 'removed').length;
  return Math.max(added, removed);
}

/** Parses "52.00 KB" from the controller's LocalFS listing. */
export function parseSize(value: string | null): number | null {
  const m = value ? /([\d.]+)\s*(B|KB|MB)/i.exec(value) : null;
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'MB' ? n * 1024 * 1024 : unit === 'KB' ? n * 1024 : n;
}
