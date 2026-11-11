/**
 * Protocol scenario recorder: verification without tests (README.md in this folder).
 *
 * For each scenario: fresh temp dir → fake controller (scripts/fake-controller.py --trace) → an
 * isolated headless Kinetiq server on its own port → Socket.IO client that does what the UI does →
 * close → `<out>/<scenario>.trace` (everything the backend wrote to the serial port, in order).
 * Compare two recordings with compare.mjs. See README.md.
 *
 *   npm run protocol:record -- [--out DIR] [--port 8077] [--keep] [scenario ...]
 *
 * SAFETY: the user's real machine may be plugged in. This script only ever opens the fake port it
 * started (exact path check), runs its own server on a non-default port with every Kinetiq path
 * (rc file, jobs, config backups, HOME) inside the temp dir, checks the machine is idle before
 * sending anything, and kills every process it started, also on failure or Ctrl-C.
 *
 * The UI's own sequencing code (src/lib/cnc/client.ts, lineSequence.ts, probe.ts,
 * src/lib/leveling/run.ts) depends on the browser store, React and the socket singleton, so it is
 * mirrored here (each mirror names its source). The pure builders are imported as they are:
 * commands.ts (jog lines), heightmap.ts and compensate.ts (leveling).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { goToZeroLines, jogLine, WCS_P } from '../../src/lib/cnc/commands.ts';
import { compensate } from '../../src/lib/leveling/compensate.ts';
import { gridAxis, probeOrder, type HeightMap } from '../../src/lib/leveling/heightmap.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURES = path.join(HERE, 'fixtures');
const FORBIDDEN_PORTS = new Set([8000]); // the user's own Kinetiq server
const BAUDRATE = 115200; // src/lib/cnc/protocol.ts DEFAULT_BAUDRATE
const CLIENT_ID = 'kinetiq-protocol'; // context.__sender__, like client.ts clientId

/* ------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const opt = { out: '', port: 8077, keep: false, only: [] as string[] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opt.out = argv[++i];
  else if (a === '--port') opt.port = Number(argv[++i]);
  else if (a === '--keep') opt.keep = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: npm run protocol:record -- [--out DIR] [--port N] [--keep] [scenario ...]');
    process.exit(0);
  } else if (a.startsWith('-')) {
    console.error(`unknown option ${a}`);
    process.exit(2);
  } else opt.only.push(a);
}
if (!Number.isInteger(opt.port) || opt.port < 1024 || FORBIDDEN_PORTS.has(opt.port)) {
  console.error(`Refusing server port ${opt.port}: use a free port other than ${[...FORBIDDEN_PORTS].join(', ')}`);
  process.exit(2);
}
opt.out = path.resolve(opt.out || path.join(os.tmpdir(), `kinetiq-protocol-${new Date().toISOString().replace(/[:.]/g, '-')}`));

/* ------------------------------------------------------------------------------------------------
 * Processes: every child is tracked and killed (process group) on exit, failure or Ctrl-C
 * ---------------------------------------------------------------------------------------------- */

const children = new Set<ChildProcess>();

function startProcess(cmd: string, args: string[], logFile: string, env: NodeJS.ProcessEnv): ChildProcess {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', out, out], detached: true });
  fs.closeSync(out);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

async function stopProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  signalGroup(child, signal);
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}

