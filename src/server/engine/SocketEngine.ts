/**
 * The Socket.IO 4 server the browser talks to
 * (was src/server/cnc/services/cncengine/CNCEngine.js, CNCjs 1.11.5; ported unchanged in rewrite phase 5,
 * moved from Socket.IO 2.2 to 4 afterwards).
 *
 * Handshake: authenticateSocketToken() verifies the session token (`auth: { token }`, minted by
 * session.ts; replaces socketio-jwt), then authorizeIPAddress() and validateUser() (session.ts) run,
 * in that order. A rejected handshake never reaches 'connection'; the client gets `connect_error`.
 *
 * Per socket: `startup` on connect, then the client events of ClientEvents (src/server/protocol.ts):
 * `list`, `open`, `close`, `command`, `write`, `writeln`. Open controllers live in the store
 * (`controllers[port]`, src/server/store.ts); `open` creates one or reuses it, `close` closes and
 * destroys it. Each controller fans out to the sockets attached to it (GrblController.addConnection);
 * this engine's `io` is used for the all-socket events (`serialport:change`, `task:*`).
 *
 * The event names, payloads, ordering, callbacks and log lines are CNCjs's. Only the Grbl
 * controller is registered (FluidNC speaks GRBL-compatible serial).
 */
import type http from 'http';
import { SerialPort } from 'serialport';
import { Server, type Socket } from 'socket.io';
import EventTrigger from '../events/EventTrigger';
import logger from '../logger';
import store from '../store';
import config from '../config/ConfigStore';
import taskRunner from '../events/TaskRunner';
import GrblController from '../controller/GrblController';
import { GRBL } from '../grbl/constants';
import ensureArray from '../util/ensureArray';
import { authenticateSocketToken, authorizeIPAddress, validateUser, type SessionUser } from '../session';
import type {
  AckCallback,
  ClientEvents,
  ControllerType,
  ServerEvents,
  WriteContext
} from '../protocol';

const log = logger('service:cncengine');

const noop = (): void => {};

/** Per-socket data: the verified session token payload, set by the handshake middleware. */
interface EngineSocketData {
  user: SessionUser;
}

/** The engine's Socket.IO server: handlers typed by ClientEvents, emit() by ServerEvents. */
type EngineServer = Server<ClientEvents, ServerEvents, Record<string, never>, EngineSocketData>;

/** A connected socket of EngineServer. */
type EngineSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, EngineSocketData>;

/** A port as listed: detected by serialport, or an rc `ports` entry (not validated, as in CNCjs). */
interface ListedPort {
  path: string;
  manufacturer?: string;
}

type ControllerClass = typeof GrblController;

// Case-insensitive equality checker.
// @param {string} str1 First string to check.
// @param {string} str2 Second string to check.
// @return {boolean} True if str1 and str2 are the same string, ignoring case.
const caseInsensitiveEquals = (str1: unknown, str2: unknown): boolean => {
  str1 = str1 ? (str1 + '').toUpperCase() : '';
  str2 = str2 ? (str2 + '').toUpperCase() : '';
  return str1 === str2;
};

// Kinetiq ships only the Grbl controller (FluidNC speaks GRBL-compatible serial).
const isValidController = (controller: string): boolean => (
  // Grbl
  caseInsensitiveEquals(GRBL, controller)
);

class SocketEngine {
    // Looked up by own property only (see the `open` handler).
    controllerClass: Record<string, ControllerClass | undefined> = {};

    listener = {
      taskStart: (...args: Parameters<ServerEvents['task:start']>) => {
        if (this.io) {
          this.io.emit('task:start', ...args);
        }
      },
      taskFinish: (...args: Parameters<ServerEvents['task:finish']>) => {
        if (this.io) {
          this.io.emit('task:finish', ...args);
        }
      },
      taskError: (...args: Parameters<ServerEvents['task:error']>) => {
        if (this.io) {
          this.io.emit('task:error', ...args);
        }
      }
      // Kinetiq: no configChange listener. CNCjs broadcast the whole rc config on every change,
      // including the JWT `secret`, as 'config:change' to every socket; the UI never used it.
    };

    server: http.Server | null = null;

    io: EngineServer | null = null;

    sockets: EngineSocket[] = [];

    // Event Trigger
    event = new EventTrigger((event, trigger, commands) => {
      log.debug(`EventTrigger: event="${event}", trigger="${trigger}", commands="${commands}"`);
      if (trigger === 'system') {
        // rc entries are not validated: a 'system' entry without `commands` hands undefined to
        // the shell runner, as in CNCjs (it then fails to spawn).
        taskRunner.run(commands as string);
      }
    });

