/**
 * The filters every line passes through on its way to the controller
 * (moved out of src/server/cnc/controllers/Grbl/GrblController.js, CNCjs 1.11.5):
 *
 *   createWriteFilter        SerialConnection writeFilter: tracks `$13=` (report inches) writes
 *   createFeederDataFilter   Feeder (console, jog, macros): `%msg`, `%wait`, `%var=`, `[expr]`,
 *                            M0/M1 hold the Feeder, M6 is commented out and holds the Feeder
 *   createSenderDataFilter   Sender (the loaded program): the same language, but M0/M1/M6 pause
 *                            the Workflow and fire the `gcode:pause` rc event
 *   populateContext          the variables `[expr]` / `%var=` can read (machine and work position,
 *                            modal state, tool, parameters, bounding box, `global`, GLOBAL_OBJECTS)
 *
 * Ported line by line: what a filter returns is exactly what reaches the serial port.
 * Known quirks kept as they are (docs/BACKEND_REWRITE_PLAN.md §3a):
 *   - bug 3: `%wait` typed in the console holds the Sender, not the Feeder.
 *   - bug 6: the Sender runs its dataFilter a second time on a line that did not fit in the RX
 *     buffer, so everything below can run twice for one program line.
 */
/// <reference path="../../types/gcode-parser.d.ts" />
import * as gcodeParser from 'gcode-parser';
import { evaluateAssignmentExpression, translateExpression } from '../streaming/expressions';
import { isM0, isM1, isM6, matchBuiltinCommand, replaceM6 } from '../streaming/builtins';
import type { FeederContext, FeederDataFilter } from '../streaming/Feeder';
import type { SenderContext, SenderDataFilter } from '../streaming/Sender';
import type { SerialConnectionWriteFilter } from '../serial/SerialConnection';
import type Feeder from '../streaming/Feeder';
import type Sender from '../streaming/Sender';
import type Workflow from '../streaming/Workflow';
import type MessageSlot from '../streaming/MessageSlot';
import type EventTrigger from '../events/EventTrigger';
import type GrblRunner from '../grbl/GrblRunner';
import ensureArray from '../util/ensureArray';
import x from '../util/jsonStringify';
import logger from '../logger';
import {
  GLOBAL_OBJECTS as globalObjects,
  // Builtin Commands
  BUILTIN_COMMAND_MSG,
  BUILTIN_COMMAND_WAIT,
} from '../constants';
import type GrblController from './GrblController';

const log = logger('controller:Grbl');

// The controller's parts are null only after destroy(). A filter that still runs then throws a
// TypeError on the null part, exactly as the JavaScript controller did (`this.sender.hold` …).
const runnerOf = (controller: GrblController): GrblRunner => controller.runner!;
const senderOf = (controller: GrblController): Sender => controller.sender!;
const feederOf = (controller: GrblController): Feeder => controller.feeder!;
const workflowOf = (controller: GrblController): Workflow => controller.workflow!;
const messageSlotOf = (controller: GrblController): MessageSlot<string> => controller.messageSlot!;
const eventOf = (controller: GrblController): EventTrigger => controller.event!;

/** SerialConnection writeFilter: every write() goes through it before it reaches the port. */
export const createWriteFilter = (controller: GrblController): SerialConnectionWriteFilter => (data) => {
  const line = data.trim();

  // Kinetiq: homing lines and soft resets, for the homed state (TravelGuard)
  controller.travel.onWrite(line);

  if (!line) {
    return data;
  }

  { // Grbl settings: $0-$255
    const r = line.match(/^(\$\d{1,3})=([\d\.]+)$/);
    if (r) {
      const name = r[1];
      const value = Number(r[2]);
      if ((name === '$13') && (value >= 0) && (value <= 65535)) {
        const runner = runnerOf(controller);
        const nextSettings = {
          ...runner.settings,
          settings: {
            ...runner.settings.settings,
            [name]: value ? '1' : '0'
          }
        };
        runner.settings = nextSettings; // enforce change
      }
    }
  }

  return data;
};

/**
 * Adds the macro-language variables to `context` (mutating it: the Sender's load context gains
 * these keys, which is why they show up in `sender:status` and `gcode:load` payloads) and returns it.
 */
