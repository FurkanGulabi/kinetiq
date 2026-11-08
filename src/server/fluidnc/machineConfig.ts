/**
 * Machine settings editor API.
 *
 *   GET  /api/kinetiq/machine-config                      → MachineConfigSnapshot
 *   PUT  /api/kinetiq/machine-config  { text, baseSha256 } → SaveResult   (backup, upload, verify)
 *   POST /api/kinetiq/machine-config/restart              → RestartResult ($Bye, boot log)
 *   GET  /api/kinetiq/machine-config/backups              → BackupInfo[]
 *   GET  /api/kinetiq/machine-config/backups/<id>         → text/plain
 *   POST /api/kinetiq/machine-config/backups/<id>/restore → SaveResult
 *
 * Every operation talks to FluidNC one command at a time through exchange.ts, holds the exchange
 * lock, and needs the machine Idle or Alarm with no job running.
 *
 * Saving never writes the active file directly: the new text is uploaded to a temporary file with
 * XModem and read back, then swapped in with two renames, so a failed transfer cannot leave a
 * truncated config.yaml. A copy of the previous file is kept in ~/.kinetiq/config-backups first.
 *
 * SERVER-ONLY. See docs/SETTINGS_EDITOR.md §3.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { CNCSettings } from '../backend';
import { isAuthorized } from '../session';
import { assertIdle, exchange, ExchangeError, exclusive, getOpenController, type FluidncController } from './exchange';
import { xmodemSend } from './xmodem';

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

/* ------------------------------------------------------------------------------------------------
 * Save
 * ---------------------------------------------------------------------------------------------- */

const MAX_CONFIG_BYTES = 32 * 1024;
const TEMP_FILE = 'kinetiq-new.yaml';
const PREVIOUS_FILE = 'kinetiq-prev.yaml';
const BACKUP_DIR = path.resolve(process.env.KINETIQ_CONFIG_BACKUP_DIR || path.join(os.homedir(), '.kinetiq', 'config-backups'));
const MAX_BACKUPS = 20;

export interface SaveResult {
  filename: string;
  savedSha256: string;
  bytes: number;
  backup: BackupInfo;
  restartRequired: true;
}

export interface BackupInfo {
  id: string;
  filename: string;
  size: number;
  savedAt: number;
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * What `$LocalFS/Show` can reproduce: the serial line reader drops empty lines and FluidNC
 * may strip trailing spaces, so files are compared without blank lines or trailing whitespace.
 */
function comparable(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join('\n');
}

/** Server-side checks; the editor runs the same and more before it ever sends. */
function validateConfigText(text: unknown): string {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ExchangeError(400, 'invalid', 'The config is empty');
  }
  const normalized = `${text.replace(/\r\n?/g, '\n').replace(/\n*$/, '')}\n`;
  if (Buffer.byteLength(normalized) > MAX_CONFIG_BYTES) {
    throw new ExchangeError(400, 'invalid', `The config is larger than ${MAX_CONFIG_BYTES / 1024} KB`);
  }
  const tab = normalized.split('\n').findIndex((line) => line.includes('\t'));
  if (tab >= 0) {
    throw new ExchangeError(400, 'invalid', `Line ${tab + 1} contains a tab. FluidNC needs spaces for indentation.`);
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(normalized)) {
    throw new ExchangeError(400, 'invalid', 'The config contains control characters. It must be plain text.');
  }
  const doc = parseDocument(normalized, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const line = e.linePos?.[0]?.line;
    throw new ExchangeError(400, 'invalid', `YAML error${line ? ` on line ${line}` : ''}: ${e.message.split('\n')[0]}`);
  }
  const contents = doc.toJS();
  if (!contents || typeof contents !== 'object' || Array.isArray(contents)) {
    throw new ExchangeError(400, 'invalid', 'The config must be a YAML mapping (key: value lines)');
  }
  return normalized;
}

function parseSize(value: string | null): number | null {
  const m = value ? /([\d.]+)\s*(B|KB|MB)/i.exec(value) : null;
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'MB' ? n * 1024 * 1024 : unit === 'KB' ? n * 1024 : n;
}

async function writeBackup(filename: string, text: string): Promise<BackupInfo> {
  await fs.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const savedAt = Date.now();
  const id = `${new Date(savedAt).toISOString().replace(/[:.]/g, '-')}-${filename.replace(/[^\w.-]/g, '_')}`;
  await fs.writeFile(path.join(BACKUP_DIR, id), text, { mode: 0o600 });
  const all = (await fs.readdir(BACKUP_DIR)).filter((f) => !f.startsWith('.')).sort();
  await Promise.all(all.slice(0, Math.max(0, all.length - MAX_BACKUPS)).map((f) => fs.rm(path.join(BACKUP_DIR, f), { force: true })));
  return { id, filename, size: Buffer.byteLength(text), savedAt };
}

