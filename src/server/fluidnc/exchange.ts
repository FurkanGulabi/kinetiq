/**
 * One FluidNC `$` command at a time over the serial port the CNC backend already holds.
 *
 * Writes through the controller (`writeln`, so the line also shows up as client traffic) and
 * collects the reply from the serial connection's line events until `ok` or `error:N`.
 * The backend keeps polling while we wait, so two kinds of foreign lines are skipped:
 *   - `<…>` status reports (reply to the `?` poll)
 *   - a `[GC:…]` parser state plus the `ok` that follows it (reply to the backend's `$G` poll).
 *     Our commands never produce `[GC:` lines, so one is skipped wherever it appears, and so is
 *     the next `ok` after it (GRBL answers each line in order: `[GC:…]` then its `ok`).
 *
 * SERVER-ONLY. See docs/SETTINGS_EDITOR.md §3.2.
 */
import type { EventEmitter } from 'node:events';

export interface FluidncController {
  isOpen(): boolean;
  writeln(data: string, context?: Record<string, unknown>): void;
  connection: EventEmitter | null;
  workflow: { state: string } | null;
  runner: {
    state: { status?: { activeState?: string } };
    settings: { settings?: Record<string, string> } & Record<string, unknown>;
  } | null;
}

interface ControllerStore {
  get<T = unknown>(key: string, defaultValue?: T): T;
}

export class ExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'not-connected' | 'not-idle' | 'busy' | 'timeout' | 'controller-error' | 'closed',
    message: string,
  ) {
    super(message);
  }
}

/** The single open controller, or a 412 if nothing is connected. */
export function getOpenController(store: ControllerStore): FluidncController {
  const controllers = store.get<Record<string, FluidncController | undefined>>('controllers', {});
  const open = Object.values(controllers).find((c) => c && c.isOpen());
  if (!open) {
    throw new ExchangeError(412, 'not-connected', 'Connect to the controller first');
  }
  return open;
}

/** Machine must be Idle or Alarm with no job running (docs/SETTINGS_EDITOR.md §6). */
export function assertIdle(controller: FluidncController): void {
  const workflow = controller.workflow?.state;
  if (workflow !== 'idle') {
    throw new ExchangeError(409, 'not-idle', 'Not available while a job is running or paused');
  }
  const active = controller.runner?.state?.status?.activeState;
  if (!active) {
    throw new ExchangeError(409, 'not-idle', 'Waiting for controller status');
  }
  if (active !== 'Idle' && active !== 'Alarm') {
    throw new ExchangeError(409, 'not-idle', `Machine is ${active}: wait until it is Idle`);
  }
}

let busy = false;

/** Runs `task` with the process-wide exchange lock; a second caller gets 409 busy. */
export async function exclusive<T>(task: () => Promise<T>): Promise<T> {
  if (busy) {
    throw new ExchangeError(409, 'busy', 'Another settings operation is in progress');
  }
  busy = true;
  try {
    return await task();
  } finally {
    busy = false;
  }
}

export function isExchangeBusy(): boolean {
  return busy;
}

/**
 * Sends one command and resolves with its reply lines (without the final `ok`).
 * Rejects on `error:N`, on timeout, or if the port closes meanwhile.
 */
export function exchange(controller: FluidncController, command: string, timeoutMs = 15000): Promise<string[]> {
  const connection = controller.connection;
  if (!connection || !controller.isOpen()) {
    return Promise.reject(new ExchangeError(412, 'not-connected', 'Connect to the controller first'));
  }

  return new Promise<string[]>((resolve, reject) => {
    const lines: string[] = [];
    let skipOks = 0;

    const finish = (err: Error | null) => {
      clearTimeout(timer);
      connection.removeListener('data', onData);
      connection.removeListener('close', onClose);
      cleanSettings(controller);
      if (err) reject(err);
      else resolve(lines);
    };

    const onData = (data: unknown) => {
      const line = String(data).replace(/\r$/, '');
      const trimmed = line.trim();
      if (trimmed.startsWith('<')) {
        return; // status report
      }
      if (trimmed.startsWith('[GC:')) {
        skipOks++; // reply to a $G poll; its ok follows
        return;
      }
      if (trimmed === 'ok') {
        if (skipOks > 0) {
          skipOks--;
          return;
        }
        finish(null);
        return;
      }
      if (/^error:/i.test(trimmed)) {
        finish(new ExchangeError(502, 'controller-error', `${command} → ${trimmed}`));
        return;
      }
      lines.push(line);
    };

    const onClose = () => finish(new ExchangeError(412, 'closed', 'The serial port closed during the operation'));

    const timer = setTimeout(
      () => finish(new ExchangeError(504, 'timeout', `${command}: no reply within ${timeoutMs / 1000} s`)),
      timeoutMs,
    );

    connection.on('data', onData);
    connection.on('close', onClose);
    controller.writeln(command, { source: 'kinetiq:settings' });
  });
}

/**
 * CNCjs's settings parser stores every `$name=value` line as a GRBL setting, so FluidNC replies
 * like `$Config/Filename=config.yaml` or `$/axes/x/steps_per_mm=400.000` would show up in
 * `controller:settings`. Keep only numeric GRBL settings (`$0`…`$255`). Replacing the object makes
 * the controller broadcast the cleaned settings on its next 250 ms tick.
 */
function cleanSettings(controller: FluidncController): void {
  const runner = controller.runner;
  const settings = runner?.settings?.settings;
  if (!runner || !settings) {
    return;
  }
  const junk = Object.keys(settings).filter((name) => !/^\$\d+$/.test(name));
  if (junk.length === 0) {
    return;
  }
  const kept = Object.fromEntries(Object.entries(settings).filter(([name]) => /^\$\d+$/.test(name)));
  runner.settings = { ...runner.settings, settings: kept };
}
