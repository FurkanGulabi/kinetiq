'use client';

/**
 * The single Socket.IO connection to the embedded CNCjs backend.
 * Emits only verified events (docs/API_REFERENCE.md §2) and reduces server events into the store.
 * Policy (what is allowed when) lives in derive.ts, never here.
 */
import io, { type Socket } from 'socket.io-client';
import { DEFAULT_BAUDRATE, type OpenOptions, type ServerEvents } from './protocol';
import { consoleRead, consoleWrite } from './console-store';
import { getState, resetMachineState, setState, subscribe, type ProgramLeveling } from './store';

const SESSION_URL = '/api/kinetiq/session';
const FIRMWARE_PATTERN = /FluidNC v(\d+(?:\.\d+)+[\w.-]*?)(?=[\s:\]]|$)/;
const PREFS_KEY = 'kinetiq.connection';

let socket: Socket | null = null;
let started = false;
let tokenRetried = false;
let sessionToken: string | null = null;

/** Stable per-tab id, used as `context.__sender__` so the console can recognise its own echoes. */
export const clientId = `kinetiq-${Math.random().toString(36).slice(2, 10)}`;

interface ConnectionPrefs {
  port?: string;
  baudrate?: number;
}

export function loadPrefs(): ConnectionPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as ConnectionPrefs;
  } catch {
    return {};
  }
}

function savePrefs(prefs: ConnectionPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...prefs }));
  } catch {
    // Storage unavailable: preferences are optional.
  }
}