export async function listBackups(): Promise<BackupInfo[]> {
  let files: string[];
  try {
    files = (await fs.readdir(BACKUP_DIR)).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }
  const infos = await Promise.all(
    files.map(async (id) => {
      const stat = await fs.stat(path.join(BACKUP_DIR, id));
      const m = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-(.+)$/.exec(id);
      return { id, filename: m ? m[1] : id, size: stat.size, savedAt: stat.mtimeMs };
    }),
  );
  return infos.sort((a, b) => b.savedAt - a.savedAt);
}

export async function readBackup(id: string): Promise<string> {
  if (!/^[\w.-]+$/.test(id) || id.startsWith('.')) {
    throw new ExchangeError(404, 'not-found', 'Backup not found');
  }
  try {
    return await fs.readFile(path.join(BACKUP_DIR, id), 'utf8');
  } catch {
    throw new ExchangeError(404, 'not-found', 'Backup not found');
  }
}

async function activeFilename(controller: FluidncController): Promise<string> {
  const reply = await run(controller, '$Config/Filename');
  return reply.map((l) => /^\$Config\/Filename=(.+)$/.exec(l.trim())?.[1]).find(Boolean) || 'config.yaml';
}

async function showFile(controller: FluidncController, filename: string): Promise<string> {
  const lines = await run(controller, `$LocalFS/Show=${filename}`);
  return `${lines.join('\n')}\n`;
}

/** `$LocalFS/Delete` answers with an error when the file does not exist; that is fine here. */
async function deleteIfPresent(controller: FluidncController, filename: string): Promise<void> {
  try {
    await run(controller, `$LocalFS/Delete=${filename}`);
  } catch (err) {
    if (!(err instanceof ExchangeError) || err.code !== 'controller-error') throw err;
  }
}

