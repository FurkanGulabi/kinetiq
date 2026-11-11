/**
 * One open serial port to a GRBL / FluidNC controller: the coordinator
 * (was src/server/cnc/controllers/Grbl/GrblController.js, CNCjs 1.11.5; split in rewrite phase 4).
 *
 * Owns the parts and wires them together:
 *   connection   SerialConnection (writeFilter from filters.ts)
 *   runner       GrblRunner: received lines → state/settings and per-line events
 *   feeder       Feeder: console / jog / macro lines, one in flight (dataFilter from filters.ts)
 *   sender       Sender: the loaded program, character counting (dataFilter from filters.ts)
 *   workflow     Workflow: idle / running / paused
 *   poller       StatusPoller.ts: the 250 ms query timer, `?` / `$G`, action masks
 *   jobs         JobRunner.ts: gcode:* commands, Sender / Workflow events, program acks
 *   commands     commands.ts: the command table behind command()
 * and does the socket fan-out (addConnection / removeConnection / emit, broadcastChanges),
 * open / close / destroy, write / writeln and setExclusive.
 *
 * Behaviour is CNCjs's, unchanged by the split. In particular the ORDER in which listeners are
 * registered on the feeder, sender, workflow and runner below is the original order (several
 * listeners of one event emit to sockets, so the order is visible), and every serial write,
 * timer and log line is the same.
 *
 * Used by SocketEngine (src/server/engine/SocketEngine.ts), the FluidNC settings
 * exchange (src/server/fluidnc/exchange.ts, machineConfig.ts: setExclusive, connection,
 * runner.settings, workflow.state, writeln, isOpen) and backend.ts closeAllControllers().
 */
import _ from 'lodash';
import EventTrigger from '../events/EventTrigger';
import taskRunner from '../events/TaskRunner';
import Feeder from '../streaming/Feeder';
import type { FeederContext } from '../streaming/Feeder';
import MessageSlot from '../streaming/MessageSlot';
import Sender, { SP_TYPE_CHAR_COUNTING } from '../streaming/Sender';
import type { SenderContext } from '../streaming/Sender';
import SerialConnection from '../serial/SerialConnection';
import Workflow from '../streaming/Workflow';
import GrblRunner from '../grbl/GrblRunner';
import type { GrblRunnerState } from '../grbl/GrblRunner';
import type { GrblAlarmPayload } from '../grbl/parser/GrblLineParserResultAlarm';
import type { GrblErrorPayload } from '../grbl/parser/GrblLineParserResultError';
import type { GrblFeedbackPayload } from '../grbl/parser/GrblLineParserResultFeedback';
import type { GrblOkPayload } from '../grbl/parser/GrblLineParserResultOk';
import type { GrblParametersPayload } from '../grbl/parser/GrblLineParserResultParameters';
import type { GrblParserStatePayload } from '../grbl/parser/GrblLineParserResultParserState';
import type { GrblSettingsPayload } from '../grbl/parser/GrblLineParserResultSettings';
import type { GrblStartupPayload } from '../grbl/parser/GrblLineParserResultStartup';
import type { GrblStatusPayload } from '../grbl/parser/GrblLineParserResultStatus';
import {
  GRBL,
  GRBL_REALTIME_COMMANDS,
  GRBL_ALARMS,
  GRBL_ERRORS,
  GRBL_SETTINGS,
} from '../grbl/constants';
import delay from '../util/delay';
import logger from '../logger';
import store from '../store';
import {
  // Write Source
  WRITE_SOURCE_CLIENT,
  WRITE_SOURCE_FEEDER
} from '../constants';
import type {
  ControllerCommandName,
  ControllerCommands,
  ControllerType,
  FeederStatus,
  GrblSettings,
  GrblState,
  HoldReason,
  OpenOptions,
  SenderStatus,
  SerialPortChangePayload,
  ServerEventName,
  ServerEvents,
  WorkflowState,
  WriteContext,
} from '../protocol';
import StatusPoller from './StatusPoller';
import JobRunner from './JobRunner';
import TravelGuard from './TravelGuard';
import { createCommandTable } from './commands';
import type { CommandTable } from './commands';
import {
  createFeederDataFilter,
  createSenderDataFilter,
  createWriteFilter,
} from './filters';

const log = logger('controller:Grbl');
const noop = _.noop;