process.on('exit', () => children.forEach((c) => signalGroup(c, 'SIGKILL')));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.error(`\n${sig}: stopping`);
    children.forEach((c) => signalGroup(c, 'SIGKILL'));
    process.exit(130);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(check: () => T | null | undefined | false, timeoutMs: number, label: string, stepMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out (${timeoutMs} ms) waiting for ${label}`);
    await sleep(stepMs);
  }
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/* ------------------------------------------------------------------------------------------------
 * Trace follower: the fake writes one line-buffered record per received unit
 * ---------------------------------------------------------------------------------------------- */

interface TraceRecord {
  ms: number;
  text: string;
}

/** Status-poll records the backend sends on its own timer (they interleave with everything). */
const isPoll = (text: string) => text === '<?>' || text === '$G';

class TraceFollower {
  constructor(private file: string) {}

  records(): TraceRecord[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n');
    lines.pop(); // incomplete (or empty) last line
    return lines.map((l) => {
      const tab = l.indexOf('\t');
      return { ms: Number(l.slice(0, tab)), text: l.slice(tab + 1) };
    });
  }

  /** Records that are not status polls. */
  traffic(): TraceRecord[] {
    return this.records().filter((r) => !isPoll(r.text));
  }

  async waitFor(match: (text: string) => boolean, timeoutMs: number, label: string, from = 0): Promise<number> {
    return until(() => {
      const t = this.traffic();
      for (let i = from; i < t.length; i++) if (match(t[i].text)) return i + 1;
      return null;
    }, timeoutMs, `trace: ${label}`, 10);
  }

  /** Waits until no non-poll record has arrived for `quietMs` (the stream is waiting for an ok). */
  async waitQuiet(quietMs: number, timeoutMs: number): Promise<number> {
    let count = -1;
    let since = Date.now();
    return until(() => {
      const n = this.traffic().length;
      if (n !== count) {
        count = n;
        since = Date.now();
        return null;
      }
      return Date.now() - since >= quietMs ? n : null;
    }, timeoutMs, 'a quiet serial stream', 10);
  }

  /** Waits for the next non-poll record after `count` and returns the new count. */
  async waitNext(count: number, timeoutMs: number): Promise<number> {
    return until(() => {
      const n = this.traffic().length;
      return n > count ? n : null;
    }, timeoutMs, 'the next line on the serial port', 5);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Session: one server + socket for one scenario
 * ---------------------------------------------------------------------------------------------- */

interface Status {
  activeState?: string;
  subState?: number;
  mpos?: Record<string, string>;
  wpos?: Record<string, string>;
}

interface ControllerState {
  status?: Status;
  parserstate?: { modal?: Record<string, string> };
}

type Socket = ReturnType<typeof io>;

class Session {
  socket!: Socket;
  token = '';
  workflow = 'idle';
  workflowEvents = 0;
  state: ControllerState = {};
  stateAt = 0;
  sender: { name?: string; total?: number } | null = null;
  private readListeners = new Set<(line: string) => void>();
  private changeListeners = new Set<() => void>();
  private events: fs.WriteStream;

  constructor(
    readonly base: string,
    readonly portPath: string,
    readonly trace: TraceFollower,
    eventLog: string,
  ) {
    this.events = fs.createWriteStream(eventLog);
  }

  get status(): Status {
    return this.state.status ?? {};
  }

  log(...parts: unknown[]): void {
    this.events.write(`${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
  }

  private changed(): void {
    this.changeListeners.forEach((l) => l());
  }

  async connect(): Promise<void> {
    const res = await fetch(`${this.base}/api/kinetiq/session`);
    if (!res.ok) throw new Error(`session request failed (${res.status})`);
    this.token = ((await res.json()) as { token: string }).token;

    // Same path and token handshake as client.ts startClient() (`auth: { token }`), without reconnection.
    this.socket = io(this.base, { path: '/socket.io', auth: { token: this.token }, reconnection: false });
    const s = this.socket;
    s.on('workflow:state', (w: string) => {
      this.workflow = w;
      this.workflowEvents++;
      this.log('workflow:state', w);
      this.changed();
    });
    s.on('controller:state', (_type: string, st: ControllerState) => {
      const prev = this.state.status?.activeState;
      this.state = st;
      this.stateAt = Date.now();
      if (st.status?.activeState !== prev) this.log('activeState', st.status?.activeState, st.status?.subState);
      this.changed();
    });
    s.on('sender:status', (st: { name?: string; total?: number }) => {
      this.sender = st;
      this.changed();
    });
    s.on('serialport:read', (line: unknown) => {
      if (typeof line !== 'string') return;
      this.log('read', line);
      this.readListeners.forEach((l) => l(line));
    });
    s.on('serialport:write', (data: unknown) => this.log('write', data));
    s.on('serialport:error', (e: unknown) => this.log('serialport:error', e));
    s.on('serialport:close', (e: unknown) => this.log('serialport:close', e));

    // startup → list → open (client.ts: 'startup' handler, listPorts, openPort).
    const ports = await new Promise<{ port: string }[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no startup / serialport:list from the server')), 15000);
      s.on('connect_error', (e: Error) => reject(e)); // also a rejected handshake (Socket.IO 4)
      s.once('startup', () => s.emit('list'));
      s.once('serialport:list', (list: { port: string }[]) => {
        clearTimeout(timer);
        resolve(list);
      });
    });
    const entry = ports.find((p) => p.port === this.portPath);
    // SAFETY: only the fake port this run created, compared as an exact path.
    if (!entry || entry.port !== this.portPath) throw new Error(`the fake port ${this.portPath} is not in the server's port list`);
    const target = fs.realpathSync(this.portPath);
    if (!/^\/dev\/ttys\d+$|^\/dev\/pts\/\d+$/.test(target)) throw new Error(`${this.portPath} -> ${target} is not a pseudo-terminal`);
    await new Promise<void>((resolve, reject) => {
      s.emit('open', entry.port, { controllerType: 'Grbl', baudrate: BAUDRATE }, (err: unknown) =>
        err ? reject(new Error(`open failed: ${JSON.stringify(err)}`)) : resolve(),
      );
    });
  }

  /** SAFETY gate before the first command: idle workflow, no program, controller in an allowed state. */
  async checkReady(allowed: string[]): Promise<void> {
    await this.waitFor(() => !!this.status.activeState, 15000, 'the first status report');
    await sleep(300); // let the `$$` the backend sends on its first status report go out first
    if (this.workflow !== 'idle') throw new Error(`workflow is ${this.workflow}, expected idle`);
    if (this.sender?.name || this.sender?.total) throw new Error('a program is already loaded');
    const active = this.status.activeState ?? '';
    if (!allowed.includes(active)) throw new Error(`controller is ${active}, expected ${allowed.join(' or ')}`);
  }

  waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        clearInterval(poll);
        this.changeListeners.delete(test);
        if (err) reject(err);
        else resolve();
      };
      const test = () => {
        if (check()) done();
      };
      const timer = setTimeout(() => done(new Error(`Timed out (${timeoutMs} ms) waiting for ${label} (state ${this.status.activeState}, workflow ${this.workflow})`)), timeoutMs);
      const poll = setInterval(test, 50);
      this.changeListeners.add(test);
      test();
    });
  }

  /** Waits until `check` has held for `stableMs` (status reports arrive every 250 ms). */
  async waitStable(check: () => boolean, stableMs: number, timeoutMs: number, label: string): Promise<void> {
    let since = 0;
    await until(() => {
      if (!check()) {
        since = 0;
        return false;
      }
      if (!since) since = Date.now();
      return Date.now() - since >= stableMs;
    }, timeoutMs, label);
  }

  waitIdle(timeoutMs = 30000, state = 'Idle'): Promise<void> {
    return this.waitStable(() => this.status.activeState === state, 750, timeoutMs, `${state} (settled)`);
  }

  waitWorkflow(w: string, timeoutMs = 60000): Promise<void> {
    return this.waitFor(() => this.workflow === w, timeoutMs, `workflow ${w}`);
  }

  /** Next serialport:read line that matches. Subscribe before the action that causes it. */
  nextRead(match: (line: string) => boolean, timeoutMs: number, label: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const listener = (line: string) => {
        if (!match(line.trim())) return;
        clearTimeout(timer);
        this.readListeners.delete(listener);
        resolve(line.trim());
      };
      const timer = setTimeout(() => {
        this.readListeners.delete(listener);
        reject(new Error(`Timed out (${timeoutMs} ms) waiting for ${label}`));
      }, timeoutMs);
      this.readListeners.add(listener);
    });
  }

  onRead(listener: (line: string) => void): () => void {
    this.readListeners.add(listener);
    return () => this.readListeners.delete(listener);
  }

  // client.ts sendCommand / sendGcode / sendLine / sendOverride
  command(cmd: string, ...args: unknown[]): void {
    this.log('command', cmd, ...args);
    this.socket.emit('command', this.portPath, cmd, ...args);
  }

  gcode(line: string): void {
    this.command('gcode', line, { __sender__: CLIENT_ID });
  }

  writeln(line: string): void {
    this.log('writeln', line);
    this.socket.emit('writeln', this.portPath, line, { __sender__: CLIENT_ID });
  }

  /** client.ts loadProgram; resolves with the program text the backend broadcasts (incl. its %wait). */
  load(name: string, gcode: string, context: Record<string, unknown> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gcode:load timed out')), 10000);
      this.socket.once('gcode:load', (_name: string, text: string) => {
        clearTimeout(timer);
        resolve(text);
      });
      this.log('command', 'gcode:load', name);
      this.socket.emit('command', this.portPath, 'gcode:load', name, gcode, context, (err: unknown) => {
        if (err) {
          clearTimeout(timer);
          reject(new Error(`gcode:load rejected: ${JSON.stringify(err)}`));
        }
      });
    });
  }

  async http(method: string, route: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, unknown>;
    this.log('http', method, route, res.status);
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    if (this.socket.connected) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        this.socket.emit('close', this.portPath, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.socket.close();
    this.events.end();
  }
}

