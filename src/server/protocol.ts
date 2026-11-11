/**
 * The Socket.IO protocol between the browser and the embedded CNCjs backend, as TypeScript types.
 *
 * Derived from the backend source, which is the source of truth (docs/API_REFERENCE.md describes
 * the same contract in prose):
 *   - src/server/engine/SocketEngine.ts                   socket handlers, startup, list, task events
 *     (was services/cncengine/CNCEngine.js)
 *   - src/server/controller/                              controller events and command() handlers
 *     (GrblController.ts fan-out, commands.ts table; was controllers/Grbl/GrblController.js)
 *   - src/server/grbl/GrblRunner.ts                       controller state/settings objects
 *   - src/server/streaming/{Sender,Feeder,Workflow}.ts    status payloads
 *
 * Ground rule (docs/BACKEND_INTEGRATION.md §7.1): event names, payload shapes
 * and command names do not change. Backend changes are checked against this file.
 *
 * SHARED with the browser bundle (re-exported by src/lib/cnc/protocol.ts): types and plain
 * constants only. No Node imports, no runtime dependencies.
 *
 * Wire notes that apply throughout:
 *   - Socket.IO serialises payloads as JSON (v4 as v2 did). `undefined` properties are dropped,
 *     functions vanish, and an `Error` object arrives as `{}` (its `message` is not an own enumerable
 *     property). Only a rejected handshake carries a message: the client's `connect_error` Error.
 *   - Positions are decimal STRINGS exactly as the controller printed them ("12.500"), not numbers.
 *   - The TypeScript rewrite removed the commands and events the UI never used
 *     (CNCjs macros, watch directory, CNCjs autolevel, Grbl:* duplicates, command aliases, sleep,
 *     rapid overrides, feeder:* and statusreport); they are no longer part of the protocol.
 *     Kinetiq's own `macro:run` (by id, macros stored by src/server/macros.ts) was added later.
 */
import type { MachineLimits } from '../lib/machine/travel';

export type { MachineLimits };

// ---------------------------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------------------------

/** The only controller Kinetiq loads (`GRBL` in src/server/grbl/constants.ts). */
export type ControllerType = 'Grbl';

export type Axis = 'x' | 'y' | 'z' | 'a' | 'b' | 'c';

/**
 * Per-axis decimal strings, e.g. `{ x: '12.500', y: '0.000', z: '-3.200' }`. Only the axes the
 * controller reported are present (the initial state has x, y, z).
 */
export type AxisValues = Partial<Record<Axis, string>>;

/**
 * Caller context attached to written lines (`write`/`writeln`/`command('gcode')`). Kinetiq sends
 * `{ __sender__: clientId }` so the console can recognise its own echoes.
 */
export interface WriteContext {
  source?: 'client' | 'feeder' | string;
  __sender__?: string;
  [key: string]: unknown;
}

/**
 * Why the Sender or Feeder is holding.
 *   - `{ data: 'M0' | 'M1' | 'M6', msg }`   program pause / manual tool change
 *   - `{ data: '%wait', msg }`              the dwell Kinetiq's backend appends to every program
 *   - `{ err: true, msg: 'error:N (…)' }`   pause-on-error while a program runs
 * `msg` is the last `%msg` text if one was set, otherwise the original line.
 */
export interface HoldReason {
  data?: 'M0' | 'M1' | 'M6' | '%wait' | string;
  msg?: string;
  err?: boolean;
}

// ---------------------------------------------------------------------------------------------
// controller:state / controller:settings (src/server/grbl/GrblRunner.ts)
// ---------------------------------------------------------------------------------------------

export interface GrblStatus {
  /** '' until the first status report; then 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep'. */
  activeState: string;
  /**
   * Hold:0 complete / Hold:1 in progress; Door:0..3. Absent before the first status report; after
   * that always a number, and 0 when the report had no `:n` suffix (`Number('')`), never NaN.
   */
  subState?: number;
  /** Machine position (MPos, or WPos + WCO). */
  mpos: AxisValues;
  /** Work position (WPos, or MPos − WCO), same number of decimals as reported. */
  wpos: AxisValues;
  /** Last reported work coordinate offset; kept between reports. */
  wco?: AxisValues;
  /** `Ov:` overrides as numbers, [feed %, rapid %, spindle %]; [] until the first `Ov:`. */
  ov: number[];
  /** Live feed rate (FS: or F:), in the controller's report units. */
  feedrate?: number;
  /** Live spindle speed (FS:). */
  spindle?: number;
  /**
   * Available planner blocks / RX bytes. `Bf:` (v1.1) sets both; the v0.9 `Buf:` and `RX:` fields
   * set one each.
   */
  buf?: { planner?: number; rx?: number };
  /** `Ln:` line number being executed. */
  ln?: number;
  /** Triggered input pins, e.g. 'XZP'. Set to '' by every report without `Pn:`; absent only before the first report. */
  pinState?: string;
  /** Accessory letters, e.g. 'SF'. '' after an `Ov:` report without `A:`; kept otherwise. */
  accessoryState?: string;
}