/** A runner event payload: the parser payload plus the raw line. */
type WithRaw<T> = T & { raw: string };

/** A Socket.IO socket attached to this port (only `id` and `emit` are used). */
export interface ControllerSocket {
  id: string;
  emit<E extends ServerEventName>(eventName: E, ...args: Parameters<ServerEvents[E]>): unknown;
}

/** The SocketEngine (engine/SocketEngine.ts) that created the controller (only its Socket.IO server is used). */
export interface ControllerEngine {
  io: {
    emit(eventName: 'serialport:change', payload: SerialPortChangePayload): unknown;
  } | null;
}

/** Constructor options, as SocketEngine passes them (`rtscts` already coerced with `!!`). */
export interface GrblControllerOptions {
  port: string;
  baudrate: number;
  rtscts: boolean;
  pin?: OpenOptions['pin'];
}

export type ControllerCallback = (err?: Error | null) => void;

/** The `status` getter (not sent over the socket). */
export interface GrblControllerStatus {
  port: string;
  baudrate: number;
  rtscts: boolean;
  sockets: string[];
  ready: boolean;
  controller: {
    type: ControllerType;
    settings: GrblSettings | EmptyObject;
    state: GrblRunnerState | EmptyObject;
  };
  feeder: FeederStatus;
  sender: SenderStatus;
  workflow: {
    state: WorkflowState;
  };
}

/** `state` and `settings` are `{}` until the first tick that sees the runner's objects. */
type EmptyObject = Record<string, never>;

// lodash `!_.isEmpty(value)` as a type guard for those two fields.
const isFilled = <T extends object>(value: T | EmptyObject): value is T => !_.isEmpty(value);

class GrblController {
  type: ControllerType = GRBL;

  // SocketEngine
  engine: ControllerEngine;

  options: GrblControllerOptions;

  // Sockets
  sockets: Record<string, ControllerSocket> = {};

  // Connection (null after destroy(), as are the other parts below)
  connection: SerialConnection | null = null;

  connectionEventListener = {
    data: (data: string): void => {
      log.silly(`< ${data}`);
      this.runner!.parse('' + data);
    },
    close: (err?: Error | null): void => {
      this.ready = false;
      if (err) {
        log.warn(`Disconnected from serial port "${this.options.port}":`, err);
      }

      this.close(_err => {
        // Remove controller from store
        const port = this.options.port;
        store.unset(`controllers[${JSON.stringify(port)}]`);

        // Destroy controller
        this.destroy();
      });
    },
    error: (err?: Error | null): void => {
      this.ready = false;
      if (err) {
        log.error(`Unexpected error while reading/writing serial port "${this.options.port}":`, err);
      }
    }
  };

  // Grbl
  runner: GrblRunner | null = null;

  // The startup banner or a status report arrived; the poller only queries once ready.
  ready = false;

  // `$$` was sent after the first banner / status report (initController).
  initialized = false;

  // The last state / settings broadcast to the sockets (compared with the runner's by identity).
  state: GrblRunnerState | EmptyObject = {};

  settings: GrblSettings | EmptyObject = {};

  // Message Slot
  messageSlot: MessageSlot<string> | null = null;

  // Event Trigger
  event: EventTrigger | null = null;

  // Feeder
  feeder: Feeder | null = null;

  // Sender
  sender: Sender | null = null;

  // Shared context
  sharedContext: Record<string, unknown> = {};

  // Workflow
  workflow: Workflow | null = null;

  // Kinetiq: exclusive serial access (settings editor XModem transfer). While set, the query
  // timer sends no `?`/`$G` and Feeder lines are dropped, so no byte lands inside a binary
  // transfer. Real-time Hold/Reset written through write() still go out. See setExclusive().
  exclusive = false;

  // Query timer and action masks (CNCjs `queryTimer`, `actionMask`, `actionTime`)
  readonly poller: StatusPoller = new StatusPoller(this);

  // gcode:* commands and the Sender / Workflow events
  readonly jobs: JobRunner = new JobRunner(this);

  // Kinetiq: travel limits (homed axes, jog limiting)
  readonly travel: TravelGuard = new TravelGuard(this);

  // command() handlers
  readonly commands: CommandTable = createCommandTable(this);