/* ------------------------------------------------------------------------------------------------
 * Mirrors of the UI's step-by-step sequences
 * ---------------------------------------------------------------------------------------------- */

class StepError extends Error {}

/**
 * src/lib/cnc/lineSequence.ts sendStep(): one line through the Feeder, resolved on its `ok`; fails on
 * error:N, ALARM:N or a probe report without contact. (The UI's timeouts only matter for a stuck machine.)
 */
function sendStep(s: Session, line: string, probe = false): Promise<{ x: number; y: number; z: number } | null> {
  return new Promise((resolve, reject) => {
    let contact: { x: number; y: number; z: number } | null = null;
    let touched = false;
    const stop = (err: Error | null) => {
      clearTimeout(timer);
      unsubscribe();
      if (err) reject(err);
      else resolve(contact);
    };
    const unsubscribe = s.onRead((raw) => {
      const l = raw.trim();
      const prb = /^\[PRB:([^:\]]+):(\d)\]/.exec(l);
      if (prb) {
        touched = prb[2] === '1';
        const [x, y, z] = prb[1].split(',').map(Number);
        contact = [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
        if (!touched) stop(new StepError(`${line}: the probe did not touch`));
        return;
      }
      if (l === 'ok') {
        if (probe && (!touched || !contact)) stop(new StepError(`${line}: no contact was reported`));
        else stop(null);
        return;
      }
      if (/^error:/i.test(l) || /^ALARM:/i.test(l)) stop(new StepError(`${line} failed: ${l}`));
    });
    const timer = setTimeout(() => stop(new Error(`${line}: no reply in 60 s`)), 60000);
    s.gcode(line);
  });
}

