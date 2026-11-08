/**
 * Machine settings editor API (stage S1: read only).
 *
 *   GET /api/kinetiq/machine-config → MachineConfigSnapshot
 *
 * Reads the active FluidNC config file as saved (`$LocalFS/Show`), the config running in memory
 * (`$CD`), the boot log (`$SS`) and the local file system usage (`$LocalFS/List`), one command at
 * a time through exchange.ts. Allowed only when the machine is Idle or Alarm and no job runs.
 *
 * SERVER-ONLY. See docs/SETTINGS_EDITOR.md §3.4.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import { parseDocument } from 'yaml';
import type { CNCSettings } from '../backend';
import { isAuthorized } from '../session';
import { assertIdle, exchange, ExchangeError, exclusive, getOpenController, type FluidncController } from './exchange';

export const MACHINE_CONFIG_PATH = '/api/kinetiq/machine-config';

export type BootLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'other';

export interface ConfigDifference {
  /** Path as written in the saved file, e.g. "axes/x/homing/seek_mm_per_min". */
  path: string;
  saved: string;
  running: string;
}

export interface MachineConfigSnapshot {
  filename: string;
  saved: string;
  savedSha256: string;
  running: string;
  bootLog: { level: BootLogLevel; text: string }[];
  fs: { files: { name: string; size: number }[]; free: string | null; used: string | null; total: string | null };
  /** Keys in the saved file whose running value is different. */
  differences: ConfigDifference[];
  /** Number of running keys not present in the saved file (FluidNC defaults). */
  defaultsCount: number;
  readAt: number;
}

interface ControllerStore {
  get<T = unknown>(key: string, defaultValue?: T): T;
}

/** Runs one command after re-checking that the machine is still idle. */
async function run(controller: FluidncController, command: string): Promise<string[]> {
  assertIdle(controller);
  return exchange(controller, command);
}

function parseBootLog(lines: string[]): MachineConfigSnapshot['bootLog'] {
  return lines.map((line) => {
    const m = /^\[MSG:(INFO|WARN|WARNING|ERR|ERROR|DBG|DEBUG):\s?(.*)\]$/i.exec(line.trim());
    if (!m) return { level: 'other', text: line.trim() };
    const tag = m[1].toUpperCase();
    const level: BootLogLevel = tag.startsWith('WARN') ? 'warn' : tag.startsWith('ERR') ? 'error' : tag.startsWith('D') ? 'debug' : 'info';
    return { level, text: m[2] };
  });
}

function parseFs(lines: string[]): MachineConfigSnapshot['fs'] {
  const files: { name: string; size: number }[] = [];
  let free: string | null = null;
  let used: string | null = null;
  let total: string | null = null;
  for (const line of lines) {
    const file = /^\[FILE:\s*(.+?)\|SIZE:(\d+)\]$/.exec(line.trim());
    if (file) {
      files.push({ name: file[1], size: Number(file[2]) });
      continue;
    }
    const usage = /Free:\s*([\d.]+\s*\w+)\s+Used:\s*([\d.]+\s*\w+)\s+Total:\s*([\d.]+\s*\w+)/.exec(line);
    if (usage) [, free, used, total] = usage;
  }
  return { files, free, used, total };
}

/** Flattens a YAML text into leaf paths. Keys are lower-cased for matching ($CD upper-cases axes). */
function flatten(text: string): Map<string, { path: string; value: string }> {
  const out = new Map<string, { path: string; value: string }>();
  const doc = parseDocument(text, { uniqueKeys: false });
  const walk = (node: unknown, path: string[]) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length === 0 && path.length > 0) {
        out.set(path.join('/').toLowerCase(), { path: path.join('/'), value: '' });
      }
      for (const [key, value] of entries) walk(value, [...path, key]);
      return;
    }
    out.set(path.join('/').toLowerCase(), { path: path.join('/'), value: node === null || node === undefined ? '' : String(node) });
  };
  walk(doc.toJS({ maxAliasCount: -1 }), []);
  return out;
}

/**
 * Same value once FluidNC's dump formatting is undone: quotes, "NO PIN", the default `:high` pin
 * attribute it leaves out (gpio.32:high = gpio.32), and number formatting inside values
 * (400 vs 400.000000, "0=0.0%" vs "0=0.00%").
 */
function sameValue(a: string, b: string): boolean {
  const norm = (v: string) =>
    v
      .trim()
      .replace(/^'(.*)'$/, '$1')
      .replace(/^"(.*)"$/, '$1')
      .replace(/^no[ _]pin$/i, 'no_pin')
      .replace(/^(gpio\.\d+(?::[a-z]+)*?):high((?::[a-z]+)*)$/i, '$1$2')
      .replace(/-?\d+(?:\.\d+)?/g, (n) => String(Number(n)))
      .toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const nx = Number(x);
  const ny = Number(y);
  return x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) && Math.abs(nx - ny) < 1e-6;
}

function compare(saved: string, running: string): { differences: ConfigDifference[]; defaultsCount: number } {
  let savedMap: Map<string, { path: string; value: string }>;
  let runningMap: Map<string, { path: string; value: string }>;
  try {
    savedMap = flatten(saved);
    runningMap = flatten(running);
  } catch {
    return { differences: [], defaultsCount: 0 }; // unparsable file: the YAML view still shows it
  }
  const differences: ConfigDifference[] = [];
  for (const [key, entry] of savedMap) {
    const live = runningMap.get(key);
    if (live && !sameValue(entry.value, live.value)) {
      differences.push({ path: entry.path, saved: entry.value, running: live.value });
    }
  }
  let defaultsCount = 0;
  for (const key of runningMap.keys()) if (!savedMap.has(key)) defaultsCount++;
  return { differences, defaultsCount };
}

export async function readMachineConfig(store: ControllerStore): Promise<MachineConfigSnapshot> {
  const controller = getOpenController(store);
  return exclusive(async () => {
    const filenameReply = await run(controller, '$Config/Filename');
    const filename =
      filenameReply.map((l) => /^\$Config\/Filename=(.+)$/.exec(l.trim())?.[1]).find(Boolean) || 'config.yaml';
    const fsLines = await run(controller, '$LocalFS/List');
    const savedLines = await run(controller, `$LocalFS/Show=${filename}`);
    const runningLines = await run(controller, '$CD');
    const bootLines = await run(controller, '$SS');

    if (savedLines.length === 0) {
      throw new ExchangeError(502, 'controller-error', `${filename} came back empty. Try Reload.`);
    }
    const saved = `${savedLines.join('\n')}\n`;
    const running = `${runningLines.join('\n')}\n`;
    return {
      filename,
      saved,
      savedSha256: crypto.createHash('sha256').update(saved).digest('hex'),
      running,
      bootLog: parseBootLog(bootLines),
      fs: parseFs(fsLines),
      ...compare(saved, running),
      readAt: Date.now(),
    };
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function handleMachineConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  settings: CNCSettings,
  store: ControllerStore,
): Promise<void> {
  if (!isAuthorized(req, settings)) {
    return send(res, 403, { error: 'forbidden' });
  }
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname !== MACHINE_CONFIG_PATH) {
    return send(res, 404, { error: 'Not found' });
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { error: 'Method not allowed' });
  }
  try {
    send(res, 200, await readMachineConfig(store));
  } catch (err) {
    if (err instanceof ExchangeError) {
      return send(res, err.status, { error: err.message, code: err.code });
    }
    console.error('[kinetiq] machine-config:', err);
    if (!res.headersSent) send(res, 500, { error: 'Could not read the machine config' });
  }
}