  constructor(engine: ControllerEngine, options: GrblControllerOptions) {
    if (!engine) {
      throw new Error('engine must be specified');
    }
    this.engine = engine;

    const { port, baudrate, rtscts, pin } = { ...options };
    this.options = {
      port: port,
      baudrate: baudrate,
      rtscts: rtscts,
      pin,
    };

    // Connection
    this.connection = new SerialConnection({
      path: port,
      baudRate: baudrate,
      rtscts: rtscts,
      writeFilter: createWriteFilter(this),
    });

    // Message Slot
    this.messageSlot = new MessageSlot<string>();

    // Event Trigger
    this.event = new EventTrigger((event, trigger, commands) => {
      log.debug(`EventTrigger: event="${event}", trigger="${trigger}", commands="${commands}"`);
      if (trigger === 'system') {
        // rc entries are not validated: a 'system' entry without `commands` hands undefined to
        // the shell runner, as in CNCjs (it then fails to spawn).
        taskRunner.run(commands as string);
      } else {
        this.command('gcode', commands);
      }
    });

    // Feeder
    this.feeder = new Feeder({
      dataFilter: createFeederDataFilter(this),
    });
    this.feeder.on('data', (line: string = '', context: FeederContext = {}) => {
      this.onFeederData(line, context);
    });
    this.feeder.on('hold', noop);
    this.feeder.on('unhold', noop);

    // Sender
    this.sender = new Sender(SP_TYPE_CHAR_COUNTING, {
      // Deduct the buffer size to prevent from buffer overrun
      bufferSize: (128 - 8), // The default buffer size is 128 bytes
      dataFilter: createSenderDataFilter(this),
    });
    this.sender.on('data', (line: string = '', context: SenderContext = {}) => {
      this.jobs.onSenderData(line, context);
    });
    this.sender.on('hold', noop);
    this.sender.on('unhold', noop);
    this.sender.on('start', (_startTime: number) => {
      this.poller.onSenderStart();
    });
    this.sender.on('end', (finishTime: number) => {
      this.poller.onSenderEnd(finishTime);
    });

    // Workflow
    this.workflow = new Workflow();
    this.workflow.on('start', () => {
      this.jobs.onWorkflowStart();
    });
    this.workflow.on('stop', () => {
      this.jobs.onWorkflowStop();
    });
    this.workflow.on('pause', (...args: HoldReason[]) => {
      this.jobs.onWorkflowPause(...args);
    });
    this.workflow.on('resume', () => {
      this.jobs.onWorkflowResume();
    });

    // Grbl
    this.runner = new GrblRunner();

    this.runner.on('raw', noop);

    this.runner.on('status', (res: WithRaw<GrblStatusPayload>) => {
      /**
       * Handle the scenario where a startup message is not received during UART communication.
       * A status query (?) will be issued in the `queryActivity` function.
       */
      if (!this.ready) {
        this.ready = true;

        // Reset the state
        this.poller.clearActionValues();
      }
      if (!this.initialized) {
        this.initialized = true;

        // Initialize controller
        this.initController();
      }

      this.poller.onStatus(res);
      this.travel.onStatus(res.activeState);
    });

    this.runner.on('ok', (res: WithRaw<GrblOkPayload>) => {
      // The ok of a `$G` query
      if (this.poller.onOk(res)) {
        return;
      }

      // A program line
      if (this.jobs.onOk(res)) {
        return;
      }

      this.emit('serialport:read', res.raw);

      // Feeder
      this.feeder!.next();
    });

    this.runner.on('error', (res: WithRaw<GrblErrorPayload>) => {
      const code = Number(res.message) || undefined;
      const error = _.find(GRBL_ERRORS, { code: code });

      // A program line
      if (this.jobs.onError(res, code, error)) {
        return;
      }

      if (error) {
        // Grbl v1.1
        this.emit('serialport:read', `error:${code} (${error.message})`);
      } else {
        // Grbl v0.9
        this.emit('serialport:read', res.raw);
      }

      // Feeder
      this.feeder!.next();
    });

    this.runner.on('alarm', (res: WithRaw<GrblAlarmPayload>) => {
      const code = Number(res.message) || undefined;
      this.travel.onAlarm(code);
      const alarm = _.find(GRBL_ALARMS, { code: code });

      if (alarm) {
        // Grbl v1.1
        this.emit('serialport:read', `ALARM:${code} (${alarm.message})`);
      } else {
        // Grbl v0.9
        this.emit('serialport:read', res.raw);
      }
    });

    this.runner.on('parserstate', (res: WithRaw<GrblParserStatePayload>) => {
      this.poller.onParserState(res);
    });

    this.runner.on('parameters', (res: WithRaw<GrblParametersPayload>) => {
      this.emit('serialport:read', res.raw);
    });

    this.runner.on('feedback', (res: WithRaw<GrblFeedbackPayload>) => {
      this.emit('serialport:read', res.raw);
    });

    this.runner.on('settings', (res: WithRaw<GrblSettingsPayload>) => {
      const setting = _.find(GRBL_SETTINGS, { setting: res.name });

      if (!res.message && setting) {
        // Grbl v1.1
        this.emit('serialport:read', `${res.name}=${res.value} (${setting.message}, ${setting.units})`);
      } else {
        // Grbl v0.9
        this.emit('serialport:read', res.raw);
      }
    });

    this.runner.on('startup', (res: WithRaw<GrblStartupPayload>) => {
      this.emit('serialport:read', res.raw);
      this.travel.onStartup();

      if (!this.ready) {
        // The startup message always prints upon startup, after a reset, or at program end.
        // Setting the initial state when Grbl has completed re-initializing all systems.
        this.poller.clearActionValues();

        // Set ready flag to true when a startup message has arrived
        this.ready = true;
      }

      if (!this.initialized) {
        this.initialized = true;

        // Initialize controller
        this.initController();
      }
    });

    this.runner.on('others', (res: { raw: string }) => {
      this.emit('serialport:read', res.raw);
    });

    // The query timer (250 ms)
    this.poller.start();
  }