const n3 = (v: number) => Number(v.toFixed(3)).toString(); // probe.ts / run.ts n()

/** lineSequence.ts restoreModalLine */
const restoreModalLine = (distance?: string, units?: string) => `${distance === 'G91' ? 'G91' : 'G90'}${units === 'G20' ? ' G20' : ' G21'}`;

/** probe.ts DEFAULT_PROBE_SETTINGS with a plate thickness entered. */
const PROBE = { maxTravel: 25, fastFeed: 100, slowFeed: 25, backoff: 2, retract: 5 };

/** Modal state the UI reads from the `$G` reply (controller.state.parserstate.modal). */
async function modal(s: Session): Promise<Record<string, string>> {
  await s.waitFor(() => !!s.state.parserstate?.modal?.distance, 10000, 'the parser state ($G)');
  return s.state.parserstate!.modal!;
}

/**
 * probe.ts runProbe() / buildSteps(). On failure the UI immediately sends the restore line unless the
 * last status says Alarm; here the decision waits 750 ms (three status polls) so it does not depend on
 * whether a status report arrived between the ALARM line and the check.
 */
async function runProbe(s: Session, thickness: number): Promise<number | null> {
  const m = await modal(s);
  const steps: { line: string; probe?: boolean }[] = [
    { line: 'G21 G91' },
    { line: `G38.2 Z-${n3(PROBE.maxTravel)} F${n3(PROBE.fastFeed)}`, probe: true },
    { line: `G0 Z${n3(PROBE.backoff)}` },
    { line: `G38.2 Z-${n3(PROBE.backoff + 1)} F${n3(PROBE.slowFeed)}`, probe: true },
    { line: 'G90' },
    { line: `G10 L20 P${WCS_P[m.wcs || 'G54'] ?? 1} Z${n3(thickness)}` },
    { line: `G91 G0 Z${n3(PROBE.retract)}` },
    { line: restoreModalLine(m.distance || 'G90', m.units || 'G21') },
  ];
  let contactZ: number | null = null;
  for (let i = 0; i < steps.length; i++) {
    try {
      const contact = await sendStep(s, steps[i].line, steps[i].probe);
      if (steps[i].probe && contact) contactZ = contact.z;
    } catch (err) {
      if (!(err instanceof StepError)) throw err;
      s.log('probe failed:', err.message);
      await sleep(750);
      if (i > 0 && s.status.activeState !== 'Alarm') s.gcode(steps[steps.length - 1].line);
      return null;
    }
  }
  return contactZ;
}

/** derive.ts workOffset() */
function workOffset(s: Session): { x: number; y: number; z: number } {
  const st = s.status;
  const off = (a: 'x' | 'y' | 'z') => Number(st.mpos?.[a]) - Number(st.wpos?.[a]);
  return { x: off('x'), y: off('y'), z: off('z') };
}

/** src/lib/leveling/run.ts runLeveling() line sequence; returns the map the UI would store. */
async function runLeveling(s: Session, plan: { xMin: number; xMax: number; yMin: number; yMax: number; nx: number; ny: number; clearance: number; depth: number; feed: number }): Promise<HeightMap> {
  const m = await modal(s);
  const wco = workOffset(s);
  // heightmap.ts emptyMap() with a fixed id and time so the leveled program is the same every run.
  const xs = gridAxis(plan.xMin, plan.xMax, plan.nx);
  const ys = gridAxis(plan.yMin, plan.yMax, plan.ny);
  const map: HeightMap = {
    version: 1,
    id: 'protocol-scenario',
    createdAt: 0,
    wcs: m.wcs || 'G54',
    wco,
    xs,
    ys,
    z: ys.map(() => xs.map(() => null)),
    probe: { clearance: plan.clearance, depth: plan.depth, feed: plan.feed },
  };
  await sendStep(s, 'G21 G90');
  await sendStep(s, `G0 Z${n3(plan.clearance)}`);
  for (const { i, j } of probeOrder(plan.nx, plan.ny)) {
    await sendStep(s, `G0 X${n3(xs[i])} Y${n3(ys[j])}`);
    const contact = await sendStep(s, `G38.2 Z-${n3(plan.depth)} F${n3(plan.feed)}`, true);
    const contactZ = contact!.z - wco.z;
    if (!Number.isFinite(contactZ) || contactZ > plan.clearance + 0.01 || contactZ < -plan.depth - 0.01) {
      throw new Error(`leveling: contact height ${contactZ} outside the probed range`);
    }
    map.z[j][i] = Math.round(contactZ * 1000) / 1000;
    await sendStep(s, `G0 Z${n3(plan.clearance)}`);
  }
  await sendStep(s, restoreModalLine(m.distance, m.units));
  return map;
}

