/**
 * Kinetiq job library: uploaded G-code files plus their recent-run history.
 *
 *   GET    /api/kinetiq/jobs            → JobRecord[] (most recent first)
 *   POST   /api/kinetiq/jobs?name=<n>   → JobRecord   (body: the G-code as text/plain)
 *   GET    /api/kinetiq/jobs/<id>/gcode → text/plain
 *   PATCH  /api/kinetiq/jobs/<id>       → JobRecord   (body: { touch?: true, lastRun?: JobRun })
 *   DELETE /api/kinetiq/jobs/<id>       → 204
 *
 * Files live in ~/.kinetiq/jobs (override: KINETIQ_JOBS_DIR) as <id>.nc plus index.json.
 * Requests need a loopback Host and the session JWT (same token the Socket.IO handshake uses).
 * Loading a job onto the controller is still the CNCjs `gcode:load` command, issued by the client.
 *
 * SERVER-ONLY. See docs/API_REFERENCE.md §7.4.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { CNCSettings } from './backend';
import { isAuthorized } from './session';

export const JOBS_PATH = '/api/kinetiq/jobs';

export const MAX_JOB_BYTES = 50 * 1024 * 1024;
const MAX_RECORDS = 50;
const ALLOWED_EXTENSIONS = new Set(['.nc', '.gcode', '.gc', '.ngc', '.tap', '.cnc', '.txt']);

export type JobRunStatus = 'completed' | 'cancelled' | 'error';

export interface JobRun {
  status: JobRunStatus;
  startedAt: number;
  endedAt: number;
}

export interface JobRecord {
  id: string;
  name: string;
  size: number; // bytes
  lines: number; // non-empty lines (the controller appends one %wait line)
  sha256: string;
  uploadedAt: number;
  lastUsedAt: number; // last upload or load
  lastRun: JobRun | null;
}

const jobsDir = path.resolve(process.env.KINETIQ_JOBS_DIR || path.join(os.homedir(), '.kinetiq', 'jobs'));
const indexFile = path.join(jobsDir, 'index.json');
const gcodeFile = (id: string) => path.join(jobsDir, `${id}.nc`);

let index: JobRecord[] | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Serialises every index mutation so concurrent requests cannot interleave writes. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function loadIndex(): Promise<JobRecord[]> {
  if (index) {
    return index;
  }
  await fs.mkdir(jobsDir, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    index = Array.isArray(parsed) ? (parsed as JobRecord[]) : [];
  } catch {
    index = [];
  }
  return index;
}

async function saveIndex(records: JobRecord[]): Promise<void> {
  const tmp = `${indexFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  await fs.rename(tmp, indexFile);
  index = records;
}

const sortRecent = (records: JobRecord[]) => [...records].sort((a, b) => b.lastUsedAt - a.lastUsedAt);

function countLines(gcode: string): number {
  let n = 0;
  for (const line of gcode.split('\n')) {
    if (line.trim() !== '') n++;
  }
  return n;
}

function sanitizeName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  return base.slice(0, 200);
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, { 'Cache-Control': 'no-store' }).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function fail(res: http.ServerResponse, status: number, error: string): void {
  send(res, status, { error });
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function upload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const name = sanitizeName(url.searchParams.get('name') || '');
  if (!name) {
    return fail(res, 400, 'A file name is required');
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    return fail(res, 415, `Unsupported file type. Use ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }
  const body = await readBody(req, MAX_JOB_BYTES);
  const gcode = body.toString('utf8');
  const lines = countLines(gcode);
  if (lines === 0) {
    return fail(res, 422, 'The file is empty');
  }
  if (body.includes(0)) {
    return fail(res, 422, 'This looks like a binary file, not G-code');
  }
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  const record = await exclusive(async () => {
    const records = await loadIndex();
    const now = Date.now();
    // Re-uploading the same file keeps its history instead of duplicating it.
    const existing = records.find((r) => r.name === name && r.sha256 === sha256);
    if (existing) {
      const updated = { ...existing, lastUsedAt: now };
      await saveIndex(records.map((r) => (r.id === existing.id ? updated : r)));
      return updated;
    }
    const created: JobRecord = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      size: body.length,
      lines,
      sha256,
      uploadedAt: now,
      lastUsedAt: now,
      lastRun: null,
    };
    await fs.writeFile(gcodeFile(created.id), body, { mode: 0o600 });
    const sorted = sortRecent([created, ...records]);
    const kept = sorted.slice(0, MAX_RECORDS);
    await saveIndex(kept);
    await Promise.all(sorted.slice(MAX_RECORDS).map((r) => fs.rm(gcodeFile(r.id), { force: true })));
    return created;
  });
  send(res, 201, record);
}

function isRun(value: unknown): value is JobRun {
  const run = value as JobRun;
  return (
    !!run &&
    ['completed', 'cancelled', 'error'].includes(run.status) &&
    Number.isFinite(run.startedAt) &&
    Number.isFinite(run.endedAt)
  );
}

async function update(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  let patch: { touch?: boolean; lastRun?: unknown };
  try {
    patch = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
  } catch {
    return fail(res, 400, 'Invalid JSON');
  }
  if (patch.lastRun !== undefined && !isRun(patch.lastRun)) {
    return fail(res, 400, 'Invalid lastRun');
  }
  const record = await exclusive(async () => {
    const records = await loadIndex();
    const current = records.find((r) => r.id === id);
    if (!current) return null;
    const updated: JobRecord = {
      ...current,
      lastUsedAt: patch.touch ? Date.now() : current.lastUsedAt,
      lastRun: patch.lastRun !== undefined ? (patch.lastRun as JobRun) : current.lastRun,
    };
    await saveIndex(records.map((r) => (r.id === id ? updated : r)));
    return updated;
  });
  if (!record) return fail(res, 404, 'Job not found');
  send(res, 200, record);
}

async function remove(res: http.ServerResponse, id: string): Promise<void> {
  const found = await exclusive(async () => {
    const records = await loadIndex();
    if (!records.some((r) => r.id === id)) return false;
    await saveIndex(records.filter((r) => r.id !== id));
    await fs.rm(gcodeFile(id), { force: true });
    return true;
  });
  if (!found) return fail(res, 404, 'Job not found');
  send(res, 204);
}

async function readGcode(res: http.ServerResponse, id: string): Promise<void> {
  const records = await loadIndex();
  if (!records.some((r) => r.id === id)) return fail(res, 404, 'Job not found');
  let body: Buffer;
  try {
    body = await fs.readFile(gcodeFile(id));
  } catch {
    return fail(res, 410, 'The file for this job is missing');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export async function handleJobs(req: http.IncomingMessage, res: http.ServerResponse, settings: CNCSettings): Promise<void> {
  if (!isAuthorized(req, settings)) {
    return fail(res, 403, 'forbidden');
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const rest = url.pathname.slice(JOBS_PATH.length).split('/').filter(Boolean);
  const id = rest[0];
  if (id !== undefined && !/^[a-f0-9]{16}$/.test(id)) {
    return fail(res, 404, 'Job not found');
  }

  try {
    if (rest.length === 0 && req.method === 'GET') {
      return send(res, 200, sortRecent(await loadIndex()));
    }
    if (rest.length === 0 && req.method === 'POST') {
      return await upload(req, res, url);
    }
    if (rest.length === 2 && rest[1] === 'gcode' && req.method === 'GET') {
      return await readGcode(res, id);
    }
    if (rest.length === 1 && req.method === 'PATCH') {
      return await update(req, res, id);
    }
    if (rest.length === 1 && req.method === 'DELETE') {
      return await remove(res, id);
    }
    fail(res, 405, 'Method not allowed');
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 413) {
      return fail(res, 413, `File is larger than ${MAX_JOB_BYTES / 1024 / 1024} MB`);
    }
    console.error('[kinetiq] jobs:', err);
    if (!res.headersSent) fail(res, 500, 'Job library error');
  }
}