  async initController(): Promise<void> {
    // https://github.com/cncjs/cncjs/issues/206
    // $13=0 (report in mm)
    // $13=1 (report in inches)
    this.writeln('$$');

    await delay(50);
    this.event!.trigger('controller:ready');
  }

  // Feeder 'data': a filtered console / jog line.
  private onFeederData(line: string, context: FeederContext): void {
    if (this.isClose()) {
      log.error(`Serial port "${this.options.port}" is not accessible`);
      return;
    }

    if (this.runner!.isAlarm()) {
      this.feeder!.reset();
      log.warn('Stopped sending G-code commands in Alarm mode');
      return;
    }

    // Kinetiq: drop Feeder lines while the serial port is used exclusively
    if (this.exclusive) {
      this.feeder!.reset();
      log.warn('Dropped a G-code command: the serial port is in exclusive use');
      return;
    }

    line = String(line).trim();
    if (line.length === 0) {
      return;
    }

    this.emit('serialport:write', line + '\n', {
      ...context,
      source: WRITE_SOURCE_FEEDER
    });

    this.connection!.write(line + '\n');
    log.silly(`> ${line}`);
  }

  /**
   * The broadcast half of each query-timer tick (StatusPoller): feeder:status and sender:status
   * when changed, then controller:settings and controller:state when the runner replaced its
   * objects. Returns whether the work position is unchanged since the previous broadcast state
   * (compared before `state` is replaced), which the poller uses to detect the end of a program.
   */
  broadcastChanges(): boolean {
    const runner = this.runner!;

    // Feeder
    if (this.feeder!.peek()) {
      this.emit('feeder:status', this.feeder!.toJSON());
    }

    // Sender
    if (this.sender!.peek()) {
      this.emit('sender:status', this.sender!.toJSON());
    }

    const zeroOffset = _.isEqual(
      runner.getWorkPosition(this.state),
      runner.getWorkPosition(runner.state)
    );

    // Grbl settings
    if (this.settings !== runner.settings) {
      const settings = runner.settings;
      this.settings = settings;
      this.emit('controller:settings', GRBL, settings);
    }

    // Grbl state
    if (this.state !== runner.state) {
      const state = runner.state;
      this.state = state;
      // On the wire as GrblState: only coolant is ever an array on real firmware (protocol.ts).
      this.emit('controller:state', GRBL, state as GrblState);
    }

    return zeroOffset;
  }