/** client.ts stopJob(): pause → Hold:0 (or settled Idle) → gcode:stop {force:true}. */
async function stopJob(s: Session): Promise<void> {
  const startedAt = Date.now();
  if (s.workflow === 'running') s.command('gcode:pause');
  await s.waitFor(() => {
    const st = s.status;
    const holdComplete = st.activeState === 'Hold' && st.subState === 0;
    const settled = s.workflow === 'paused' && Date.now() - startedAt >= 750;
    return holdComplete || (settled && (st.activeState === 'Idle' || st.activeState === 'Alarm'));
  }, 15000, 'Hold:0 before stopping');
  s.command('gcode:stop', { force: true });
}

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/**
 * Lines reach the controller in a burst at job start, then one per completed move (the planner
 * queue is full). Waiting for that steady state and then for the next line gives a point in the
 * stream that is the same in every run, with a whole move (0.5 s) to act before the next line.
 */
async function nextQuietPoint(s: Session): Promise<void> {
  const count = await s.trace.waitQuiet(300, 20000);
  await s.trace.waitNext(count, 20000);
}

/* ------------------------------------------------------------------------------------------------
 * Scenarios
 * ---------------------------------------------------------------------------------------------- */

interface Scenario {
  description: string;
  fakeArgs?: string[];
  allowedStart?: string[];
  /** Run the server with Kinetiq travel limits on (default off: the fake is not that machine). */
  travelLimits?: boolean;
  run(s: Session): Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  '01-connect-idle': {
    description: 'connect and stay idle for 10 s (status / $G polling cadence)',
    async run() {
      await sleep(10000);
    },
  },

  '02-jog': {
    description: 'jog X/Y/Z, go to zero, then a long jog cancelled with jog cancel',
    async run(s) {
      // PositionPanel onJog → sendGcode(jogLine(...)), one click at a time.
      for (const [axis, dir] of [['X', 1], ['Y', 1], ['Z', -1], ['X', -1]] as const) {
        const ok = s.nextRead((l) => l === 'ok' || /^error:/.test(l), 10000, `ok for jog ${axis}`);
        s.gcode(jogLine(axis, dir, 10, 1000, 'mm'));
        await ok;
        await s.waitIdle();
      }
      // PositionPanel onGoZero: both lines queued at once (work Z is below 0 → Z first).
      for (const line of goToZeroLines(true, -10, 1000, 'mm')) s.gcode(line);
      await s.trace.waitFor((t) => t === '$J=G90 G21 X0 Y0 F1000', 10000, 'go-to-zero XY line');
      await s.waitIdle();
      // A long jog, cancelled while it runs (PositionPanel jog cancel button → jogCancel).
      s.gcode(jogLine('X', 1, 100, 500, 'mm'));
      await s.waitFor(() => s.status.activeState === 'Jog', 10000, 'Jog');
      s.command('jogCancel');
      await s.waitIdle();
    },
  },

  '03-job-m0-m6-hold': {
    description: 'job with M0 and M6 (resume each), Hold / Resume on the last move, finish',
    async run(s) {
      await s.load('job-m0-m6.nc', fixture('job-m0-m6.nc'));
      s.command('gcode:start');
      await s.waitWorkflow('running');
      // M0: the sender holds after the M0 line; the UI shows Resume (JobPanel → gcode:resume).
      await s.waitWorkflow('paused');
      await s.trace.waitFor((t) => t.startsWith('M0'), 10000, 'M0 line');
      await s.waitIdle();
      s.command('gcode:resume');
      await s.waitWorkflow('running');
      // M6: manual tool change pause, same Resume.
      await s.waitWorkflow('paused');
      await s.waitIdle();
      s.command('gcode:resume');
      await s.waitWorkflow('running');
      // Every line is sent once the %wait dwell is out; the long X40 move is still running.
      await s.trace.waitFor((t) => t === 'G4 P0.5', 20000, '%wait dwell');
      await s.waitFor(() => s.status.activeState === 'Run', 5000, 'Run');
      s.command('gcode:pause'); // JobPanel Pause
      await s.waitFor(() => s.status.activeState === 'Hold' && s.status.subState === 0, 10000, 'Hold:0');
      await sleep(500);
      s.command('gcode:resume'); // JobPanel Resume
      await s.waitWorkflow('idle', 60000);
      await s.waitIdle();
    },
  },

