'use client';

/**
 * The single Socket.IO connection to the embedded CNCjs backend.
 * Emits only verified events (docs/API_REFERENCE.md §2) and reduces server events into the store.
 * Policy (what is allowed when) lives in derive.ts, never here.
 */
import io, { type Socket } from 'socket.io-client';
import { DEFAULT_BAUDRATE, type OpenOptions, type ServerEvents } from './protocol';
import { getState, resetMachineState, setState } from './store';

const SESSION_URL = '/api/kinetiq/session';
const FIRMWARE_PATTERN = /\[(FluidNC v[\d.]+[^\s\]]*)/;
const PREFS_KEY = 'kinetiq.connection';

let socket: Socket | null = null;
let started = false;
let tokenRetried = false;

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
  return token;
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

  on('serialport:read', (line) => {
    const match = typeof line === 'string' ? FIRMWARE_PATTERN.exec(line) : null;
    if (match) {
      setState((s) => ({ ...s, controller: { ...s.controller, firmware: match[1] } }));
    }
  });

  on('controller:state', (type, controllerState) => {
    setState((s) => ({ ...s, controller: { ...s.controller, type, state: controllerState } }));
  });

  on('controller:settings', (type, settings) => {
    setState((s) => ({ ...s, controller: { ...s.controller, type, settings } }));
  });

  on('workflow:state', (workflow) => setState((s) => ({ ...s, workflow })));
  on('sender:status', (sender) => setState((s) => ({ ...s, sender })));
  on('feeder:status', (feeder) => setState((s) => ({ ...s, feeder })));
  on('gcode:load', (name) => setState((s) => ({ ...s, program: { name } })));
  on('gcode:unload', () => setState((s) => ({ ...s, program: null })));
}

export function listPorts(): void {
  socket?.emit('list');
}

/**
 * After a page reload, a second tab or a backend reconnect: if this backend already has a port
 * open, attach to it. CNCEngine adds the socket without reopening the port and replays state.
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

export function clearConnectionError(): void {
  setState((s) => ({ ...s, connection: { ...s.connection, error: null } }));
}