  destroy(): void {
    // Query timer
    this.poller.stop();

    if (this.runner) {
      this.runner.removeAllListeners();
      this.runner = null;
    }

    this.sockets = {};

    if (this.connection) {
      this.connection = null;
    }

    if (this.messageSlot) {
      this.messageSlot = null;
    }

    if (this.event) {
      this.event = null;
    }

    if (this.feeder) {
      this.feeder = null;
    }

    if (this.sender) {
      this.sender = null;
    }

    if (this.workflow) {
      this.workflow = null;
    }
  }

  get status(): GrblControllerStatus {
    return {
      port: this.options.port,
      baudrate: this.options.baudrate,
      rtscts: this.options.rtscts,
      sockets: Object.keys(this.sockets),
      ready: this.ready,
      controller: {
        type: this.type,
        settings: this.settings,
        state: this.state
      },
      feeder: this.feeder!.toJSON(),
      sender: this.sender!.toJSON(),
      workflow: {
        state: this.workflow!.state
      }
    };
  }

  open(callback: ControllerCallback = noop): void {
    const { port, baudrate, pin } = this.options;

    // Assertion check
    if (this.isOpen()) {
      log.error(`Cannot open serial port "${port}"`);
      return;
    }

    const connection = this.connection!;
    connection.on('data', this.connectionEventListener.data);
    connection.on('close', this.connectionEventListener.close);
    connection.on('error', this.connectionEventListener.error);

    connection.open(async (err) => {
      if (err) {
        log.error(`Error opening serial port "${port}":`, err);
        this.emit('serialport:error', { err: err, port: port });
        callback(err); // notify error
        return;
      }

      // (asserted, not annotated, so TS does not narrow it to null before the spreads below)
      let setOptions = null as { dtr?: boolean; rts?: boolean } | null;
      try {
        // Set DTR and RTS control flags if they exist
        if (typeof pin?.dtr === 'boolean') {
          setOptions = {
            ...setOptions,
            dtr: pin?.dtr,
          };
        }
        if (typeof pin?.rts === 'boolean') {
          setOptions = {
            ...setOptions,
            rts: pin?.rts,
          };
        }

        if (setOptions) {
          await delay(100);
          // CNCjs quirk (BACKEND_INTEGRATION.md §7.3 bug 7, kept): serialport v10's set() is callback-based and
          // returns void, so this await does not wait for the flags to be set.
          await this.connection!.port!.set(setOptions);
          await delay(100);
        }
      } catch (err) {
        log.error('Failed to set control flags:', { err, port });
      }

      this.emit('serialport:open', {
        port: port,
        baudrate: baudrate,
        controllerType: this.type,
        inuse: true
      });

      // Emit a change event to all connected sockets
      if (this.engine.io) {
        this.engine.io.emit('serialport:change', {
          port: port,
          inuse: true
        });
      }

      callback(); // register controller

      log.debug(`Connected to serial port "${port}"`);

      this.workflow!.stop();

      // Clear action values
      this.poller.clearActionValues();

      if (this.sender!.state.gcode) {
        // Unload G-code
        this.command('gcode:unload'); // Kinetiq: CNCjs called the nonexistent 'unload'
      }
    });
  }

  close(callback: (err: Error | null) => void): void {
    const { port } = this.options;

    // Assertion check
    if (!this.connection) {
      const err = `Serial port "${port}" is not available`;
      callback(new Error(err));
      return;
    }

    // Stop status query
    this.ready = false;

    // Clear initialized flag
    this.initialized = false;

    this.emit('serialport:close', {
      port: port,
      inuse: false
    });

    // Emit a change event to all connected sockets
    if (this.engine.io) {
      this.engine.io.emit('serialport:change', {
        port: port,
        inuse: false
      });
    }

    if (this.isClose()) {
      callback(null);
      return;
    }

    this.connection.removeAllListeners();
    this.connection.close(callback);
  }

  // Kinetiq: claim or release exclusive use of the serial port (see `exclusive` above).
  setExclusive(exclusive: boolean): void {
    this.exclusive = !!exclusive;
    if (!this.exclusive) {
      // Let the status/parser-state queries start fresh instead of waiting for replies that
      // were swallowed during the exclusive period.
      this.poller.clearActionValues();
    }
  }

  // CNCjs quirk: null (not false) when there is no connection or no port.
  isOpen(): boolean | null {
    return this.connection && this.connection.isOpen;
  }

  isClose(): boolean {
    return !(this.isOpen());
  }