/**
 * `$G` parser state. Values are the G/M words as strings. It starts as a complete default (all
 * groups, tool/feedrate/spindle ''), then each `$G` reply replaces it wholesale with exactly what
 * the line contained (GrblRunner): a field the line lacked becomes undefined, and `modal` holds only
 * the groups present (absent if the line had no G/M word). GRBL and FluidNC always report
 * everything, so in practice every field is set.
 *
 * Truthfulness note: the parser makes ANY group an array when a `$G` line repeats it, but only
 * coolant does that on real firmware (['M7', 'M8']). The other groups are typed `string` here so the
 * browser can use them as words; the server-side type that admits arrays everywhere is
 * GrblRunnerParserState (src/server/grbl/GrblRunner.ts), narrowed to this one at the socket emit
 * (src/server/controller/GrblController.ts).
 */
export interface GrblParserState {
  modal?: {
    motion?: string; // G0 G1 G2 G3 G38.2 G38.3 G38.4 G38.5 G80
    wcs?: string; // G54..G59
    plane?: string; // G17 G18 G19
    units?: 'G20' | 'G21' | string; // G20 inches, G21 millimetres
    distance?: string; // G90 G91
    feedrate?: string; // G93 G94
    program?: string; // M0 M1 M2 M30
    spindle?: string; // M3 M4 M5
    /** 'M9', or an array such as ['M7', 'M8'] when both coolants are on. */
    coolant?: string | string[];
  };
  /** Tool number without the T, e.g. '0'; '' until the first `$G`. */
  tool?: string;
  /** Programmed feed without the F, e.g. '500.0'; '' until the first `$G`. */
  feedrate?: string;
  /** Programmed spindle speed without the S; '' until the first `$G`. */
  spindle?: string;
}

export interface GrblState {
  status: GrblStatus;
  parserstate: GrblParserState;
}

/** `[PRB:x,y,z:r]` — axis strings plus the success flag (1 = touched, 0 = no contact). */
export type ProbeParameter = AxisValues & { result: number };

/** `$#` / probe parameters, keyed by name (GrblLineParserResultParameters.js). */
export interface GrblParameters {
  G54?: AxisValues;
  G55?: AxisValues;
  G56?: AxisValues;
  G57?: AxisValues;
  G58?: AxisValues;
  G59?: AxisValues;
  G28?: AxisValues;
  G30?: AxisValues;
  G92?: AxisValues;
  /** Tool length offset as printed, e.g. '0.000'. */
  TLO?: string;
  PRB?: ProbeParameter;
}

// A `type` (not an interface) so it is assignable to `Record<string, unknown>`-style shapes such as
// the FluidNC settings exchange's controller view (src/server/fluidnc/exchange.ts).
export type GrblSettings = {
  /** From the startup banner, e.g. '3.7' for "Grbl 3.7 [FluidNC …]"; '' until a banner arrives. */
  version: string;
  parameters: GrblParameters;
  /** `$n=value` lines as strings, e.g. { '$13': '0' }. */
  settings: Record<string, string>;
};

// ---------------------------------------------------------------------------------------------
// sender:status / feeder:status / workflow:state
// ---------------------------------------------------------------------------------------------

/** Sender streaming protocol: 0 send-response, 1 character-counting (the only one Kinetiq uses). */
export type SenderProtocolType = 0 | 1;