/** Uploads `text` to `filename` with XModem while the controller's polling is paused. */
async function upload(controller: FluidncController, filename: string, text: string): Promise<void> {
  const port = controller.connection?.port;
  if (!port) {
    throw new ExchangeError(412, 'not-connected', 'Connect to the controller first');
  }
  const data = Buffer.from(text, 'utf8');
  controller.setExclusive(true);
  try {
    await new Promise((r) => setTimeout(r, 400)); // let a status reply already in flight arrive
    const finished = exchange(controller, null, 30000); // "Received N bytes …" then ok
    finished.catch(() => undefined);
    try {
      await xmodemSend(port, data, () => controller.writeln(`$Xmodem/Receive=${filename}`, { source: 'kinetiq:settings' }));
    } catch (err) {
      throw new ExchangeError(502, 'upload-failed', `Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const reply = await finished;
    const received = reply.map((l) => /Received (\d+) bytes/.exec(l)?.[1]).find(Boolean);
    if (received !== undefined && Number(received) !== data.length) {
      throw new ExchangeError(502, 'upload-failed', `The controller received ${received} of ${data.length} bytes`);
    }
  } finally {
    controller.setExclusive(false);
  }
}

/**
 * Saves `text` as the active config file. With `baseSha256`, refuses (409) if the file on the
 * controller changed since the editor read it.
 */
export async function saveMachineConfig(store: ControllerStore, rawText: unknown, baseSha256?: string): Promise<SaveResult> {
  const text = validateConfigText(rawText);
  const controller = getOpenController(store);
  return exclusive(async () => {
    const filename = await activeFilename(controller);
    const current = await showFile(controller, filename);
    if (baseSha256 && sha256(current) !== baseSha256) {
      throw new ExchangeError(409, 'changed', `${filename} changed on the controller since it was read. Reload, then edit again.`);
    }

    const fsInfo = parseFs(await run(controller, '$LocalFS/List'));
    const free = parseSize(fsInfo.free);
    const bytes = Buffer.byteLength(text);
    if (free !== null && bytes + 2048 > free) {
      throw new ExchangeError(507, 'no-space', `Not enough space on the controller: ${fsInfo.free} free, ${bytes} bytes needed`);
    }

    const backup = await writeBackup(filename, current);

    await deleteIfPresent(controller, TEMP_FILE);
    await deleteIfPresent(controller, PREVIOUS_FILE);
    await upload(controller, TEMP_FILE, text);

    const uploaded = await showFile(controller, TEMP_FILE);
    if (comparable(uploaded) !== comparable(text)) {
      await deleteIfPresent(controller, TEMP_FILE);
      throw new ExchangeError(502, 'verify-failed', `The uploaded file did not read back identically. ${filename} was not changed.`);
    }

    // Swap: active → previous, new → active. Undo the first rename if the second fails.
    await run(controller, `$LocalFS/Rename=${filename}>${PREVIOUS_FILE}`);
    try {
      await run(controller, `$LocalFS/Rename=${TEMP_FILE}>${filename}`);
    } catch (err) {
      await run(controller, `$LocalFS/Rename=${PREVIOUS_FILE}>${filename}`).catch(() => undefined);
      throw err;
    }

    const saved = await showFile(controller, filename);
    if (comparable(saved) !== comparable(text)) {
      throw new ExchangeError(
        502,
        'verify-failed',
        `${filename} does not match what was saved. The previous version is on the controller as ${PREVIOUS_FILE} and in backup ${backup.id}.`,
      );
    }
    await deleteIfPresent(controller, PREVIOUS_FILE);
    return { filename, savedSha256: sha256(saved), bytes, backup, restartRequired: true };
  });
}

/* ------------------------------------------------------------------------------------------------
 * Restart
 * ---------------------------------------------------------------------------------------------- */

export interface RestartResult {
  bootLog: MachineConfigSnapshot['bootLog'];
  banner: string | null;
}

/** `$Bye`, then collects the boot output until the FluidNC banner (plus a short tail) or 25 s. */
export async function restartController(store: ControllerStore): Promise<RestartResult> {
  const controller = getOpenController(store);
  return exclusive(async () => {
    assertIdle(controller);
    const connection = controller.connection;
    if (!connection) throw new ExchangeError(412, 'not-connected', 'Connect to the controller first');

    const lines: string[] = [];
    let banner: string | null = null;
    await new Promise<void>((resolve) => {
      let tail: NodeJS.Timeout | null = null;
      const done = () => {
        clearTimeout(timeout);
        if (tail) clearTimeout(tail);
        connection.removeListener('data', onData);
        connection.removeListener('close', done);
        resolve();
      };
      const onData = (data: unknown) => {
        const line = String(data).replace(/\r$/, '');
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('<') || trimmed === 'ok') return;
        lines.push(trimmed);
        if (!banner && /\[FluidNC/i.test(trimmed)) {
          banner = trimmed;
          tail = setTimeout(done, 1500);
        }
      };
      const timeout = setTimeout(done, 25000);
      connection.on('data', onData);
      connection.on('close', done);
      controller.writeln('$Bye', { source: 'kinetiq:settings' });
    });
    // Keep FluidNC messages; drop the ESP32 ROM boot noise printed before them.
    const messages = lines.filter((l) => /^\[MSG:/.test(l) || /\[FluidNC/i.test(l));
    return { bootLog: parseBootLog(messages), banner };
  });
}

/* ------------------------------------------------------------------------------------------------
 * HTTP
 * ---------------------------------------------------------------------------------------------- */

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ExchangeError(413, 'invalid', 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new ExchangeError(400, 'invalid', 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
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
  const rest = pathname.slice(MACHINE_CONFIG_PATH.length).split('/').filter(Boolean);
  const method = req.method || 'GET';

  try {
    if (rest.length === 0 && method === 'GET') {
      return send(res, 200, await readMachineConfig(store));
    }
    if (rest.length === 0 && method === 'PUT') {
      const body = await readJson(req);
      const base = typeof body.baseSha256 === 'string' ? body.baseSha256 : undefined;
      return send(res, 200, await saveMachineConfig(store, body.text, base));
    }
    if (rest.length === 1 && rest[0] === 'restart' && method === 'POST') {
      return send(res, 200, await restartController(store));
    }
    if (rest[0] === 'backups') {
      if (rest.length === 1 && method === 'GET') {
        return send(res, 200, await listBackups());
      }
      if (rest.length === 2 && method === 'GET') {
        const text = await readBackup(rest[1]);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return void res.end(text);
      }
      if (rest.length === 3 && rest[2] === 'restore' && method === 'POST') {
        return send(res, 200, await saveMachineConfig(store, await readBackup(rest[1])));
      }
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ExchangeError) {
      return send(res, err.status, { error: err.message, code: err.code });
    }
    console.error('[kinetiq] machine-config:', err);
    if (!res.headersSent) send(res, 500, { error: 'Machine settings operation failed' });
  }
}
