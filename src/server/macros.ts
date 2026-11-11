/**
 * Kinetiq macros: named G-code snippets, stored in the rc file under `kinetiq.macros`.
 *
 *   GET    /api/kinetiq/macros        → Macro[] (in the order they were created)
 *   POST   /api/kinetiq/macros        → 201 Macro   (body: { name, content })
 *   PUT    /api/kinetiq/macros/<id>   → 200 Macro   (body: { name, content })
 *   DELETE /api/kinetiq/macros/<id>   → 204
 *
 * Running one is the controller command `macro:run <id>` (controller/commands.ts): the backend looks
 * the macro up here and queues its lines on the Feeder like the `gcode` command, so the feeder
 * filter and TravelGuard apply. The browser never sends macro content to run it.
 *
 * Requests need a loopback Host and the session JWT, like the job library (src/server/jobs.ts).
 * Validation rules and limits are in src/lib/macros/macro.ts (shared with the UI). Only the fields
 * `name` and `content` of a request body are read; ids and mtimes are set here.
 *
 * SECURITY (Kinetiq): this module writes exactly one rc key, `kinetiq.macros`. Macro content only
 * ever goes to the Feeder, never to events/TaskRunner (docs/BACKEND_INTEGRATION.md §7.2).
 *
 * SERVER-ONLY. See docs/API_REFERENCE.md §7.6.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import {
  asMacro,
  MACRO_ID_PATTERN,
  MACROS_MAX,
  validateMacroInput,
  type Macro,
} from '../lib/macros/macro';
import type { CNCSettings } from './backend';
import config from './config/ConfigStore';
import { isAuthorized } from './session';

export const MACROS_PATH = '/api/kinetiq/macros';

/** The only rc key this module reads or writes. */
const MACROS_CONFIG_KEY = 'kinetiq.macros';
/** Request bodies: name + content as JSON (escaping can double the 10,000-character content). */
const MAX_BODY_BYTES = 32 * 1024;

/** The stored macros that are well-formed (a hand-edited entry that is not is skipped). */
export function listMacros(): Macro[] {
  const raw = config.get<unknown>(MACROS_CONFIG_KEY, []);
  if (!Array.isArray(raw)) return [];
  const out: Macro[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const m = asMacro(entry);
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

export function findMacro(id: unknown): Macro | null {
  if (typeof id !== 'string' || !MACRO_ID_PATTERN.test(id)) return null;
  return listMacros().find((m) => m.id === id) ?? null;
}

/**
 * The stored macros, re-read from the rc file first so a mutation starts from what is on disk.
 * ConfigStore.set() silently skips the write when the file cannot be parsed, so an unreadable file
 * is refused here instead of reporting a save that did not happen. (reload() also emits 'error',
 * which throws when nothing listens for it.)
 */
function loadForChange(): Macro[] {
  let readable = false;
  try {
    readable = config.reload();
  } catch {
    readable = false;
  }
  if (!readable) {
    throw new HttpError(500, 'The rc file could not be read, so the macros were not changed. Check the file.');
  }
  return listMacros();
}

function saveMacros(macros: Macro[]): void {
  config.set(MACROS_CONFIG_KEY, macros.map(({ id, name, content, mtime }) => ({ id, name, content, mtime })));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, { 'Cache-Control': 'no-store' }).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, `Request body is larger than ${MAX_BODY_BYTES / 1024} KB`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, `Request body is larger than ${MAX_BODY_BYTES / 1024} KB`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reject(new HttpError(400, 'Expected a JSON object { name, content }'));
        return;
      }
      resolve(body as Record<string, unknown>);
    });
    req.on('error', reject);
  });
}

function validated(body: Record<string, unknown>): { name: string; content: string } {
  const result = validateMacroInput(body.name, body.content);
  if (!result.ok) throw new HttpError(400, result.error);
  return { name: result.name, content: result.content };
}

function assertUniqueName(macros: Macro[], name: string, exceptId?: string): void {
  const lower = name.toLowerCase();
  if (macros.some((m) => m.id !== exceptId && m.name.toLowerCase() === lower)) {
    throw new HttpError(409, `A macro named “${name}” already exists`);
  }
}

async function create(req: http.IncomingMessage): Promise<Macro> {
  const input = validated(await readJson(req));
  // ConfigStore is synchronous, so the read-check-write below cannot interleave with another request.
  const macros = loadForChange();
  if (macros.length >= MACROS_MAX) {
    throw new HttpError(409, `There are already ${MACROS_MAX} macros. Delete one first.`);
  }
  assertUniqueName(macros, input.name);
  let id = crypto.randomBytes(8).toString('hex');
  while (macros.some((m) => m.id === id)) id = crypto.randomBytes(8).toString('hex');
  const macro: Macro = { id, ...input, mtime: Date.now() };
  saveMacros([...macros, macro]);
  return macro;
}

async function update(req: http.IncomingMessage, id: string): Promise<Macro> {
  const input = validated(await readJson(req));
  const macros = loadForChange();
  const current = macros.find((m) => m.id === id);
  if (!current) throw new HttpError(404, 'Macro not found');
  assertUniqueName(macros, input.name, id);
  const macro: Macro = { ...current, ...input, mtime: Date.now() };
  saveMacros(macros.map((m) => (m.id === id ? macro : m)));
  return macro;
}

function remove(id: string): void {
  const macros = loadForChange();
  if (!macros.some((m) => m.id === id)) throw new HttpError(404, 'Macro not found');
  saveMacros(macros.filter((m) => m.id !== id));
}

export async function handleMacros(req: http.IncomingMessage, res: http.ServerResponse, settings: CNCSettings): Promise<void> {
  if (!isAuthorized(req, settings)) {
    req.resume();
    return send(res, 403, { error: 'forbidden' });
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const rest = url.pathname.slice(MACROS_PATH.length).split('/').filter(Boolean);
  const id = rest[0];

  try {
    if (rest.length > 1 || (id !== undefined && !MACRO_ID_PATTERN.test(id))) {
      throw new HttpError(404, 'Macro not found');
    }
    if (id === undefined && req.method === 'GET') return send(res, 200, listMacros());
    if (id === undefined && req.method === 'POST') return send(res, 201, await create(req));
    if (id !== undefined && req.method === 'PUT') return send(res, 200, await update(req, id));
    if (id !== undefined && req.method === 'DELETE') {
      remove(id);
      return send(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    if (err instanceof HttpError) {
      // 413: close the connection after answering instead of reading the rest of the upload.
      if (err.status === 413) res.setHeader('Connection', 'close');
      if (!res.headersSent) send(res, err.status, { error: err.message });
      return;
    }
    console.error('[kinetiq] macros:', err);
    if (!res.headersSent) send(res, 500, { error: 'Macro library error' });
  }
}
