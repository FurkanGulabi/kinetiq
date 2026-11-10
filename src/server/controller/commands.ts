/**
 * The controller command table: `socket.emit('command', port, cmd, ...args)` → SocketEngine →
 * GrblController.command(cmd, ...args) → the handler below
 * (moved out of GrblController.js `command()`, CNCjs 1.11.5).
 *
 * Names and argument tuples are ControllerCommands in src/server/protocol.ts; keys are in the order
 * of CONTROLLER_COMMANDS. Program commands are delegated to JobRunner; the rest write real-time
 * bytes or lines through GrblController.write()/writeln() (echoed as `serialport:write`, source
 * 'client'), or queue lines on the Feeder.
 *
 * Extended real-time bytes (jog cancel 0x85, overrides 0x90–0x9D) are JS strings, so they reach
 * the port UTF-8 encoded as `0xC2 0x85` etc. (docs/BACKEND_REWRITE_PLAN.md §3a bug 4, kept until a
 * hardware check).
 */
import ensureArray from '../util/ensureArray';
import type { ControllerCommandName, ControllerCommands } from '../protocol';
import type GrblController from './GrblController';

export type CommandHandler<C extends ControllerCommandName> = (...args: ControllerCommands[C]) => void | Promise<void>;

export type CommandTable = { [C in ControllerCommandName]: CommandHandler<C> };

/**
 * Builds the table: a plain object literal, as in CNCjs. GrblController.command() looks names up
 * as own properties only, so inherited Object.prototype names are unknown commands (plan §3a bug 8).
 */
export const createCommandTable = (controller: GrblController): CommandTable => ({
  'gcode:load': (name, gcode, context?, callback?) => {
    controller.jobs.load(name, gcode, context, callback);
  },
  'gcode:unload': () => {
    controller.jobs.unload();
  },
  'gcode:start': () => {
    controller.jobs.start();
  },
  // @param {object} options The options object.
  // @param {boolean} [options.force] Whether to force stop a G-code program. Defaults to false.
  'gcode:stop': (options) => controller.jobs.stop(options),
  'gcode:pause': () => {
    controller.jobs.pause();
  },
  'gcode:resume': () => {
    controller.jobs.resume();
  },
  'feedhold': () => {
    controller.event!.trigger('feedhold');

    controller.write('!');
  },
  'cyclestart': () => {
    controller.event!.trigger('cyclestart');

    controller.write('~');
  },
  'homing': () => {
    controller.event!.trigger('homing');

    controller.writeln('$H');
  },
  'unlock': () => {
    controller.writeln('$X');
  },
  'reset': () => {
    controller.workflow!.stop();

    controller.feeder!.reset();

    controller.write('\x18'); // ^x
  },
  'jogCancel': () => {
    // https://github.com/gnea/grbl/blob/master/doc/markdown/jogging.md
    controller.write('\x85');
  },
  // Feed Overrides
  // @param {number} value The amount of percentage increase or decrease.
  //   0: Set 100% of programmed rate.
  //  10: Increase 10%
  // -10: Decrease 10%
  //   1: Increase 1%
  //  -1: Decrease 1%
  'feedOverride': (value) => {
    if (value === 0) {
      controller.write('\x90');
    } else if (value === 10) {
      controller.write('\x91');
    } else if (value === -10) {
      controller.write('\x92');
    } else if (value === 1) {
      controller.write('\x93');
    } else if (value === -1) {
      controller.write('\x94');
    }
  },
  // Spindle Speed Overrides
  // @param {number} value The amount of percentage increase or decrease.
  //   0: Set 100% of programmed spindle speed
  //  10: Increase 10%
  // -10: Decrease 10%
  //   1: Increase 1%
  //  -1: Decrease 1%
  'spindleOverride': (value) => {
    if (value === 0) {
      controller.write('\x99');
    } else if (value === 10) {
      controller.write('\x9a');
    } else if (value === -10) {
      controller.write('\x9b');
    } else if (value === 1) {
      controller.write('\x9c');
    } else if (value === -1) {
      controller.write('\x9d');
    }
  },
  'gcode': (commands, context) => {
    const data = ensureArray(commands)
      .join('\n')
      .split(/\r?\n/)
      .filter(line => {
        if (typeof line !== 'string') {
          return false;
        }

        return line.trim().length > 0;
      });

    const feeder = controller.feeder!;
    feeder.feed(data, context);

    if (!feeder.isPending()) {
      feeder.next();
    }
  },
  // Kinetiq: travel measurement ("reverse homing"), TravelGuard
  'travel:measure': (axis) => controller.travel.startMeasure(axis),
  'travel:apply': () => controller.travel.applyMeasure(),
  'travel:dismiss': () => controller.travel.dismissMeasure(),
  'travel:backoff': () => controller.travel.backoff(),
});