/** `Sender.toJSON()` (lib/Sender.js). Times are epoch milliseconds on the server clock. */
export interface SenderStatus {
  sp: SenderProtocolType;
  hold: boolean;
  /**
   * null when not holding. ABSENT (undefined on the server) after a plain `gcode:pause`, which
   * holds the Sender without a reason.
   */
  holdReason?: HoldReason | null;
  /** Program name given to `gcode:load`. */
  name: string;
  /**
   * The context given to `gcode:load` (default {}). The backend mutates it while streaming
   * (populateContext adds xmin…zmax, mposx…, posx…, modal, tool, params, global), so those keys
   * appear here too.
   */
  context: Record<string, unknown>;
  /** Program length in characters, including the appended `%wait` line. */
  size: number;
  /** Non-empty lines, including the appended `%wait` line. */
  total: number;
  /** Lines handed to the serial port. */
  sent: number;
  /** Lines acknowledged (ok / error). */
  received: number;
  /** 0 = not started. */
  startTime: number;
  /** Set when received >= total; 0 = not finished. Survives rewind, cleared on the next start. */
  finishTime: number;
  /** ms; recomputed only on each ack. */
  elapsedTime: number;
  /** ms; line-count extrapolation, 0 until ≥ 1 s elapsed and ≥ 1 ack. */
  remainingTime: number;
}

/** `Feeder.toJSON()` (lib/Feeder.js). The Feeder streams manual lines (console, jog). */
export interface FeederStatus {
  hold: boolean;
  /**
   * null when not holding; M0/M1/M6 in a manual line hold the Feeder. ABSENT (undefined on the
   * server) after a hold without a reason (not reachable from the commands Kinetiq sends).
   */
  holdReason?: HoldReason | null;
  /** Queued lines. */
  queue: number;
  /** One line is awaiting ok/error. */
  pending: boolean;
  changed: boolean;
}

/** lib/Workflow.js WORKFLOW_STATE_* */
export type WorkflowState = 'idle' | 'running' | 'paused';

// ---------------------------------------------------------------------------------------------
// Connection payloads
// ---------------------------------------------------------------------------------------------

export interface SerialPortInfo {
  /** Port path, e.g. '/dev/tty.usbserial-0001'. */
  port: string;
  manufacturer?: string;
  /** A controller has this port open. */
  inuse: boolean;
}

/** Second argument of the `open` client event. */
export interface OpenOptions {
  /** Defaults to 'Grbl' server-side; Kinetiq always sends it. */
  controllerType: ControllerType;
  /** REQUIRED finite number: SerialConnection's constructor throws synchronously otherwise. */
  baudrate: number;
  /** Hardware flow control; coerced with `!!`. */
  rtscts?: boolean;
  /** DTR/RTS levels set 100 ms after open (ESP32 auto-reset control). */
  pin?: { dtr?: boolean; rts?: boolean };
}

export interface StartupPayload {
  loadedControllers: ControllerType[];
  /** rc file `baudrates`, passed through unvalidated (ensureArray). */
  baudrates: number[];
  /** rc file `ports`, passed through unvalidated (ensureArray). */
  ports: unknown[];
}

export interface SerialPortOpenPayload {
  port: string;
  baudrate: number;
  controllerType: ControllerType;
  inuse: true;
}

export interface SerialPortChangePayload {
  port: string;
  inuse: boolean;
}

export interface SerialPortClosePayload {
  port: string;
  inuse: false;
}

export interface SerialPortErrorPayload {
  /** An `Error` on the server; arrives as `{}` over the wire. */
  err: unknown;
  port: string;
}

/** `serialport:write` context: the caller's context plus where the bytes came from. */
export type SerialPortWriteContext = WriteContext & {
  /**
   * 'client' for `write`/`writeln` (and real-time bytes from commands), 'feeder' for Feeder lines.
   * Sender program lines and the `?` / `$G` polls are never echoed.
   */
  source: 'client' | 'feeder';
};

// ---------------------------------------------------------------------------------------------
// Server → client events
// ---------------------------------------------------------------------------------------------

/**
 * Every event the backend emits. "Attached" sockets are those that called `open` for the port
 * (GrblController.addConnection, src/server/controller/GrblController.ts); on attach they get a replay of serialport:open,
 * controller:settings/state, feeder:status, sender:status, gcode:load (if loaded), workflow:state.
 */