  '04-job-stop': {
    description: 'long job stopped mid-way with the UI stop sequence (pause, Hold:0, gcode:stop force)',
    async run(s) {
      await s.load('job-long.nc', fixture('job-long.nc'));
      s.command('gcode:start');
      await s.waitWorkflow('running');
      await nextQuietPoint(s);
      await stopJob(s);
      await s.trace.waitFor((t) => t === '<0x18>', 5000, 'soft reset');
      await s.waitWorkflow('idle');
      await s.waitIdle();
    },
  },

  '05-overrides': {
    description: 'feed / spindle overrides (+10, -10, +1, -1, reset) while the long job streams',
    async run(s) {
      await s.load('job-long.nc', fixture('job-long.nc'));
      s.command('gcode:start');
      await s.waitWorkflow('running');
      // Overrides.tsx sendOverride(kind, step), clicked in three quiet windows.
      const windows: [string, number][][] = [
        [['feedOverride', 10], ['feedOverride', 10], ['spindleOverride', 10]],
        [['feedOverride', -10], ['spindleOverride', -10], ['feedOverride', 1], ['feedOverride', -1], ['spindleOverride', 1], ['spindleOverride', -1]],
        [['feedOverride', 0], ['spindleOverride', 0]],
      ];
      let count = await s.trace.waitQuiet(300, 20000);
      for (const clicks of windows) {
        count = await s.trace.waitNext(count, 20000);
        for (const [cmd, step] of clicks) s.command(cmd, step);
        // The override bytes are records too: count from after them (the next line is ~0.4 s away).
        await sleep(100);
        count = s.trace.traffic().length;
      }
      await s.waitWorkflow('idle', 60000);
      await s.waitIdle();
    },
  },

  '06-alarm-unlock-home': {
    description: 'start in Alarm (--alarm), Unlock, Home',
    fakeArgs: ['--alarm'],
    allowedStart: ['Alarm'],
    async run(s) {
      let ok = s.nextRead((l) => l === 'ok', 10000, 'ok for $X');
      s.command('unlock'); // MachineControls Unlock
      await ok;
      await s.waitIdle();
      ok = s.nextRead((l) => l === 'ok', 15000, 'ok for $H');
      s.command('homing'); // MachineControls Home
      await ok;
      await s.waitIdle();
    },
  },

  '07-probe-z': {
    description: 'Z probe with a touch plate (probe.ts sequence), plate 1.5 mm',
    async run(s) {
      const z = await runProbe(s, 1.5);
      if (z === null) throw new Error('probe failed');
      await s.waitIdle();
    },
  },

  '07-probe-miss': {
    description: 'Z probe that never touches (--probe-miss): ALARM:5, then Unlock',
    fakeArgs: ['--probe-miss'],
    async run(s) {
      const z = await runProbe(s, 1.5);
      if (z !== null) throw new Error('probe unexpectedly touched');
      await s.waitIdle(10000, 'Alarm');
      const ok = s.nextRead((l) => l === 'ok', 10000, 'ok for $X');
      s.command('unlock');
      await ok;
      await s.waitIdle();
    },
  },

  '08-settings-editor': {
    description: 'settings editor HTTP API: read config, save (XModem, exclusive mode), restart',
    async run(s) {
      const snap = await s.http('GET', '/api/kinetiq/machine-config');
      const saved = String(snap.saved);
      const text = saved.replace('max_rate_mm_per_min: 5000.000', 'max_rate_mm_per_min: 4000.000');
      if (text === saved) throw new Error('fixture edit did not apply');
      await s.http('PUT', '/api/kinetiq/machine-config', { text, baseSha256: snap.savedSha256 });
      await s.http('POST', '/api/kinetiq/machine-config/restart');
      await s.waitIdle();
      const after = await s.http('GET', '/api/kinetiq/machine-config');
      if (!String(after.running).includes('max_rate_mm_per_min: 4000.000')) throw new Error('restart did not load the saved config');
    },
  },

