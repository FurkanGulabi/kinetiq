/**
 * The Socket.IO protocol between the browser and the embedded CNCjs backend, as TypeScript types.
 *
 * Derived from the JS source, which is the source of truth (docs/API_REFERENCE.md describes the
 * same contract in prose):
 *   - src/server/cnc/services/cncengine/CNCEngine.js      socket handlers, startup, list, task/config
 *   - src/server/cnc/controllers/Grbl/GrblController.js   controller events and command() handlers
 *   - src/server/cnc/controllers/Grbl/GrblRunner.js       controller state/settings objects
 *   - src/server/cnc/lib/{Sender,Feeder,Workflow}.js       status payloads
 *
 * Ground rule of the backend rewrite (docs/BACKEND_REWRITE_PLAN.md §2): event names, payload shapes
 * and command names do not change. Later phases are checked against this file.
 *
 * SHARED with the browser bundle (re-exported by src/lib/cnc/protocol.ts): types and plain
 * constants only. No Node imports, no runtime dependencies.
 *
 * Wire notes that apply throughout:
 *   - Socket.IO 2 serialises payloads as JSON. `undefined` properties are dropped, functions vanish,
 *     and an `Error` object arrives as `{}` (its `message` is not an own enumerable property).
 *   - Positions are decimal STRINGS exactly as the controller printed them ("12.500"), not numbers.
 *   - `@deprecated Phase 1 removes this` marks what BACKEND_REWRITE_PLAN.md §3 deletes; each was
 *     checked to be unused by src/lib and src/components.
 */

// ---------------------------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------------------------

/** The only controller Kinetiq loads (`GRBL` in controllers/Grbl/constants.js). */
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
// controller:state / controller:settings (GrblRunner.js)
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
 * `$G` parser state. Each `$G` reply replaces `modal` wholesale with the groups it contained; GRBL
 * and FluidNC always report all of them. Values are the G/M words as strings.
 */