async function fetchToken(): Promise<string> {
  const res = await fetch(SESSION_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Session request failed (${res.status})`);
  }
  const { token } = (await res.json()) as { token: string };
  sessionToken = token;
  return token;
}

/** Session JWT for Kinetiq's own HTTP API (job library). Refetched once if missing. */
export async function getSessionToken(): Promise<string> {
  return sessionToken ?? fetchToken();
}

/** Drops the cached token so the next getSessionToken() mints a fresh one (e.g. after a 403). */
export function invalidateSessionToken(): void {
  sessionToken = null;
}

function on<E extends keyof ServerEvents>(event: E, handler: ServerEvents[E]): void {
  socket?.on(event, handler as (...args: unknown[]) => void);
}

function setBackendError(message: string): void {
  setState((s) => ({ ...s, backend: 'offline', backendError: message }));
}

/** Connects once per page; safe to call from React effects (Strict Mode runs them twice). */
export async function startClient(): Promise<void> {
  if (started) {
    return;
  }
  started = true;

  let token: string;
  try {
    token = await fetchToken();
  } catch (err) {
    started = false;
    setBackendError(err instanceof Error ? err.message : 'Kinetiq server unreachable');
    return;
  }

  socket = io('', {
    path: '/socket.io',
    query: `token=${token}`,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => {
    tokenRetried = false;
    setState((s) => ({ ...s, backend: 'online', backendError: null }));
  });

  socket.on('disconnect', () => {
    // The serial port stays open server-side; on reconnect we re-attach (startup → list → open).
    setState((s) => ({
      ...resetMachineState(s),
      backend: 'offline',
      backendError: 'Connection to the Kinetiq server was lost',
      connection: { ...s.connection, phase: 'closed', error: null },
    }));
  });

  // socketio-jwt rejects the handshake with an 'error' event (e.g. expired token).
  socket.on('error', async (err: unknown) => {
    const message = typeof err === 'string' ? err : (err as { message?: string })?.message || 'Socket error';
    if (!tokenRetried && /token|jwt|auth/i.test(message)) {
      tokenRetried = true;
      try {
        const fresh = await fetchToken();
        if (socket) {
          socket.io.opts.query = `token=${fresh}`;
          socket.connect();
        }
        return;
      } catch {
        // fall through to the error state
      }
    }
    setBackendError(message);
  });

  on('startup', ({ baudrates }) => {
    setState((s) => ({ ...s, baudrates: Array.isArray(baudrates) ? baudrates.map(Number).filter(Number.isFinite) : [] }));
    listPorts();
  });

  on('serialport:list', (ports) => {
    setState((s) => ({ ...s, ports, portsLoaded: true }));
    attachToOpenPort();
  });

  on('serialport:change', ({ port, inuse }) => {
    setState((s) => ({
      ...s,
      ports: s.ports.map((p) => (p.port === port ? { ...p, inuse } : p)),
    }));
  });

  on('serialport:open', ({ port, baudrate, controllerType }) => {
    setState((s) => ({
      ...s,
      connection: { ...s.connection, port, baudrate, phase: 'open', userRequestedClose: false, error: null },
      controller: { ...s.controller, type: controllerType },
    }));
  });

  on('serialport:close', ({ port }) => {
    setState((s) => {
      const lost = !s.connection.userRequestedClose;
      return {
        ...resetMachineState(s),
        connection: {
          ...s.connection,
          phase: 'closed',
          userRequestedClose: false,
          error: lost ? { kind: 'lost', port } : null,
        },
      };
    });
  });

  on('serialport:error', ({ port }) => {
    setState((s) => ({
      ...s,
      connection: { ...s.connection, phase: 'closed', error: { kind: 'open-failed', port } },
    }));
  });

  let lastProgramLine: string | null = null;
  on('serialport:read', (line) => {
    if (typeof line !== 'string') return;
    consoleRead(line);
    lineListeners.forEach((listener) => listener(line));
    const match = FIRMWARE_PATTERN.exec(line);
    if (match) {
      setState((s) => ({ ...s, controller: { ...s.controller, firmware: `FluidNC v${match[1]}` } }));
      return;
    }
    // While a program runs, CNCjs forwards "> <line> (ln=N)" followed by "error:N (message)".
    // Only ln is trusted: the quoted text is lines[received - 1], i.e. the previous line.
    if (line.startsWith('> ')) {
      const ln = /\(ln=(\d+)\)\s*$/.exec(line);
      lastProgramLine = ln ? `line ${ln[1]}` : null;
      return;
    }
    if (/^error:/i.test(line)) {
      const s0 = getState();
      const startTime = s0.sender?.startTime;
      if (s0.workflow !== 'idle' && startTime) {
        const message = lastProgramLine ? `${line} at ${lastProgramLine}` : line;
        setState((s) => ({
          ...s,
          jobErrors:
            s.jobErrors?.startTime === startTime
              ? { startTime, messages: [...s.jobErrors.messages, message] }
              : { startTime, messages: [message] },
        }));
      }
      lastProgramLine = null;
    }
  });

  on('serialport:write', (data, context) => {
    if (typeof data !== 'string') return;
    consoleWrite(data, typeof context?.__sender__ === 'string' ? context.__sender__ : undefined, clientId);
  });

  on('controller:state', (type, controllerState) => {
    setState((s) => ({ ...s, controller: { ...s.controller, type, state: controllerState } }));
  });

  on('controller:settings', (type, settings) => {
    setState((s) => ({ ...s, controller: { ...s.controller, type, settings } }));
  });

  on('workflow:state', (workflow) => setState((s) => ({ ...s, workflow })));
  on('machine:limits', (limits) => setState((s) => ({ ...s, limits })));
  on('sender:status', (sender) => setState((s) => ({ ...s, sender })));
  on('feeder:status', (feeder) => setState((s) => ({ ...s, feeder })));
  on('gcode:load', (name, gcode, context) => {
    const ctx = context as { kinetiqJobId?: unknown; kinetiqLeveling?: ProgramLeveling } | null;
    const jobId = ctx?.kinetiqJobId;
    const lv = ctx?.kinetiqLeveling;
    const leveling =
      lv && typeof lv.mapId === 'string' && typeof lv.wcs === 'string' && lv.wco && [lv.wco.x, lv.wco.y, lv.wco.z].every(Number.isFinite)
        ? lv
        : null;
    setState((s) => ({
      ...s,
      program: { name, gcode: typeof gcode === 'string' ? gcode : '', jobId: typeof jobId === 'string' ? jobId : null, leveling },
    }));
  });
  on('gcode:unload', () => setState((s) => ({ ...s, program: null })));
}

const lineListeners = new Set<(line: string) => void>();

/**
 * Every line the controller sends that the backend forwards (`serialport:read`: ok, error:N,
 * ALARM:N, [PRB:…], [MSG:…], …). For step-by-step sequences such as the Z probe.
 */
export function onSerialLine(listener: (line: string) => void): () => void {
  lineListeners.add(listener);
  return () => lineListeners.delete(listener);
}

export function listPorts(): void {
  socket?.emit('list');
}

/**
 * After a page reload, a second tab or a backend reconnect: if this backend already has a port
 * open, attach to it. SocketEngine adds the socket without reopening the port and replays state.
 */
function attachToOpenPort(): void {
  const s = getState();
  if (s.connection.phase !== 'closed' || s.connection.userRequestedClose) {
    return;
  }
  const open = s.ports.find((p) => p.inuse);
  if (!open) {
    return;
  }
  const baudrate = loadPrefs().baudrate ?? DEFAULT_BAUDRATE;
  openPort(open.port, baudrate);
}

export function openPort(port: string, baudrate: number): void {
  if (!socket || !port || !Number.isFinite(baudrate) || baudrate <= 0) {
    // CNCjs's SerialConnection throws synchronously on a non-numeric baud rate (API_REFERENCE §2.1).
    return;
  }
  savePrefs({ port, baudrate });
  setState((s) => ({
    ...s,
    connection: { port, baudrate, phase: 'opening', userRequestedClose: false, error: null },
  }));

  const options: OpenOptions = { controllerType: 'Grbl', baudrate };
  socket.emit('open', port, options, (err: unknown) => {
    if (err) {
      setState((s) => ({
        ...s,
        connection: { ...s.connection, phase: 'closed', error: { kind: 'open-failed', port } },
      }));
      return;
    }
    setState((s) => ({ ...s, connection: { ...s.connection, phase: 'open', error: null } }));
  });
}

export function closePort(): void {
  const { port } = getState().connection;
  if (!socket || !port) {
    return;
  }
  setState((s) => ({ ...s, connection: { ...s.connection, userRequestedClose: true } }));
  socket.emit('close', port, (err: unknown) => {
    if (err) {
      // The backend no longer had this port (e.g. it was already lost): treat as closed.
      setState((s) => ({
        ...resetMachineState(s),
        connection: { ...s.connection, phase: 'closed', userRequestedClose: false },
      }));
    }
  });
}

/**
 * Machine commands handled by CNCjs GrblController.command() (docs/API_REFERENCE.md §7.1, §10).
 * Only these are exposed; Kinetiq never writes raw bytes for machine control.
 */
export type MachineCommand =
  | 'homing' // $H
  | 'unlock' // $X
  | 'feedhold' // !
  | 'cyclestart' // ~
  | 'reset' // workflow stop + feeder reset + 0x18
  | 'gcode:start' // workflow start + Sender.next()
  | 'gcode:pause' // workflow pause + !
  | 'gcode:resume' // ~ + workflow resume
  | 'gcode:unload' // workflow stop + Sender.unload()
  | 'jogCancel'; // 0x85 real-time jog cancel

/** Kinetiq travel measurement ("reverse homing", TravelGuard): measure an axis, then apply/dismiss, back off. */
export function sendTravelCommand(cmd: 'travel:measure', axis: 'x' | 'y'): void;
export function sendTravelCommand(cmd: 'travel:apply' | 'travel:dismiss' | 'travel:backoff'): void;
export function sendTravelCommand(cmd: 'travel:measure' | 'travel:apply' | 'travel:dismiss' | 'travel:backoff', axis?: 'x' | 'y'): void {
  const { port, phase } = getState().connection;
  if (!socket || !port || phase !== 'open') {
    return;
  }
  if (cmd === 'travel:measure') socket.emit('command', port, cmd, axis!);
  else socket.emit('command', port, cmd);
}

export function sendCommand(cmd: MachineCommand): void {
  const { port, phase } = getState().connection;
  if (!socket || !port || phase !== 'open') {
    return;
  }
  socket.emit('command', port, cmd);
}

/**
 * Queue one G-code line through the CNCjs Feeder (`command('gcode')`): one line in flight,
 * released on ok/error, and dropped by the backend while in Alarm (CNCJS_ANALYSIS.md S3).
 * Used for jogging (`$J=`). Callers must check derive.jogView() first.
 */
export function sendGcode(line: string): void {
  const { port, phase } = getState().connection;
  if (!socket || !port || phase !== 'open' || !line.trim()) {
    return;
  }
  socket.emit('command', port, 'gcode', line, { __sender__: clientId });
}

/**
 * Write one line directly (CNCjs `writeln`), bypassing the Feeder — same path as the console.
 * Needed for `$H<axis>`: homing must work from Alarm, where the Feeder drops lines.
 * Callers must check the workflow is idle (CNCJS_ANALYSIS.md hazard H1).
 */
export function sendLine(line: string): void {
  const { port, phase } = getState().connection;
  if (!socket || !port || phase !== 'open' || !line.trim()) {
    return;
  }
  socket.emit('writeln', port, line, { __sender__: clientId });
}

/**
 * Real-time overrides (CNCjs `feedOverride` / `spindleOverride` → GRBL 0x90–0x94 / 0x99–0x9D).
 * `step` is +10, −10, +1, −1, or 0 to reset to 100 %. Real-time bytes: safe while a job streams.
 */
export type OverrideKind = 'feed' | 'spindle';
export type OverrideStep = 10 | -10 | 1 | -1 | 0;

export function sendOverride(kind: OverrideKind, step: OverrideStep): void {
  const { port, phase } = getState().connection;
  if (!socket || !port || phase !== 'open') {
    return;
  }
  socket.emit('command', port, kind === 'feed' ? 'feedOverride' : 'spindleOverride', step);
}

export function clearConnectionError(): void {
  setState((s) => ({ ...s, connection: { ...s.connection, error: null } }));
}

/**
 * Load a program onto the controller (CNCjs `gcode:load`). The backend appends `%wait`, stops the
 * workflow and replies with `gcode:load` to every attached socket. Callers check derive.jobView().canLoad.
 */
export function loadProgram(name: string, gcode: string, jobId: string | null, leveling: ProgramLeveling | null = null): Promise<void> {
  const { port, phase } = getState().connection;
  if (!socket || !port || phase !== 'open') {
    return Promise.reject(new Error('Not connected'));
  }
  const context = { ...(jobId ? { kinetiqJobId: jobId } : {}), ...(leveling ? { kinetiqLeveling: leveling } : {}) };
  return new Promise((resolve, reject) => {
    socket?.emit('command', port, 'gcode:load', name, gcode, context, (err: unknown) => {
      if (err) {
        reject(new Error((err as { message?: string })?.message || 'The controller rejected this program'));
        return;
      }
      resolve();
    });
  });
}

const STOP_HOLD_TIMEOUT_MS = 15_000;
const STOP_SETTLE_MS = 750; // three 250 ms status polls


/**
 * Safe Stop (API_REFERENCE §7.1): pause → wait for Hold:0 (motion has decelerated, position kept)
 * → `gcode:stop {force:true}` (workflow stop, Sender rewind, soft reset while in Hold).
 * Resetting during Hold:1 would lose position, so the sequence never forces before Hold completes.
 */
export function stopJob(): void {
  const s0 = getState();
  if (!socket || s0.connection.phase !== 'open' || s0.workflow === 'idle' || s0.stopSequence.phase === 'stopping') {
    return;
  }
  const port = s0.connection.port;
  const startedAt = Date.now();
  setState((s) => ({ ...s, stopSequence: { phase: 'stopping', startedAt } }));
  if (s0.workflow === 'running') {
    sendCommand('gcode:pause');
  }

  let unsubscribe = () => {};
  let done = false;
  const finish = (failure?: string) => {
    done = true;
    clearTimeout(timer);
    unsubscribe();
    setState((s) => ({ ...s, stopSequence: failure ? { phase: 'failed', message: failure } : { phase: 'idle' } }));
  };

  const check = () => {
    if (done) return;
    const s = getState();
    if (s.connection.phase !== 'open' || s.connection.port !== port) {
      finish('Connection closed while stopping');
      return;
    }
    if (s.workflow === 'idle') {
      finish(); // already stopped (another client, reset, or completion)
      return;
    }
    const status = s.controller.state?.status;
    const active = status?.activeState;
    const holdComplete = active === 'Hold' && status?.subState === 0;
    // Idle/Alarm while paused: nothing to decelerate (e.g. M0 after a dwell). Trusted only after a few
    // status ticks, so a report from before the pause took effect cannot trigger a reset mid-deceleration.
    const settled = s.workflow === 'paused' && Date.now() - startedAt >= STOP_SETTLE_MS;
    const stationary = settled && (active === 'Idle' || active === 'Alarm');
    if (holdComplete || stationary || (active === 'Door' && status?.subState === 0)) {
      socket?.emit('command', port, 'gcode:stop', { force: true });
      finish();
    }
  };

  const timer = setTimeout(
    () => finish('The machine did not reach Hold within 15 s. Use Hold, then Reset if needed.'),
    STOP_HOLD_TIMEOUT_MS,
  );
  unsubscribe = subscribe(check);
  // Status may not change while waiting for the settle window, so re-check on a short timer too.
  const poll = setInterval(check, 250);
  const stopPolling = unsubscribe;
  unsubscribe = () => {
    clearInterval(poll);
    stopPolling();
  };
  check();
}

export function clearStopFailure(): void {
  setState((s) => (s.stopSequence.phase === 'failed' ? { ...s, stopSequence: { phase: 'idle' } } : s));
}