  '09-leveling': {
    description: 'Z probe (plate 0), 3x3 height map over 20x20 mm, compensated job',
    async run(s) {
      if ((await runProbe(s, 0)) === null) throw new Error('probe failed');
      // The new work offset must be in the status before the map captures it.
      await s.waitStable(() => Math.abs(workOffset(s).z) > 1, 750, 10000, 'the new work Z offset');
      const map = await runLeveling(s, { xMin: 0, xMax: 20, yMin: 0, yMax: 20, nx: 3, ny: 3, clearance: 2, depth: 1, feed: 50 });
      await s.waitIdle();
      // LevelingWorkspace: load the job, compensate the loaded program text, load the leveled program.
      const loaded = await s.load('job-level.nc', fixture('job-level.nc'));
      const result = compensate(loaded, map);
      if (!result.ok) throw new Error(`compensation failed: ${result.errors.join('; ')}`);
      await s.load('job-level (leveled).nc', result.gcode, {
        kinetiqLeveling: { mapId: map.id, wcs: map.wcs, wco: map.wco, sourceName: 'job-level.nc' },
      });
      s.command('gcode:start');
      await s.waitWorkflow('running');
      await s.waitWorkflow('idle', 120000);
      await s.waitIdle();
    },
  },

  '10-travel-limits': {
    description: 'travel limits: jogs blocked until homed, then shortened or blocked at the envelope',
    travelLimits: true,
    async run(s) {
      const blocked = (label: string) => s.nextRead((l) => l.startsWith('[MSG:WARN: Kinetiq: jog not sent'), 5000, `blocked: ${label}`);
      const sent = (label: string) => s.nextRead((l) => l === 'ok' || /^error:/.test(l), 10000, `ok for ${label}`);
      const jog = async (axis: 'X' | 'Y' | 'Z', dir: 1 | -1, step: number, expect: 'sent' | 'blocked') => {
        const label = `jog ${axis}${dir * step}`;
        const done = expect === 'sent' ? sent(label) : blocked(label);
        s.gcode(jogLine(axis, dir, step, 1000, 'mm'));
        await done;
        await s.waitIdle();
      };
      // Not homed: X and Y do not move, Z (not limited) does.
      await jog('X', -1, 10, 'blocked');
      await jog('Z', -1, 5, 'sent');
      // Home ($H → Home → Idle): X and Y are homed at machine 0, 0.
      const homed = s.nextRead((l) => l === 'ok', 15000, 'ok for $H');
      s.command('homing');
      await homed;
      await s.waitIdle();
      await sleep(600); // a status report after the cycle, so the backend has seen Idle
      await jog('X', -1, 150, 'sent'); // inside
      await jog('X', -1, 100, 'sent'); // shortened to the far limit
      await jog('X', -1, 10, 'blocked'); // at the limit
      await jog('Y', -1, 10, 'blocked'); // towards the home switch
      await jog('Y', 1, 10, 'sent');
      // Two presses queued at once: the second starts where the first will end.
      const second = s.trace.waitFor((t) => t === '$J=G53 G90 G21 X0 F1000', 15000, 'second queued jog, shortened');
      s.gcode(jogLine('X', 1, 100, 1000, 'mm'));
      s.gcode(jogLine('X', 1, 100, 1000, 'mm'));
      await second;
      await s.waitIdle();
      // A jog typed in the console (writeln) is limited too.
      const typed = sent('console jog');
      s.writeln('$J=G91 G21 Y500 F3000');
      await typed;
      await s.waitIdle();
    },
  },

  '11-macros': {
    description: 'macros: create over HTTP, run refused during a job, run (a second run refused while it sends), run of a deleted macro refused',
    async run(s) {
      const content = ['G21 G91', 'G0 X5 Y5', '%step = 2.5', 'G0 X[step] Y[-step]', '$J=G91 G21 Z-1 F600', 'G90'].join('\n');
      const macro = await s.http('POST', '/api/kinetiq/macros', { name: 'Protocol macro', content });
      const id = String(macro.id);
      const list = (await s.http('GET', '/api/kinetiq/macros')) as unknown as { id: string }[];
      if (!Array.isArray(list) || list.length !== 1 || list[0].id !== id) throw new Error('macro list does not hold the new macro');
      // MacrosWidget Run → client.ts runMacro(id): only the id goes over the socket.
      const run = () => s.command('macro:run', id, { __sender__: CLIENT_ID });
      const refused = (why: string) => s.nextRead((l) => l.startsWith('[MSG:WARN: Kinetiq: macro') && l.includes(why), 5000, `macro refused: ${why}`);

      // Refused while a job is paused at M0 (nothing reaches the port), then the job is stopped.
      await s.load('job-m0-m6.nc', fixture('job-m0-m6.nc'));
      s.command('gcode:start');
      await s.waitWorkflow('running');
      await s.waitWorkflow('paused');
      await s.trace.waitFor((t) => t.startsWith('M0'), 10000, 'M0 line');
      await s.waitIdle();
      let refusal = refused('A job is running or paused');
      run();
      await refusal;
      await stopJob(s);
      await s.waitWorkflow('idle');
      await s.waitIdle();

      // Run: the lines go out one at a time through the Feeder ([step] evaluated, $J= through
      // TravelGuard, off here). A second Run clicked at once is refused: the first is still sending.
      const started = s.nextRead((l) => l.startsWith('[MSG:INFO: Kinetiq: running macro'), 5000, 'macro started');
      refusal = refused('Earlier commands are still being sent');
      run();
      run();
      await started;
      await refusal;
      await s.trace.waitFor((t) => t === 'G90', 15000, 'last macro line');
      await s.waitIdle();

      // Deleted (e.g. in another tab): refused by id.
      const del = await fetch(`${s.base}/api/kinetiq/macros/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${s.token}` } });
      s.log('http', 'DELETE', `/api/kinetiq/macros/${id}`, del.status);
      if (del.status !== 204) throw new Error(`DELETE macro → ${del.status}`);
      refusal = refused('no longer exists');
      run();
      await refusal;
      await sleep(500);
    },
  },
};