export interface GrblParserState {
  modal: {
    motion: string; // G0 G1 G2 G3 G38.2 G38.3 G38.4 G38.5 G80
    wcs: string; // G54..G59
    plane: string; // G17 G18 G19
    units: 'G20' | 'G21' | string; // G20 inches, G21 millimetres
    distance: string; // G90 G91
    feedrate: string; // G93 G94
    program: string; // M0 M1 M2 M30
    spindle: string; // M3 M4 M5
    /** 'M9', or an array such as ['M7', 'M8'] when both coolants are on. */
    coolant: string | string[];
  };
  /** Tool number without the T, e.g. '0'; '' until the first `$G`. */
  tool: string;
  /** Programmed feed without the F, e.g. '500.0'; '' until the first `$G`. */
  feedrate: string;
  /** Programmed spindle speed without the S; '' until the first `$G`. */
  spindle: string;
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

export interface GrblSettings {
  /** From the startup banner, e.g. '3.7' for "Grbl 3.7 [FluidNC …]"; '' until a banner arrives. */
  version: string;
  parameters: GrblParameters;
  /** `$n=value` lines as strings, e.g. { '$13': '0' }. */
  settings: Record<string, string>;
}

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
  /** null when not holding; M0/M1/M6 in a manual line hold the Feeder. */
  holdReason: HoldReason | null;
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
// Removed-in-phase-1 payloads (autolevel, watch directory)
// ---------------------------------------------------------------------------------------------

/** @deprecated Phase 1 removes this (unused by the UI). */
export interface AutolevelStartParams {
  /** 'test' probes once at the current XY; 'full' (default) probes the grid. */
  mode?: 'full' | 'test';
  startX?: number;
  endX?: number;
  stepX?: number;
  startY?: number;
  endY?: number;
  stepY?: number;
  clearanceZ?: number;
  startZ?: number;
  endZ?: number;
  feedrate?: number;
}

/** @deprecated Phase 1 removes this (unused by the UI). */
export interface AutolevelProbeState {
  /** Work coordinates in mm; XY snapped to the grid node. */
  probedPositions: Array<{ x: number; y: number; z: number }>;
  minZ: number | null;
  maxZ: number | null;
  probePoints: Array<{ x: number; y: number }>;
  config: Omit<AutolevelStartParams, 'mode'> | null;
}

/** @deprecated Phase 1 removes this (unused by the UI). */
export interface AutolevelUpdatePayload {
  current: number;
  total: number;
  probedPos: { x: number; y: number; z: number };
  minZ: number;
  maxZ: number;
  maxDeviation: number;
}

// ---------------------------------------------------------------------------------------------
// Server → client events
// ---------------------------------------------------------------------------------------------

/**
 * Every event the backend emits. "Attached" sockets are those that called `open` for the port
 * (GrblController.addConnection); on attach they get a replay of serialport:open,
 * controller:settings/state, feeder:status, sender:status, gcode:load (if loaded), workflow:state.
 */
export interface ServerEvents {
  /** To the connecting socket, right after the handshake. (CNCEngine) */
  startup: (payload: StartupPayload) => void;
  /** Reply to `list`: detected ports plus rc `ports`. (CNCEngine) */
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
  /** @deprecated Phase 1 removes this (unused by the UI). Legacy duplicate of controller:state. */
  'Grbl:state': (state: GrblState) => void;
  /** @deprecated Phase 1 removes this (unused by the UI). Legacy duplicate of controller:settings. */
  'Grbl:settings': (settings: GrblSettings) => void;
  /** Feeder state changed (checked every tick). */
  'feeder:status': (status: FeederStatus) => void;
  /** Sender state changed (checked every tick). */
  'sender:status': (status: SenderStatus) => void;
  /** Every workflow transition, and on attach. */
  'workflow:state': (state: WorkflowState) => void;
  /**
   * A program was loaded, or a socket attached while one is loaded. `gcode` is the stored text,
   * i.e. the caller's G-code plus "\n%wait ; Wait for the planner to empty". `context` is the
   * load context (see SenderStatus.context: it gains backend keys while streaming).
   */
  'gcode:load': (name: string, gcode: string, context: Record<string, unknown>) => void;
  /** The program was unloaded. */
  'gcode:unload': () => void;
  /** @deprecated Phase 1 removes this (unused by the UI). A probe point was recorded. */
  'autolevel:update': (payload: AutolevelUpdatePayload) => void;
  /** @deprecated Phase 1 removes this (unused by the UI). All probe points recorded. */
  'autolevel:complete': () => void;
  /** rc `events` shell task started (TaskRunner). ALL sockets. Unused by the UI. */
  'task:start': (taskId: string) => void;
  /** rc `events` shell task exited with `code`. ALL sockets. Unused by the UI. */
  'task:finish': (taskId: string, code: number | null) => void;
  /** rc `events` shell task failed to spawn; `err` arrives as a plain object. ALL sockets. Unused by the UI. */
  'task:error': (taskId: string, err: unknown) => void;
  /**
   * The rc file changed on disk; the payload is the WHOLE rc config object. ALL sockets. Unused
   * by the UI.
   */
  'config:change': (config: Record<string, unknown>) => void;
  /** @deprecated Phase 1 removes this (unused by the UI). A watched file changed. ALL sockets. */
  'watchdir:change': (payload: { file: string }) => void;
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
  'Grbl:state',
  'Grbl:settings',
  'feeder:status',
  'sender:status',
  'workflow:state',
  'gcode:load',
  'gcode:unload',
  'autolevel:update',
  'autolevel:complete',
  'task:start',
  'task:finish',
  'task:error',
  'config:change',
  'watchdir:change',
] as const satisfies readonly ServerEventName[];

// ---------------------------------------------------------------------------------------------
// Controller commands: socket.emit('command', port, cmd, ...args) → GrblController.command()
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
  /** @deprecated Phase 1 removes this (unused by the UI). Alias of gcode:start. */
  start: [];
  /** @deprecated Phase 1 removes this (unused by the UI). Alias of gcode:stop. */
  stop: [options?: { force?: boolean }];
  /** @deprecated Phase 1 removes this (unused by the UI). Alias of gcode:pause. */
  pause: [];
  /** @deprecated Phase 1 removes this (unused by the UI). Alias of gcode:resume. */
  resume: [];
  /** @deprecated Phase 1 removes this (unused by the UI). Same as `gcode`. */
  'feeder:feed': [commands: string | string[], context?: WriteContext];
  /** @deprecated Phase 1 removes this (unused by the UI). Writes `~`, unholds and continues the Feeder (not while running). */
  'feeder:start': [];
  /** @deprecated Phase 1 removes this (unused by the UI). Clears the Feeder. */
  'feeder:stop': [];
  /** Writes `!`. */
  feedhold: [];
  /** Writes `~`. */
  cyclestart: [];
  /** @deprecated Phase 1 removes this (unused by the UI). Writes `?`. */
  statusreport: [];
  /** Writes `$H`. */
  homing: [];
  /** @deprecated Phase 1 removes this (unused by the UI). Writes `$SLP`. */
  sleep: [];
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
  /** @deprecated Phase 1 removes this (unused by the UI). 0 or 100 → 0x95, 50 → 0x96, 25 → 0x97. */
  rapidOverride: [value: 0 | 25 | 50 | 100];
  /** Queue lines on the Feeder (split on newlines, blanks dropped); one in flight, dropped in Alarm. */
  gcode: [commands: string | string[], context?: WriteContext];
  /** @deprecated Phase 1 removes this (unused by the UI). Feeds rc macro `id`; callback(null) only on success. */
  'macro:run':
    | [id: string, context?: Record<string, unknown>, callback?: (err: null) => void]
    | [id: string, callback: (err: null) => void];
  /** @deprecated Phase 1 removes this (unused by the UI). Loads rc macro `id` as the program (via gcode:load). */
  'macro:load':
    | [id: string, context?: Record<string, unknown>, callback?: GcodeLoadCallback]
    | [id: string, callback: GcodeLoadCallback];
  /** @deprecated Phase 1 removes this (unused by the UI). Loads a file from the watch directory (via gcode:load). */
  'watchdir:load': [file: string, callback?: GcodeLoadCallback];
  /** @deprecated Phase 1 removes this (unused by the UI). Generates and feeds probe G-code. */
  'autolevel:start': [params?: AutolevelStartParams];
  /** @deprecated Phase 1 removes this (unused by the UI). Sends `reset` and clears the probe state. */
  'autolevel:stop': [];
  /** @deprecated Phase 1 removes this (unused by the UI). The first argument is ignored. */
  'autolevel:getProbeState': [
    ignored: unknown,
    callback?: (err: null, result: { state: AutolevelProbeState }) => void,
  ];
  /** @deprecated Phase 1 removes this (unused by the UI). Reads a server-side file (x y z per line). */
  'autolevel:loadFromFile': [
    filepath: string,
    callback?: (err: string | null, result: { success: boolean; state: AutolevelProbeState | null }) => void,
  ];
  /** @deprecated Phase 1 removes this (unused by the UI). Writes a server-side file. */
  'autolevel:saveToFile': [
    filepath: string,
    callback?: (err: string | null, result: { success: boolean; filepath: string }) => void,
  ];
  /** @deprecated Phase 1 removes this (unused by the UI). */
  'autolevel:applyProbeCompensation': [
    params: { gcode: string; probeData: Array<{ x: number | string; y: number | string; z: number | string }> },
    callback?: (err: null, result: { compensatedGcode: string }) => void,
  ];
}