export const populateContext = <C extends FeederContext | SenderContext>(controller: GrblController, context: C): C => {
  const runner = runnerOf(controller);

  // Machine position
  const {
    x: mposx,
    y: mposy,
    z: mposz,
    a: mposa,
    b: mposb,
    c: mposc
  } = runner.getMachinePosition();

  // Work position
  const {
    x: posx,
    y: posy,
    z: posz,
    a: posa,
    b: posb,
    c: posc
  } = runner.getWorkPosition();

  // Modal group
  const modal = runner.getModalGroup();

  // Tool
  const tool = runner.getTool();

  // G-code parameters
  const parameters = runner.getParameters();

  return Object.assign(context || {}, {
    // User-defined global variables
    global: controller.sharedContext,

    // Bounding box
    xmin: Number(context.xmin) || 0,
    xmax: Number(context.xmax) || 0,
    ymin: Number(context.ymin) || 0,
    ymax: Number(context.ymax) || 0,
    zmin: Number(context.zmin) || 0,
    zmax: Number(context.zmax) || 0,

    // Machine position
    mposx: Number(mposx) || 0,
    mposy: Number(mposy) || 0,
    mposz: Number(mposz) || 0,
    mposa: Number(mposa) || 0,
    mposb: Number(mposb) || 0,
    mposc: Number(mposc) || 0,

    // Work position
    posx: Number(posx) || 0,
    posy: Number(posy) || 0,
    posz: Number(posz) || 0,
    posa: Number(posa) || 0,
    posb: Number(posb) || 0,
    posc: Number(posc) || 0,

    // Modal group
    modal: {
      motion: modal.motion,
      wcs: modal.wcs,
      plane: modal.plane,
      units: modal.units,
      distance: modal.distance,
      feedrate: modal.feedrate,
      program: modal.program,
      spindle: modal.spindle,
      // M7 and M8 may be active at the same time, but a modal group violation might occur when issuing M7 and M8 together on the same line. Using the new line character (\n) to separate lines can avoid this issue.
      coolant: ensureArray(modal.coolant).join('\n'),
    },

    // Tool
    tool: Number(tool) || 0,

    // G-code parameters
    params: parameters,

    // Global objects
    ...globalObjects,
  });
};

// `%wait [seconds]` → `G4 P<seconds>`. CNCjs wrote `delay.toFixed(3) * 1`; Number() of the same
// string gives the same value (0.5, not '0.500').
const dwellLine = (commandArgs: string): string => {
  const delay = parseFloat(commandArgs) || 0.5; // in seconds
  const pauseValue = Number(delay.toFixed(3));
  return `G4 P${pauseValue}`; // dwell
};

export const createFeederDataFilter = (controller: GrblController): FeederDataFilter => (line, context) => {
  const originalLine = line;
  line = line.trim();
  context = populateContext(controller, context);

  if (line[0] === '%') {
    // ensure-type `ensureArray(null)` is [], so both are undefined when no builtin matched; the
    // `''` default only applies then, and commandArgs is only read after a match.
    const [command, commandArgs = ''] = ensureArray(matchBuiltinCommand(line));

    // %msg
    if (command === BUILTIN_COMMAND_MSG) {
      log.debug(`${command}: line=${x(originalLine)}`);
      const msg = translateExpression(commandArgs, context);
      messageSlotOf(controller).put(msg);
      return '';
    }

    // %wait
    if (command === BUILTIN_COMMAND_WAIT) {
      log.debug(`${command}: line=${x(originalLine)}`);
      // CNCjs quirk (plan §3a bug 3, kept): a console `%wait` holds the Sender, not the Feeder.
      senderOf(controller).hold({
        data: BUILTIN_COMMAND_WAIT,
        msg: messageSlotOf(controller).take() ?? originalLine,
      });
      return dwellLine(commandArgs);
    }

    // Expression
    // %_x=posx,_y=posy,_z=posz
    const parts = line.split(/;(.*)/s); // `s` is the modifier for single-line mode
    // split() always returns at least one string (CNCjs: `ensureString(parts[0])`)
    const expr = parts[0].trim().slice(1);
    log.debug(`%: expr=${x(expr)}, line=${x(originalLine)}`);
    evaluateAssignmentExpression(expr, context);
    return '';
  }

  // Example: `G0 X[posx - 8] Y[ymax]` is converted to `G0 X2 Y50`
  line = translateExpression(line, context);

  const { line: strippedLine, words } = gcodeParser.parseLine(line, {
    flatten: true,
    lineMode: 'stripped',
  });
  line = strippedLine;

  // M0 Program Pause
  if (words.find(isM0)) {
    log.debug(`M0 Program Pause: line=${x(originalLine)}`);

    feederOf(controller).hold({
      data: 'M0',
      msg: messageSlotOf(controller).take() ?? originalLine,
    });
  }

  // M1 Program Pause
  if (words.find(isM1)) {
    log.debug(`M1 Program Pause: line=${x(originalLine)}`);

    feederOf(controller).hold({
      data: 'M1',
      msg: messageSlotOf(controller).take() ?? originalLine,
    });
  }

  // M6 Tool Change
  if (words.find(isM6)) {
    log.debug(`M6 Tool Change: line=${x(originalLine)}`);

    // Kinetiq: M6 is always a manual tool-change pause (CNCjs's default policy).
    // M6 is commented out so it never reaches the controller.
    line = replaceM6(line, (x) => `(${x})`); // replace with parentheses

    feederOf(controller).hold({
      data: 'M6',
      msg: messageSlotOf(controller).take() ?? originalLine,
    });
  }

  // Kinetiq: jogs stay inside the travel limits (shortened, or dropped: '' skips the line).
  if (line.startsWith('$')) {
    return controller.travel.filterJog(line) ?? '';
  }

  return line;
};