  addConnection(socket: ControllerSocket): void {
    if (!socket) {
      log.error('The socket parameter is not specified');
      return;
    }

    log.debug(`Add socket connection: id=${socket.id}`);
    this.sockets[socket.id] = socket;

    //
    // Send data to newly connected client
    //
    if (this.isOpen()) {
      socket.emit('serialport:open', {
        port: this.options.port,
        baudrate: this.options.baudrate,
        controllerType: this.type,
        inuse: true
      });
    }
    if (isFilled(this.settings)) {
      // controller settings
      socket.emit('controller:settings', GRBL, this.settings);
    }
    if (isFilled(this.state)) {
      // controller state (see broadcastChanges for the GrblState narrowing)
      socket.emit('controller:state', GRBL, this.state as GrblState);
    }
    if (this.feeder) {
      // feeder status
      socket.emit('feeder:status', this.feeder.toJSON());
    }
    if (this.sender) {
      // sender status
      socket.emit('sender:status', this.sender.toJSON());

      const { name, gcode, context } = this.sender.state;
      if (gcode) {
        socket.emit('gcode:load', name, gcode, context);
      }
    }
    if (this.workflow) {
      // workflow state
      socket.emit('workflow:state', this.workflow.state);
    }
    // Kinetiq: travel limits and homed axes
    socket.emit('machine:limits', this.travel.toJSON());
  }

  removeConnection(socket: ControllerSocket): void {
    if (!socket) {
      log.error('The socket parameter is not specified');
      return;
    }

    log.debug(`Remove socket connection: id=${socket.id}`);
    // CNCjs also assigned undefined first; with the synchronous delete right after it that had
    // no effect.
    delete this.sockets[socket.id];
  }

  emit<E extends ServerEventName>(eventName: E, ...args: Parameters<ServerEvents[E]>): void {
    Object.keys(this.sockets).forEach(id => {
      const socket = this.sockets[id];
      socket.emit(eventName, ...args);
    });
  }

  /**
   * Runs a command from the table in commands.ts. Unknown names are logged and ignored.
   */
  command<C extends ControllerCommandName>(cmd: C, ...args: ControllerCommands[C]): void;
  command(cmd: string, ...args: unknown[]): void;
  command(cmd: string, ...args: unknown[]): void {
    // Socket input is not validated: the arguments go to the handler as they arrived.
    const table = this.commands as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
    // Kinetiq (BACKEND_INTEGRATION.md §7.3 bug 8, fixed): own properties only. CNCjs indexed the plain
    // object directly, so an inherited name such as 'toString', 'valueOf', 'constructor' or
    // '__proto__' found an Object.prototype member (returned, threw a TypeError, or threw "handler
    // is not a function") instead of reaching "Unknown command" below.
    const handler = Object.prototype.hasOwnProperty.call(table, cmd) ? table[cmd] : undefined;

    if (!handler) {
      log.error(`Unknown command: ${cmd}`);
      return;
    }

    handler(...args);
  }

  write(data: string, context?: WriteContext): void {
    // Assertion check
    if (this.isClose()) {
      log.error(`Serial port "${this.options.port}" is not accessible`);
      return;
    }

    const cmd = data.trim();

    // Kinetiq: a jog typed in the console is held to the travel limits like any other jog.
    if (/^\$J\s*=/i.test(cmd)) {
      const jog = this.travel.filterJog(cmd);
      if (jog === null) {
        return;
      }
      if (jog !== cmd) {
        data = jog + '\n';
      }
    }

    this.poller.onWrite(cmd);

    this.emit('serialport:write', data, {
      ...context,
      source: WRITE_SOURCE_CLIENT
    });
    this.connection!.write(data);
    log.silly(`> ${data}`);
  }

  writeln(data: string, context?: WriteContext): void {
    // https://github.com/gnea/grbl/blob/master/doc/markdown/commands.md#grbl-v11-realtime-commands
    const isASCIIRealtimeCommand = _.includes(GRBL_REALTIME_COMMANDS as readonly string[], data);
    const isExtendedASCIIRealtimeCommand = String(data).match(/[\x80-\xff]/);
    const isRealtimeCommand = isASCIIRealtimeCommand || isExtendedASCIIRealtimeCommand;

    if (isRealtimeCommand) {
      this.write(data, context);
    } else {
      this.write(data + '\n', context);
    }
  }
}

export default GrblController;