export interface ServerEvents {
  /** To the connecting socket, right after the handshake. (SocketEngine) */
  startup: (payload: StartupPayload) => void;
  /** Reply to `list`: detected ports plus rc `ports`. (SocketEngine) */
  'serialport:list': (ports: SerialPortInfo[]) => void;
  /** Port opened, or a socket attached to an already open port. Attached sockets. */
  'serialport:open': (payload: SerialPortOpenPayload) => void;
  /** Port opened or closed. ALL sockets (engine.io.emit). */
  'serialport:change': (payload: SerialPortChangePayload) => void;
  /** Close requested or connection lost. Attached sockets. */
  'serialport:close': (payload: SerialPortClosePayload) => void;
  /** The port failed to open. Attached sockets. */
  'serialport:error': (payload: SerialPortErrorPayload) => void;
  /** A controller line forwarded to the user (raw, or annotated: "error:N (message)", "ALARM:N (…)", "> line (ln=N)", "$n=v (message, units)"). */
  'serialport:read': (line: string) => void;
  /** Bytes written by `write`/`writeln`/real-time commands or by the Feeder. */
  'serialport:write': (data: string, context: SerialPortWriteContext) => void;
  /** Runner state changed (checked every 250 ms tick). */
  'controller:state': (type: ControllerType, state: GrblState) => void;
  /** Runner settings changed (banner, `$n=` lines, `[G54:…]` parameters). */
  'controller:settings': (type: ControllerType, settings: GrblSettings) => void;
  /** Feeder state changed (checked every tick). */
  'feeder:status': (status: FeederStatus) => void;
  /** Sender state changed (checked every tick). */
  'sender:status': (status: SenderStatus) => void;
  /** Every workflow transition, and on attach. */
  'workflow:state': (state: WorkflowState) => void;
  /** Kinetiq travel limits: the envelope and which axes are homed. On attach and when it changes. */
  'machine:limits': (limits: MachineLimits) => void;
  /**
   * A program was loaded, or a socket attached while one is loaded. `gcode` is the stored text,
   * i.e. the caller's G-code plus "\n%wait ; Wait for the planner to empty". `context` is the
   * load context (see SenderStatus.context: it gains backend keys while streaming).
   */
  'gcode:load': (name: string, gcode: string, context: Record<string, unknown>) => void;
  /** The program was unloaded. */
  'gcode:unload': () => void;
  /** rc `events` shell task started (TaskRunner). ALL sockets. Unused by the UI. */
  'task:start': (taskId: string) => void;
  /** rc `events` shell task exited with `code`. ALL sockets. Unused by the UI. */
  'task:finish': (taskId: string, code: number | null) => void;
  /** rc `events` shell task failed to spawn; `err` arrives as a plain object. ALL sockets. Unused by the UI. */
  'task:error': (taskId: string, err: unknown) => void;
}

export type ServerEventName = keyof ServerEvents;

/** Every server event name, in the order of ServerEvents. */
export const SERVER_EVENTS = [
  'startup',
  'serialport:list',
  'serialport:open',
  'serialport:change',
  'serialport:close',
  'serialport:error',
  'serialport:read',
  'serialport:write',
  'controller:state',
  'controller:settings',
  'feeder:status',
  'sender:status',
  'workflow:state',
  'machine:limits',
  'gcode:load',
  'gcode:unload',
  'task:start',
  'task:finish',
  'task:error',
] as const satisfies readonly ServerEventName[];

// ---------------------------------------------------------------------------------------------
// Controller commands: socket.emit('command', port, cmd, ...args) → GrblController.command()
// (handlers in src/server/controller/commands.ts)
// ---------------------------------------------------------------------------------------------

/** Override step for feedOverride/spindleOverride. Any other value is silently ignored. */
export type OverrideStep = 0 | 10 | -10 | 1 | -1;

/** gcode:load completion: `(Error)` (arrives as `{}`) or `(null, SenderStatus)`. */
export type GcodeLoadCallback = (err: unknown, status?: SenderStatus) => void;