export const createSenderDataFilter = (controller: GrblController): SenderDataFilter => (line, context) => {
  const originalLine = line;
  const { sent, received } = senderOf(controller).state;
  line = line.trim();
  context = populateContext(controller, context);

  if (line[0] === '%') {
    // See createFeederDataFilter for the destructuring default.
    const [command, commandArgs = ''] = ensureArray(matchBuiltinCommand(line));

    // %msg
    if (command === BUILTIN_COMMAND_MSG) {
      log.debug(`${command}: line=${x(originalLine)}, sent=${sent}, received=${received}`);
      const msg = translateExpression(commandArgs, context);
      messageSlotOf(controller).put(msg);
      return '';
    }

    // %wait
    if (command === BUILTIN_COMMAND_WAIT) {
      log.debug(`${command}: line=${x(originalLine)}, sent=${sent}, received=${received}`);
      senderOf(controller).hold({
        data: BUILTIN_COMMAND_WAIT,
        msg: messageSlotOf(controller).take() ?? originalLine,
      });
      return dwellLine(commandArgs);
    }

    // Expression
    // %_x=posx,_y=posy,_z=posz
    const parts = line.split(/;(.*)/s); // `s` is the modifier for single-line mode
    // split() always returns at least one string (CNCjs: `ensureString(parts[0])`)
    const expr = parts[0].trim().slice(1);
    log.debug(`%: expr=${x(expr)}, line=${x(originalLine)}, sent=${sent}, received=${received}`);
    evaluateAssignmentExpression(expr, context);
    return '';
  }

  // Example: `G0 X[posx - 8] Y[ymax]` is converted to `G0 X2 Y50`
  line = translateExpression(line, context);

  const { line: strippedLine, words } = gcodeParser.parseLine(line, {
    flatten: true,
    lineMode: 'stripped',
  });
  line = strippedLine;

  // M0 Program Pause
  if (words.find(isM0)) {
    log.debug(`M0 Program Pause: line=${x(originalLine)}, sent=${sent}, received=${received}`);

    eventOf(controller).trigger('gcode:pause');
    workflowOf(controller).pause({
      data: 'M0',
      msg: messageSlotOf(controller).take() ?? originalLine,
    });
  }

  // M1 Program Pause
  if (words.find(isM1)) {
    log.debug(`M1 Program Pause: line=${x(originalLine)}, sent=${sent}, received=${received}`);

    eventOf(controller).trigger('gcode:pause');
    workflowOf(controller).pause({
      data: 'M1',
      msg: messageSlotOf(controller).take() ?? originalLine,
    });
  }

  // M6 Tool Change
  if (words.find(isM6)) {
    log.debug(`M6 Tool Change: line=${x(originalLine)}, sent=${sent}, received=${received}`);

    // Kinetiq: M6 is always a manual tool-change pause (CNCjs's default policy).
    // M6 is commented out so it never reaches the controller.
    line = replaceM6(line, (x) => `(${x})`); // replace with parentheses

    eventOf(controller).trigger('gcode:pause');
    workflowOf(controller).pause({
      data: 'M6',
      msg: messageSlotOf(controller).take() ?? originalLine,
    });
  }

  return line;
};