    // @param {object} server The HTTP server instance.
    // @param {string} controller Specify CNC controller.
    start(server: http.Server, controller = ''): void {
      // Fallback to an empty string if the controller is not valid
      if (!isValidController(controller)) {
        controller = '';
      }

      // Grbl
      if (!controller || caseInsensitiveEquals(GRBL, controller)) {
        this.controllerClass[GRBL] = GrblController;
      }

      if (Object.keys(this.controllerClass).length === 0) {
        throw new Error(`No valid CNC controller specified (${controller})`);
      }

      const loadedControllers = Object.keys(this.controllerClass);
      log.debug(`Loaded controllers: ${loadedControllers}`);

      this.stop();

      taskRunner.on('start', this.listener.taskStart);
      taskRunner.on('finish', this.listener.taskFinish);
      taskRunner.on('error', this.listener.taskError);

      // System Trigger: Startup
      this.event.trigger('startup');

      this.server = server;
      // Kinetiq: Socket.IO 4 defaults are kept on purpose: no `cors` option, so no CORS headers
      // (other origins cannot read polling responses; the session token is still the real gate), and
      // no `allowEIO3` (v2 clients cannot connect). Nothing loads /socket.io/socket.io.js (the UI
      // bundles socket.io-client), so the client script is not served.
      const io: EngineServer = new Server(this.server, {
        serveClient: false,
        path: '/socket.io'
      });
      this.io = io;

      // Kinetiq: the token check that socketio-jwt did (`handshake: true`), as a plain middleware.
      // Token from `auth: { token }`, HS256 only, against settings.secret (session.ts).
      io.use((socket, next) => {
        try {
          socket.data.user = authenticateSocketToken(socket.handshake.auth?.token);
        } catch (err) {
          log.warn(err);
          next(err as Error); // carries `data` ({ type, code }) to the client's connect_error
          return;
        }
        next();
      });

      io.use(async (socket, next) => {
        try {
          // IP Address Access Control
          const ipaddr = socket.handshake.address;
          await authorizeIPAddress(ipaddr);

          // User Validation
          const user = socket.data.user || {};
          await validateUser(user);
        } catch (err) {
          log.warn(err);
          next(err as Error); // both checks reject with an Error
          return;
        }

        next();
      });

      io.on('connection', (socket: EngineSocket) => {
        const address = socket.handshake.address;
        const user = socket.data.user || {};
        log.debug(`New connection from ${address}: id=${socket.id}, user.id=${user.id}, user.name=${user.name}`);

        // Add to the socket pool
        this.sockets.push(socket);

        socket.emit('startup', {
          // Only keys this engine registered (start() above).
          loadedControllers: Object.keys(this.controllerClass) as ControllerType[],

          // User-defined baud rates and ports
          baudrates: ensureArray(config.get<number[]>('baudrates', [])),
          ports: ensureArray(config.get<unknown[]>('ports', []))
        });

        socket.on('disconnect', () => {
          log.debug(`Disconnected from ${address}: id=${socket.id}, user.id=${user.id}, user.name=${user.name}`);

          const controllers = store.get<Record<string, GrblController | undefined>>('controllers', {});
          Object.keys(controllers).forEach(port => {
            const controller = controllers[port];
            if (!controller) {
              return;
            }
            controller.removeConnection(socket);
          });

          // Remove from socket pool
          this.sockets.splice(this.sockets.indexOf(socket), 1);
        });

        // List the available serial ports
        socket.on('list', () => {
          log.debug(`socket.list(): id=${socket.id}`);

          const emitPorts = (detected: ListedPort[]) => {
            const ports = detected.concat(ensureArray(config.get<ListedPort[]>('ports', [])));

            const controllers = store.get<Record<string, GrblController | undefined>>('controllers', {});
            const portsInUse = Object.keys(controllers)
              .filter(port => {
                const controller = controllers[port];
                return controller && controller.isOpen();
              });

            socket.emit('serialport:list', ports.map(port => {
              return {
                port: port.path,
                manufacturer: port.manufacturer,
                inuse: portsInUse.indexOf(port.path) >= 0
              };
            }));
          };

          SerialPort.list()
            .then(ports => emitPorts(ports))
            .catch(err => {
              // Kinetiq: detection can fail where udev is missing (containers, minimal Linux:
              // "spawn udevadm ENOENT"). Still answer, with the ports from the rc file, so the
              // UI does not wait on "Loading ports..." forever and configured ports stay usable.
              log.error(err);
              emitPorts([]);
            });
        });

        // Open serial port
        socket.on('open', (port, options, callback: AckCallback = noop) => {
          if (typeof callback !== 'function') {
            callback = noop;
          }

          log.debug(`socket.open("${port}", ${JSON.stringify(options)}): id=${socket.id}`);

          let controller = store.get<GrblController | undefined>(`controllers["${port}"]`);
          if (!controller) {
            // Socket input is not validated: these are whatever the client sent.
            let { controllerType = GRBL, baudrate, rtscts, pin } = { ...options } as Partial<typeof options>;

            // Kinetiq: own-property lookup, like GrblController.command() (BACKEND_INTEGRATION.md §7.3 bug 8), so a
            // controllerType such as 'constructor' is "Not supported" instead of reaching Object.
            const Controller = Object.prototype.hasOwnProperty.call(this.controllerClass, controllerType)
              ? this.controllerClass[controllerType]
              : undefined;
            if (!Controller) {
              const err = `Not supported controller: ${controllerType}`;
              log.error(err);
              callback(new Error(err));
              return;
            }

            const engine = this;
            controller = new Controller(engine, {
              port: port,
              baudrate: baudrate as number, // SerialConnection's constructor throws if not a number
              rtscts: !!rtscts,
              pin,
            });
          }

          controller.addConnection(socket);

          if (controller.isOpen()) {
            // Join the room
            socket.join(port);

            callback(null);
            return;
          }

          controller.open((err = null) => {
            if (err) {
              callback(err);
              return;
            }

            // System Trigger: Open a serial port
            this.event.trigger('port:open');

            if (store.get(`controllers["${port}"]`)) {
              log.error(`Serial port "${port}" was not properly closed`);
            }
            store.set(`controllers[${JSON.stringify(port)}]`, controller);

            // Join the room
            socket.join(port);

            callback(null);
          });
        });

        // Close serial port
        socket.on('close', (port, callback: AckCallback = noop) => {
          if (typeof callback !== 'function') {
            callback = noop;
          }

          log.debug(`socket.close("${port}"): id=${socket.id}`);

          const controller = store.get<GrblController | undefined>(`controllers["${port}"]`);
          if (!controller) {
            const err = `Serial port "${port}" not accessible`;
            log.error(err);
            callback(new Error(err));
            return;
          }

          // System Trigger: Close a serial port
          this.event.trigger('port:close');

          // Leave the room
          socket.leave(port);

          controller.close(() => {
            // Remove controller from store
            store.unset(`controllers[${JSON.stringify(port)}]`);

            // Destroy controller
            controller.destroy();

            callback(null);
          });
        });

        socket.on('command', (port, cmd, ...args) => {
          log.debug(`socket.command("${port}", "${cmd}"): id=${socket.id}`);

          const controller = store.get<GrblController | undefined>(`controllers["${port}"]`);
          if (!controller || controller.isClose()) {
            log.error(`Serial port "${port}" not accessible`);
            return;
          }

          // Was `controller.command.apply(controller, [cmd].concat(args))`: the same call.
          controller.command(cmd, ...args);
        });

        socket.on('write', (port, data, context: WriteContext = {}) => {
          log.debug(`socket.write("${port}", "${data}", ${JSON.stringify(context)}): id=${socket.id}`);

          const controller = store.get<GrblController | undefined>(`controllers["${port}"]`);
          if (!controller || controller.isClose()) {
            log.error(`Serial port "${port}" not accessible`);
            return;
          }

          controller.write(data, context);
        });

        socket.on('writeln', (port, data, context: WriteContext = {}) => {
          log.debug(`socket.writeln("${port}", "${data}", ${JSON.stringify(context)}): id=${socket.id}`);

          const controller = store.get<GrblController | undefined>(`controllers["${port}"]`);
          if (!controller || controller.isClose()) {
            log.error(`Serial port "${port}" not accessible`);
            return;
          }

          controller.writeln(data, context);
        });
      });
    }

    stop(): void {
      if (this.io) {
        this.io.close();
        this.io = null;
      }
      this.sockets = [];
      this.server = null;

      taskRunner.removeListener('start', this.listener.taskStart);
      taskRunner.removeListener('finish', this.listener.taskFinish);
      taskRunner.removeListener('error', this.listener.taskError);
    }
}

export default SocketEngine;