export type ControllerCommandName = keyof ControllerCommands;

/** Every command name, in GrblController.command()'s handler order. */
export const CONTROLLER_COMMANDS = [
  'gcode:load',
  'gcode:unload',
  'start',
  'gcode:start',
  'stop',
  'gcode:stop',
  'pause',
  'gcode:pause',
  'resume',
  'gcode:resume',
  'feeder:feed',
  'feeder:start',
  'feeder:stop',
  'feedhold',
  'cyclestart',
  'statusreport',
  'homing',
  'sleep',
  'unlock',
  'reset',
  'jogCancel',
  'feedOverride',
  'spindleOverride',
  'rapidOverride',
  'gcode',
  'macro:run',
  'macro:load',
  'watchdir:load',
  'autolevel:start',
  'autolevel:stop',
  'autolevel:getProbeState',
  'autolevel:loadFromFile',
  'autolevel:saveToFile',
  'autolevel:applyProbeCompensation',
] as const satisfies readonly ControllerCommandName[];

// Compile-time check that both lists name every key (`satisfies` above rules out extra names).
type AssertTrue<T extends true> = T;
type ListsAll<List extends readonly string[], Keys extends string> = [Exclude<Keys, List[number]>] extends [never] ? true : false;
export type ProtocolListsComplete = AssertTrue<
  ListsAll<typeof SERVER_EVENTS, ServerEventName> | ListsAll<typeof CONTROLLER_COMMANDS, ControllerCommandName>
>;

// ---------------------------------------------------------------------------------------------
// Client → server events (CNCEngine.js socket.on handlers)
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