/** Command name → argument tuple (after `port` and `cmd`). Unknown names are logged and ignored. */
export interface ControllerCommands {
  /** Sender.load(name, gcode + '\n%wait …', context), emits gcode:load, workflow → idle. `context` may be omitted with the callback in its place. */
  'gcode:load':
    | [name: string, gcode: string, context?: Record<string, unknown>, callback?: GcodeLoadCallback]
    | [name: string, gcode: string, callback: GcodeLoadCallback];
  /** Workflow → idle, Sender.unload(), emits gcode:unload. */
  'gcode:unload': [];
  /** Workflow → running, Feeder reset, Sender.next(). */
  'gcode:start': [];
  /** Workflow → idle (Sender rewinds). With force: writes `!` if Run, waits 500 ms, writes 0x18 if Hold. */
  'gcode:stop': [options?: { force?: boolean }];
  /** Workflow → paused (Sender holds without a reason), writes `!`. */
  'gcode:pause': [];
  /** Writes `~`, workflow → running (Feeder reset, Sender continues). */
  'gcode:resume': [];
  /** Writes `!`. */
  feedhold: [];
  /** Writes `~`. */
  cyclestart: [];
  /** Writes `$H`. */
  homing: [];
  /** Writes `$X`. */
  unlock: [];
  /** Workflow → idle, Feeder reset, writes 0x18. */
  reset: [];
  /** Writes 0x85. */
  jogCancel: [];
  /** 0x90 reset / 0x91 +10 / 0x92 −10 / 0x93 +1 / 0x94 −1. */
  feedOverride: [value: OverrideStep];
  /** 0x99 reset / 0x9A +10 / 0x9B −10 / 0x9C +1 / 0x9D −1. */
  spindleOverride: [value: OverrideStep];
  /**
   * Queue lines on the Feeder (split on newlines, blanks dropped); one in flight, dropped in Alarm.
   * `commands` may be undefined (an rc `events` entry with trigger 'gcode' and no commands, or a
   * socket that omits it): nothing is queued.
   */
  gcode: [commands: string | string[] | undefined, context?: WriteContext];
  /** Kinetiq: slow jog of a homed axis to its far limit switch, to measure the travel (TravelGuard). */
  'travel:measure': [axis: 'x' | 'y'];
  /** Kinetiq: save the measured travel and use it for the envelope. */
  'travel:apply': [];
  /** Kinetiq: forget a finished or failed measurement. */
  'travel:dismiss': [];
  /** Kinetiq: move the measured axis a few mm off its far switch, toward home. */
  'travel:backoff': [];
  /**
   * Kinetiq: run a saved macro (src/server/macros.ts) by id. The backend reads its content and
   * queues the lines on the Feeder exactly like `gcode` (feeder filter, TravelGuard). Refused, with
   * a `[MSG:WARN: Kinetiq: macro not run. …]` line on `serialport:read`, unless the macro exists
   * and is valid, the port is not in exclusive use, the workflow is idle, the Feeder has nothing
   * queued, in flight or held, and the controller is Idle. Only `context.__sender__` is kept.
   */
  'macro:run': [id: string, context?: WriteContext];
}

export type ControllerCommandName = keyof ControllerCommands;

/** Every command name, in the command table's order (src/server/controller/commands.ts). */
export const CONTROLLER_COMMANDS = [
  'gcode:load',
  'gcode:unload',
  'gcode:start',
  'gcode:stop',
  'gcode:pause',
  'gcode:resume',
  'feedhold',
  'cyclestart',
  'homing',
  'unlock',
  'reset',
  'jogCancel',
  'feedOverride',
  'spindleOverride',
  'gcode',
  'travel:measure',
  'travel:apply',
  'travel:dismiss',
  'travel:backoff',
  'macro:run',
] as const satisfies readonly ControllerCommandName[];

// Compile-time check that both lists name every key (`satisfies` above rules out extra names).
type AssertTrue<T extends true> = T;
type ListsAll<List extends readonly string[], Keys extends string> = [Exclude<Keys, List[number]>] extends [never] ? true : false;
export type ProtocolListsComplete = AssertTrue<
  ListsAll<typeof SERVER_EVENTS, ServerEventName> | ListsAll<typeof CONTROLLER_COMMANDS, ControllerCommandName>
>;

// ---------------------------------------------------------------------------------------------
// Client → server events (SocketEngine socket.on handlers)
// ---------------------------------------------------------------------------------------------

/** Error-first ack. `err` is an `Error` server-side and arrives as `{}`; null on success. */
export type AckCallback = (err: unknown) => void;

export interface ClientEvents {
  /** Replies with `serialport:list` (also when port detection fails: rc ports only). */
  list: () => void;
  /**
   * Creates the controller if needed, attaches this socket, opens the port, joins room `port`,
   * then `callback(null)`. Already open: attaches and `callback(null)` at once.
   */
  open: (port: string, options: OpenOptions, callback?: AckCallback) => void;
  /** Leaves the room, closes the port and destroys the controller; `callback(null)`, or an error if no controller exists. */
  close: (port: string, callback?: AckCallback) => void;
  /** `controller.command(cmd, ...args)`. Logged and dropped if the port is not open. */
  command: <C extends ControllerCommandName>(port: string, cmd: C, ...args: ControllerCommands[C]) => void;
  /** Raw bytes, bypassing the Feeder. Context defaults to {}. */
  write: (port: string, data: string, context?: WriteContext) => void;
  /** Real-time characters raw, anything else with '\n' appended. Bypasses the Feeder. */
  writeln: (port: string, data: string, context?: WriteContext) => void;
}

export type ClientEventName = keyof ClientEvents;