/* ------------------------------------------------------------------------------------------------
 * Runner
 * ---------------------------------------------------------------------------------------------- */

async function runScenario(name: string, sc: Scenario): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kinetiq-protocol-${name}-`));
  const link = path.join(tmp, 'fake0');
  const rc = path.join(tmp, 'kinetiq.rc');
  const traceFile = path.join(tmp, 'serial.trace');
  fs.mkdirSync(path.join(tmp, 'home'));
  let fake: ChildProcess | null = null;
  let server: ChildProcess | null = null;
  let session: Session | null = null;
  let ok = false;
  const t0 = Date.now();
  try {
    fake = startProcess('python3', [path.join(ROOT, 'scripts/fake-controller.py'), '--link', link, '--rc', rc, '--trace', traceFile, ...(sc.fakeArgs ?? [])], path.join(tmp, 'fake.log'), process.env);
    await until(() => fs.existsSync(link) && fs.existsSync(rc) && fs.existsSync(traceFile), 10000, 'the fake controller');

    if (await portInUse(opt.port)) throw new Error(`port ${opt.port} is already in use; pass --port with a free port`);
    server = startProcess(process.execPath, ['--import', 'tsx', 'server.ts'], path.join(tmp, 'server.log'), {
      ...process.env,
      NODE_ENV: 'development',
      HOME: path.join(tmp, 'home'), // nothing can reach ~/.kinetiq or ~/.kinetiqrc
      KINETIQ_HEADLESS: '1',
      KINETIQ_HOST: '127.0.0.1',
      KINETIQ_PORT: String(opt.port),
      KINETIQ_RC: rc,
      KINETIQ_JOBS_DIR: path.join(tmp, 'jobs'),
      KINETIQ_CONFIG_BACKUP_DIR: path.join(tmp, 'config-backups'),
      KINETIQ_LOG_LEVEL: process.env.KINETIQ_LOG_LEVEL || 'info',
      KINETIQ_TRAVEL_LIMITS: sc.travelLimits ? 'on' : 'off',
    });
    await until(() => fs.readFileSync(path.join(tmp, 'server.log'), 'utf8').includes('Kinetiq ready') || (server!.exitCode !== null && 'exited'), 60000, 'the server').then((v) => {
      if (v === 'exited') throw new Error('the server exited during startup (see server.log)');
    });

    session = new Session(`http://127.0.0.1:${opt.port}`, link, new TraceFollower(traceFile), path.join(tmp, 'events.log'));
    await session.connect();
    await session.checkReady(sc.allowedStart ?? ['Idle']);
    await sc.run(session);
    ok = true;
  } finally {
    await session?.close().catch(() => undefined);
    if (server) await stopProcess(server, 'SIGTERM');
    if (fake) await stopProcess(fake, 'SIGINT');
    if (fs.existsSync(traceFile)) fs.copyFileSync(traceFile, path.join(opt.out, `${name}.trace`));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (ok && !opt.keep) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`    logs kept in ${tmp}`);
    console.log(`  ${ok ? 'done' : 'FAILED'} ${name} (${secs} s)`);
  }
}

const names = opt.only.length ? opt.only : Object.keys(SCENARIOS);
for (const n of names) {
  if (!SCENARIOS[n]) {
    console.error(`unknown scenario ${n}; known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
}
fs.mkdirSync(opt.out, { recursive: true });
console.log(`Recording ${names.length} scenario(s) into ${opt.out}`);
let failed = 0;
for (const n of names) {
  console.log(`- ${n}: ${SCENARIOS[n].description}`);
  try {
    await runScenario(n, SCENARIOS[n]);
  } catch (err) {
    failed++;
    console.error(`    ${err instanceof Error ? err.message : err}`);
  }
}
console.log(failed ? `${failed} scenario(s) failed` : `All traces written to ${opt.out}`);
process.exit(failed ? 1 : 0);
